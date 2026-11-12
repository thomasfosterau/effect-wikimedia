/**
 * Unit tests for the multistream index pipeline (`src/dumps/multistream.ts`,
 * #211): the per-line decode (table-driven), the index stream over the
 * bzip2-compressed fixture and its strict failure on a malformed line,
 * grouping into per-stream byte ranges (with and without `fileSize`, and the
 * failure on an offset that goes backwards), and the end-to-end claim the
 * design rests on: each range's compressed bytes, sliced out of the
 * `.xml.bz2` and decompressed alone, decode through
 * {@link Dumps.pageRecords} to exactly the pages the index lists for it.
 *
 * The fixtures (`multistream.xml.bz2`, `multistream-index.txt.bz2`) are a
 * synthetic three-page-stream dump that `tests/fixtures/dumps/make-multistream.sh`
 * regenerates.
 *
 * @module tests/dumps/multistream
 */

import unbzip2 from "unbzip2-stream";
import { it, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assertInstanceOf } from "@effect/vitest/utils";
import { describe, expect } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { Dumps } from "../../src/index.ts";
import { fixturePath, readFixtureBytes } from "../helpers/fixtures.ts";

/** The multistream fixture: its dump bytes and path, its index stream, and range readers over them. */
const fixtureFiles = Effect.fn("fixtureFiles")(function* () {
  const dumpPath = yield* fixturePath("dumps/multistream.xml.bz2");
  const dumpBytes = yield* readFixtureBytes("dumps/multistream.xml.bz2");
  const indexPath = yield* fixturePath("dumps/multistream-index.txt.bz2");
  const indexEntryStream = (): Stream.Stream<
    Dumps.MultistreamIndexEntry,
    Dumps.SourceError | Dumps.MultistreamIndexError
  > =>
    Dumps.fromFile(indexPath, { decompressor: () => unbzip2() }).pipe(
      Dumps.multistreamIndexRecords,
    );
  const openRange = (range: Dumps.MultistreamRange) =>
    Dumps.fromMultistreamRange(dumpPath, range, () => unbzip2());
  /** Decompresses the fixture dump's bytes `[start, end)` alone and decodes them to page records. */
  const pagesInRange = (
    range: Dumps.MultistreamRange,
  ): Effect.Effect<ReadonlyArray<Dumps.PageRevisionRecord>, Dumps.SourceError> =>
    collect(
      Stream.make(
        new Uint8Array(
          dumpBytes.subarray(
            range.start,
            Option.getOrElse(range.end, () => dumpBytes.length),
          ),
        ),
      ).pipe(
        Dumps.decompressWith(() => unbzip2()),
        Dumps.pageRecords,
      ),
    );
  return { dumpBytes, indexEntryStream, openRange, pagesInRange };
});

const bytesOf = (text: string): Stream.Stream<Uint8Array> =>
  Stream.make(new TextEncoder().encode(text));

const collect = <A, E>(stream: Stream.Stream<A, E>): Effect.Effect<ReadonlyArray<A>, E> =>
  Stream.runCollect(stream);

/** What `stream` emits before it fails with a {@link Dumps.MultistreamIndexError}. */
const collectUntilIndexError = <A, E>(
  stream: Stream.Stream<A, E | Dumps.MultistreamIndexError>,
): Effect.Effect<ReadonlyArray<A>, E> =>
  collect(stream.pipe(Stream.catchTag("MultistreamIndexError", () => Stream.empty)));

/** The {@link Dumps.MultistreamIndexError} `stream` fails with. */
const indexErrorOf = <A, E>(
  stream: Stream.Stream<A, E>,
): Effect.Effect<Dumps.MultistreamIndexError, void> =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(Stream.runDrain(stream));
    assertInstanceOf(error, Dumps.MultistreamIndexError);
    return error;
  });

const entry = (line: number, offset: number, pageId: number, title: string) => ({
  line,
  offset,
  pageId,
  title,
});

// ── decodeIndexLine (table-driven) ───────────────────────────────────────

describe("decodeIndexLine", () => {
  it.each([
    ["616:10:AccessibleComputing", entry(1, 616, 10, "AccessibleComputing")],
    ["660945:1438:Category:Writers", entry(1, 660945, 1438, "Category:Writers")],
    ["7:8:Talk:Foo:Bar", entry(1, 7, 8, "Talk:Foo:Bar")],
    ["7:8:AT&amp;T", entry(1, 7, 8, "AT&T")],
    ["7:8:&quot;Quoted&quot; &#x41;", entry(1, 7, 8, '"Quoted" A')],
    ["7:8: Leading space kept", entry(1, 7, 8, " Leading space kept")],
    ["0:0:Zero", entry(1, 0, 0, "Zero")],
    ["0007:0008:Leading zeros", entry(1, 7, 8, "Leading zeros")],
  ])("%j decodes", (line, expected) => {
    expect(Dumps.decodeIndexLine(line, 1)).toEqual(Result.succeed(Option.some(expected)));
  });

  it.each([
    ["no colons"],
    ["616:AccessibleComputing"],
    ["616:10:"],
    ["-1:10:Negative"],
    ["6.5:10:Fraction"],
    ["616:x:Not a number"],
    [":10:Missing offset"],
    ["1234567890123456789:10:Nineteen digits"],
    ["999999999999999999:10:Past MAX_SAFE_INTEGER"],
  ])("%j is malformed", (line) => {
    const decoded = Dumps.decodeIndexLine(line, 4);
    expect(Result.isFailure(decoded)).toBe(true);
    if (!Result.isFailure(decoded)) return;
    expect(decoded.failure).toBeInstanceOf(Dumps.MultistreamIndexError);
    expect(decoded.failure).toMatchObject({
      reason: "dumps/malformed-index-line",
      line: 4,
      detail: line,
    });
  });

  it.each([[""], ["   "], ["\t"]])("%j is blank and decodes to null", (line) => {
    expect(Dumps.decodeIndexLine(line, 1)).toEqual(Result.succeed(Option.none()));
  });

  it("bounds the detail of a malformed line to 500 code units", () => {
    const decoded = Dumps.decodeIndexLine("x".repeat(10_000), 3);
    expect(Result.isFailure(decoded) && decoded.failure.detail.length).toBe(500);
  });
});

// ── multistreamIndexRecords ──────────────────────────────────────────────

layer(NodeServices.layer)("multistreamIndexRecords", (it) => {
  it.effect("decodes the bzip2-compressed fixture index through fromFile", () =>
    Effect.gen(function* () {
      const { indexEntryStream } = yield* fixtureFiles();
      const entries = yield* collect(indexEntryStream());
      expect(entries).toEqual([
        entry(1, 236, 10, "Ada Lovelace"),
        entry(2, 236, 12, "AT&T"),
        entry(3, 533, 15, "Category:Writers"),
        entry(4, 533, 21, "Talk:Foo:Bar"),
        entry(5, 814, 30, "Zebra"),
      ]);
    }),
  );

  it.effect("numbers every line, blank ones included, across \\r\\n and \\n", () =>
    Effect.gen(function* () {
      const entries = yield* collect(
        bytesOf("1:2:A\r\n\n3:4:B\n").pipe(Dumps.multistreamIndexRecords),
      );
      expect(entries).toEqual([entry(1, 1, 2, "A"), entry(3, 3, 4, "B")]);
    }),
  );

  it.effect("fails with a malformed-index-line error after the entries before it", () =>
    Effect.gen(function* () {
      const stream = bytesOf("1:2:A\n\nbad line\n3:4:B\n").pipe(Dumps.multistreamIndexRecords);
      expect(yield* collectUntilIndexError(stream)).toEqual([entry(1, 1, 2, "A")]);
      expect(yield* indexErrorOf(stream)).toMatchObject({
        reason: "dumps/malformed-index-line",
        line: 3,
        detail: "bad line",
      });
    }),
  );

  it.effect("numbers lines across chunks of lines", () =>
    Effect.gen(function* () {
      const stream = Stream.make(
        new TextEncoder().encode("1:2:A\n3:4:B\n"),
        new TextEncoder().encode("5:6:C\nbad\n"),
      ).pipe(Dumps.multistreamIndexRecords);
      expect((yield* collectUntilIndexError(stream)).map((e) => e.line)).toEqual([1, 2, 3]);
      expect((yield* indexErrorOf(stream)).line).toBe(4);
    }),
  );

  it.effect("decodes a line split across chunks, mid-character", () =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode("5:6:Café\n");
      const split = bytes.length - 2; // inside the two-byte "é"
      const entries = yield* collect(
        Stream.make(bytes.subarray(0, split), bytes.subarray(split)).pipe(
          Dumps.multistreamIndexRecords,
        ),
      );
      expect(entries).toEqual([entry(1, 5, 6, "Café")]);
    }),
  );
});

// ── multistreamRanges ────────────────────────────────────────────────────

const entriesOf = (text: string) => bytesOf(text).pipe(Dumps.multistreamIndexRecords);

describe("multistreamRanges", () => {
  const INDEX = "10:1:A\n10:2:B\n10:5:C\n40:7:D\n90:9:E\n90:11:F\n";

  it.effect("groups entries by offset, each range ending where the next starts", () =>
    Effect.gen(function* () {
      expect(yield* collect(entriesOf(INDEX).pipe(Dumps.multistreamRanges()))).toEqual([
        { start: 10, end: Option.some(40), pageCount: 3, firstPageId: 1, lastPageId: 5 },
        { start: 40, end: Option.some(90), pageCount: 1, firstPageId: 7, lastPageId: 7 },
        { start: 90, end: Option.none(), pageCount: 2, firstPageId: 9, lastPageId: 11 },
      ]);
    }),
  );

  it.effect("closes the last range at fileSize", () =>
    Effect.gen(function* () {
      const ranges = yield* collect(
        entriesOf(INDEX).pipe(Dumps.multistreamRanges({ fileSize: 120 })),
      );
      expect(ranges.map((r) => [r.start, Option.getOrNull(r.end)])).toEqual([
        [10, 40],
        [40, 90],
        [90, 120],
      ]);
    }),
  );

  it.effect("leaves the last end None for an options object without fileSize", () =>
    Effect.gen(function* () {
      const ranges = yield* collect(entriesOf(INDEX).pipe(Dumps.multistreamRanges({})));
      expect(ranges.map((r) => Option.getOrNull(r.end))).toEqual([40, 90, null]);
    }),
  );

  it.effect("emits nothing for an empty index", () =>
    Effect.gen(function* () {
      expect(yield* collect(entriesOf("").pipe(Dumps.multistreamRanges()))).toEqual([]);
    }),
  );

  it.effect("fails at an offset below the one before it, after the ranges before it", () =>
    Effect.gen(function* () {
      const stream = entriesOf("10:1:A\n50:2:B\n50:3:C\n20:4:D\n90:5:E\n").pipe(
        Dumps.multistreamRanges(),
      );
      expect(yield* collectUntilIndexError(stream)).toEqual([
        { start: 10, end: Option.some(50), pageCount: 1, firstPageId: 1, lastPageId: 1 },
      ]);
      expect(yield* indexErrorOf(stream)).toMatchObject({
        reason: "dumps/index-offset-decreased",
        line: 4,
        detail: "offset 20 is below the previous offset 50",
      });
    }),
  );

  it.effect("fails on a non-adjacent repeat of an earlier offset", () =>
    Effect.gen(function* () {
      const error = yield* indexErrorOf(
        entriesOf("10:1:A\n50:2:B\n10:3:C\n").pipe(Dumps.multistreamRanges()),
      );
      expect(error).toMatchObject({ reason: "dumps/index-offset-decreased", line: 3 });
    }),
  );

  it.effect("fails at an offset at or past fileSize", () =>
    Effect.gen(function* () {
      const error = yield* indexErrorOf(
        entriesOf("10:1:A\n90:2:B\n").pipe(Dumps.multistreamRanges({ fileSize: 90 })),
      );
      expect(error).toMatchObject({
        reason: "dumps/index-offset-past-file-size",
        line: 2,
        detail: "offset 90 is at or past the file size 90",
      });
    }),
  );

  it.effect("passes a malformed line's failure through", () =>
    Effect.gen(function* () {
      const error = yield* indexErrorOf(entriesOf("10:1:A\nbad\n").pipe(Dumps.multistreamRanges()));
      expect(error.reason).toBe("dumps/malformed-index-line");
    }),
  );
});

// ── End to end: one range decoded on its own ─────────────────────────────

layer(NodeServices.layer)("a multistream range decoded on its own", (it) => {
  it.effect.each([
    { label: "without fileSize", sized: false },
    { label: "with fileSize", sized: true },
  ])("yields exactly the pages the index lists for it ($label)", ({ sized }) =>
    Effect.gen(function* () {
      const { dumpBytes, indexEntryStream, pagesInRange } = yield* fixtureFiles();
      const fileSize = sized ? Option.some(dumpBytes.length) : Option.none<number>();
      const lastEnd = sized ? dumpBytes.length : null;
      const entries = yield* collect(indexEntryStream());
      const ranges = yield* collect(
        Stream.fromIterable(entries).pipe(
          Dumps.multistreamRanges(Option.isSome(fileSize) ? { fileSize: fileSize.value } : {}),
        ),
      );
      expect(ranges.map((r) => [r.start, Option.getOrNull(r.end)])).toEqual([
        [236, 533],
        [533, 814],
        [814, lastEnd],
      ]);
      const decoded = yield* Effect.forEach(ranges, pagesInRange, { concurrency: "unbounded" });
      Arr.forEach(Arr.zip(ranges, decoded), ([range, records]) => {
        const listed = entries.filter((e) => e.offset === range.start);
        expect(records.every((r) => P.isTagged(r, "revision"))).toBe(true);
        expect(
          records.map((r) => [Option.getOrNull(r.page.id), Option.getOrNull(r.page.title)]),
        ).toEqual(listed.map((e) => [e.pageId, e.title]));
      });
    }),
  );

  it.effect(
    "decodes the header stream at offset 0, which the index doesn't list, to no records",
    () =>
      Effect.gen(function* () {
        const { indexEntryStream, pagesInRange } = yield* fixtureFiles();
        const [first] = yield* collect(indexEntryStream());
        expect(first?.offset).toBeGreaterThan(0);
        expect(
          yield* pagesInRange({
            start: 0,
            end: Option.some(first?.offset ?? 0),
            pageCount: 0,
            firstPageId: 0,
            lastPageId: 0,
          }),
        ).toEqual([]);
      }),
  );

  it.effect("decodes the whole dump to the same pages as the ranges together", () =>
    Effect.gen(function* () {
      const { dumpBytes } = yield* fixtureFiles();
      const whole = yield* collect(
        Stream.make(new Uint8Array(dumpBytes)).pipe(
          Dumps.decompressWith(() => unbzip2()),
          Dumps.pageRecords,
        ),
      );
      expect(whole.map((r) => Option.getOrNull(r.page.title))).toEqual([
        "Ada Lovelace",
        "AT&T",
        "Category:Writers",
        "Talk:Foo:Bar",
        "Zebra",
      ]);
    }),
  );
});

// ── fromMultistreamRange: one range read straight from the file ──────────

layer(NodeServices.layer)("fromMultistreamRange", (it) => {
  it.effect("reads each range of the dump file to the same pages as its sliced bytes", () =>
    Effect.gen(function* () {
      const { indexEntryStream, openRange, pagesInRange } = yield* fixtureFiles();
      const entries = yield* collect(indexEntryStream());
      const ranges = yield* collect(Stream.fromIterable(entries).pipe(Dumps.multistreamRanges()));
      expect(ranges).toHaveLength(3);
      const fromFile = yield* Effect.forEach(
        ranges,
        (range) => collect(openRange(range).pipe(Dumps.pageRecords)),
        { concurrency: "unbounded" },
      );
      expect(fromFile).toEqual(
        yield* Effect.forEach(ranges, pagesInRange, { concurrency: "unbounded" }),
      );
      expect(fromFile.flat().map((r) => Option.getOrNull(r.page.title))).toEqual([
        "Ada Lovelace",
        "AT&T",
        "Category:Writers",
        "Talk:Foo:Bar",
        "Zebra",
      ]);
    }),
  );
});

// ── Random access, iteration and resume ──────────────────────────────────

/** The titles of `records`, null for a page without one. */
const titles = (records: ReadonlyArray<Dumps.PageRevisionRecord>) =>
  records.map((r) => Option.getOrNull(r.page.title));

layer(NodeServices.layer)("random access and iteration over the fixture dump", (it) => {
  it.effect("finds the whole range holding a page by title, then reads just that range", () =>
    Effect.gen(function* () {
      const { indexEntryStream, openRange } = yield* fixtureFiles();
      const found = yield* indexEntryStream().pipe(
        Dumps.findMultistreamRange(Dumps.byTitle("Category:Writers")),
      );
      expect(Option.isSome(found)).toBe(true);
      if (Option.isNone(found)) return;
      expect(found.value).toMatchObject({ start: 533, end: Option.some(814) });
      const records = yield* collect(openRange(found.value).pipe(Dumps.pageRecords));
      expect(titles(records)).toContain("Category:Writers");
    }),
  );

  it.effect(
    "finds by page id, closes the last range with fileSize, and gives None for a miss",
    () =>
      Effect.gen(function* () {
        const { dumpBytes, indexEntryStream } = yield* fixtureFiles();
        const all = yield* collect(indexEntryStream());
        const lastId = all.at(-1)?.pageId ?? -1;
        const last = yield* indexEntryStream().pipe(
          Dumps.findMultistreamRange(Dumps.byPageId(lastId), { fileSize: dumpBytes.length }),
        );
        expect(Option.map(last, (range) => [range.start, Option.getOrNull(range.end)])).toEqual(
          Option.some([814, dumpBytes.length]),
        );
        expect(
          yield* indexEntryStream().pipe(Dumps.findMultistreamRange(Dumps.byTitle("Nope"))),
        ).toEqual(Option.none());
      }),
  );

  it.effect("counts every entry of the matched range, ones before the match included", () =>
    Effect.gen(function* () {
      const { indexEntryStream } = yield* fixtureFiles();
      const first = yield* indexEntryStream().pipe(Dumps.findMultistreamRange(() => true));
      const ranges = yield* collect(indexEntryStream().pipe(Dumps.multistreamRanges()));
      const byLaterEntry = yield* indexEntryStream().pipe(
        Dumps.findMultistreamRange(Dumps.byPageId(ranges[0]?.lastPageId ?? -1)),
      );
      expect(byLaterEntry).toEqual(first);
      expect(first).toEqual(Option.fromNullOr(ranges[0]));
    }),
  );

  it.effect("fails with the index's error when it rejects the index before a match", () =>
    Effect.gen(function* () {
      const stream = bytesOf("10:1:A\n5:2:B\n").pipe(Dumps.multistreamIndexRecords);
      const error = yield* Effect.flip(stream.pipe(Dumps.findMultistreamRange(Dumps.byTitle("B"))));
      assertInstanceOf(error, Dumps.MultistreamIndexError);
      expect(error.reason).toBe("dumps/index-offset-decreased");
    }),
  );

  it.effect("decodes every range's pages in order, sequentially and concurrently", () =>
    Effect.gen(function* () {
      const { indexEntryStream, openRange } = yield* fixtureFiles();
      const ranges = indexEntryStream().pipe(Dumps.multistreamRanges());
      const sequential = yield* collect(ranges.pipe(Dumps.multistreamPageRecords(openRange)));
      expect(titles(sequential)).toEqual([
        "Ada Lovelace",
        "AT&T",
        "Category:Writers",
        "Talk:Foo:Bar",
        "Zebra",
      ]);
      const concurrent = yield* collect(
        ranges.pipe(Dumps.multistreamPageRecords(openRange, { concurrency: 3 })),
      );
      expect(titles(concurrent)).toHaveLength(titles(sequential).length);
      expect(titles(concurrent)).toEqual(expect.arrayContaining(titles(sequential)));
    }),
  );

  it.effect("resumes from a checkpoint without opening the ranges before it", () =>
    Effect.gen(function* () {
      const { indexEntryStream, openRange } = yield* fixtureFiles();
      const opened: number[] = [];
      const records = yield* collect(
        indexEntryStream().pipe(
          Dumps.multistreamRanges(),
          Dumps.fromCheckpoint(533),
          Dumps.multistreamPageRecords((range) => {
            opened.push(range.start);
            return openRange(range);
          }),
        ),
      );
      expect(opened).toEqual([533, 814]);
      expect(titles(records)).not.toContain("Ada Lovelace");
      expect(titles(records)).toContain("Zebra");
    }),
  );
});
