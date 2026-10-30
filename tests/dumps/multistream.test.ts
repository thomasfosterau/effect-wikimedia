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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import unbzip2 from "unbzip2-stream";
import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { Dumps } from "../../src/index.ts";
import { expectFailureInstanceOf, runTest } from "../helpers/effect.ts";

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/dumps/${name}`, import.meta.url));

const DUMP_BZ2 = readFileSync(fixturePath("multistream.xml.bz2"));
const INDEX_BZ2 = fixturePath("multistream-index.txt.bz2");

const bytesOf = (text: string): Stream.Stream<Uint8Array, never> =>
  Stream.make(new TextEncoder().encode(text));

const collect = <A, E>(stream: Stream.Stream<A, E, never>): Promise<ReadonlyArray<A>> =>
  runTest(Stream.runCollect(stream));

/** What `stream` emits before it fails with a {@link Dumps.MultistreamIndexError}. */
const collectUntilIndexError = <A, E>(
  stream: Stream.Stream<A, E | Dumps.MultistreamIndexError, never>,
): Promise<ReadonlyArray<A>> =>
  collect(stream.pipe(Stream.catchTag("MultistreamIndexError", () => Stream.empty)));

/** The {@link Dumps.MultistreamIndexError} `stream` fails with. */
const indexErrorOf = <A, E>(
  stream: Stream.Stream<A, E, never>,
): Promise<Dumps.MultistreamIndexError> =>
  expectFailureInstanceOf(Stream.runDrain(stream), Dumps.MultistreamIndexError);

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
    expect(Dumps.decodeIndexLine(line, 1)).toEqual(Result.succeed(expected));
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
    expect(Dumps.decodeIndexLine(line, 1)).toEqual(Result.succeed(null));
  });

  it("bounds the detail of a malformed line to 500 code units", () => {
    const decoded = Dumps.decodeIndexLine("x".repeat(10_000), 3);
    expect(Result.isFailure(decoded) && decoded.failure.detail.length).toBe(500);
  });
});

// ── multistreamIndexRecords ──────────────────────────────────────────────

describe("multistreamIndexRecords", () => {
  it("decodes the bzip2-compressed fixture index through fromFile", async () => {
    const entries = await collect(
      Dumps.fromFile(INDEX_BZ2, { decompressor: () => unbzip2() }).pipe(
        Dumps.multistreamIndexRecords,
      ),
    );
    expect(entries).toEqual([
      entry(1, 236, 10, "Ada Lovelace"),
      entry(2, 236, 12, "AT&T"),
      entry(3, 533, 15, "Category:Writers"),
      entry(4, 533, 21, "Talk:Foo:Bar"),
      entry(5, 814, 30, "Zebra"),
    ]);
  });

  it("numbers every line, blank ones included, across \\r\\n and \\n", async () => {
    const entries = await collect(
      bytesOf("1:2:A\r\n\n3:4:B\n").pipe(Dumps.multistreamIndexRecords),
    );
    expect(entries).toEqual([entry(1, 1, 2, "A"), entry(3, 3, 4, "B")]);
  });

  it("fails with a malformed-index-line error after the entries before it", async () => {
    const stream = bytesOf("1:2:A\n\nbad line\n3:4:B\n").pipe(Dumps.multistreamIndexRecords);
    expect(await collectUntilIndexError(stream)).toEqual([entry(1, 1, 2, "A")]);
    expect(await indexErrorOf(stream)).toMatchObject({
      reason: "dumps/malformed-index-line",
      line: 3,
      detail: "bad line",
    });
  });

  it("numbers lines across chunks of lines", async () => {
    const stream = Stream.make(
      new TextEncoder().encode("1:2:A\n3:4:B\n"),
      new TextEncoder().encode("5:6:C\nbad\n"),
    ).pipe(Dumps.multistreamIndexRecords);
    expect((await collectUntilIndexError(stream)).map((e) => e.line)).toEqual([1, 2, 3]);
    expect((await indexErrorOf(stream)).line).toBe(4);
  });

  it("decodes a line split across chunks, mid-character", async () => {
    const bytes = new TextEncoder().encode("5:6:Café\n");
    const split = bytes.length - 2; // inside the two-byte "é"
    const entries = await collect(
      Stream.make(bytes.subarray(0, split), bytes.subarray(split)).pipe(
        Dumps.multistreamIndexRecords,
      ),
    );
    expect(entries).toEqual([entry(1, 5, 6, "Café")]);
  });
});

// ── multistreamRanges ────────────────────────────────────────────────────

const entriesOf = (text: string) => bytesOf(text).pipe(Dumps.multistreamIndexRecords);

describe("multistreamRanges", () => {
  const INDEX = "10:1:A\n10:2:B\n10:5:C\n40:7:D\n90:9:E\n90:11:F\n";

  it("groups entries by offset, each range ending where the next starts", async () => {
    expect(await collect(entriesOf(INDEX).pipe(Dumps.multistreamRanges()))).toEqual([
      { start: 10, end: 40, pageCount: 3, firstPageId: 1, lastPageId: 5 },
      { start: 40, end: 90, pageCount: 1, firstPageId: 7, lastPageId: 7 },
      { start: 90, end: null, pageCount: 2, firstPageId: 9, lastPageId: 11 },
    ]);
  });

  it("closes the last range at fileSize", async () => {
    const ranges = await collect(entriesOf(INDEX).pipe(Dumps.multistreamRanges({ fileSize: 120 })));
    expect(ranges.map((r) => [r.start, r.end])).toEqual([
      [10, 40],
      [40, 90],
      [90, 120],
    ]);
  });

  it("leaves the last end null for an explicit fileSize: undefined", async () => {
    const ranges = await collect(
      entriesOf(INDEX).pipe(Dumps.multistreamRanges({ fileSize: undefined })),
    );
    expect(ranges.map((r) => r.end)).toEqual([40, 90, null]);
  });

  it("emits nothing for an empty index", async () => {
    expect(await collect(entriesOf("").pipe(Dumps.multistreamRanges()))).toEqual([]);
  });

  it("fails at an offset below the one before it, after the ranges before it", async () => {
    const stream = entriesOf("10:1:A\n50:2:B\n50:3:C\n20:4:D\n90:5:E\n").pipe(
      Dumps.multistreamRanges(),
    );
    expect(await collectUntilIndexError(stream)).toEqual([
      { start: 10, end: 50, pageCount: 1, firstPageId: 1, lastPageId: 1 },
    ]);
    expect(await indexErrorOf(stream)).toMatchObject({
      reason: "dumps/index-offset-decreased",
      line: 4,
      detail: "offset 20 is below the previous offset 50",
    });
  });

  it("fails on a non-adjacent repeat of an earlier offset", async () => {
    const error = await indexErrorOf(
      entriesOf("10:1:A\n50:2:B\n10:3:C\n").pipe(Dumps.multistreamRanges()),
    );
    expect(error).toMatchObject({ reason: "dumps/index-offset-decreased", line: 3 });
  });

  it("fails at an offset at or past fileSize", async () => {
    const error = await indexErrorOf(
      entriesOf("10:1:A\n90:2:B\n").pipe(Dumps.multistreamRanges({ fileSize: 90 })),
    );
    expect(error).toMatchObject({
      reason: "dumps/index-offset-past-file-size",
      line: 2,
      detail: "offset 90 is at or past the file size 90",
    });
  });

  it("passes a malformed line's failure through", async () => {
    const error = await indexErrorOf(entriesOf("10:1:A\nbad\n").pipe(Dumps.multistreamRanges()));
    expect(error.reason).toBe("dumps/malformed-index-line");
  });
});

// ── End to end: one range decoded on its own ─────────────────────────────

/** Decompresses the fixture dump's bytes `[start, end)` alone and decodes them to page records. */
const pagesInRange = (
  range: Dumps.MultistreamRange,
): Promise<ReadonlyArray<Dumps.PageRevisionRecord>> =>
  collect(
    Stream.make(new Uint8Array(DUMP_BZ2.subarray(range.start, range.end ?? DUMP_BZ2.length))).pipe(
      Dumps.decompressWith(() => unbzip2()),
      Dumps.pageRecords,
    ),
  );

describe("a multistream range decoded on its own", () => {
  const indexEntries = (): Promise<ReadonlyArray<Dumps.MultistreamIndexEntry>> =>
    collect(
      Dumps.fromFile(INDEX_BZ2, { decompressor: () => unbzip2() }).pipe(
        Dumps.multistreamIndexRecords,
      ),
    );

  it.each([
    ["without fileSize", undefined, null],
    ["with fileSize", DUMP_BZ2.length, DUMP_BZ2.length],
  ])("yields exactly the pages the index lists for it (%s)", async (_label, fileSize, lastEnd) => {
    const entries = await indexEntries();
    const ranges = await collect(
      Stream.fromIterable(entries).pipe(Dumps.multistreamRanges({ fileSize })),
    );
    expect(ranges.map((r) => [r.start, r.end])).toEqual([
      [236, 533],
      [533, 814],
      [814, lastEnd],
    ]);
    const decoded = await Promise.all(ranges.map(pagesInRange));
    Arr.forEach(Arr.zip(ranges, decoded), ([range, records]) => {
      const listed = entries.filter((e) => e.offset === range.start);
      expect(records.every((r) => Predicate.isTagged(r, "revision"))).toBe(true);
      expect(records.map((r) => [r.page?.id, r.page?.title])).toEqual(
        listed.map((e) => [e.pageId, e.title]),
      );
    });
  });

  it("decodes the header stream at offset 0, which the index doesn't list, to no records", async () => {
    const [first] = await indexEntries();
    expect(first?.offset).toBeGreaterThan(0);
    expect(
      await pagesInRange({
        start: 0,
        end: first?.offset ?? 0,
        pageCount: 0,
        firstPageId: 0,
        lastPageId: 0,
      }),
    ).toEqual([]);
  });

  it("decodes the whole dump to the same pages as the ranges together", async () => {
    const whole = await collect(
      Stream.make(new Uint8Array(DUMP_BZ2)).pipe(
        Dumps.decompressWith(() => unbzip2()),
        Dumps.pageRecords,
      ),
    );
    expect(whole.map((r) => r.page?.title)).toEqual([
      "Ada Lovelace",
      "AT&T",
      "Category:Writers",
      "Talk:Foo:Bar",
      "Zebra",
    ]);
  });
});
