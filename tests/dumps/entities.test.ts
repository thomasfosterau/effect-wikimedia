/**
 * Unit tests for the entity JSON dump pipeline (`src/dumps/entities.ts`):
 * per-line framing / decode (table-driven, lenient degrade), the pure
 * predicates, and the full `Stream` pipeline over a gzipped truncated-dump
 * fixture — correct counts plus a **constant-memory** assertion (memory
 * retained after a full GC stays flat while streaming a dump larger than the
 * ceiling).
 *
 * @module tests/dumps/entities
 */

import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { createGzip, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Iterable from "effect/Iterable";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Dumps, Wikidata } from "../../src/index.ts";
import { runTest } from "../helpers/effect.ts";

const fixtureNdjson = readFileSync(
  fileURLToPath(new URL("../fixtures/dumps/entities-slice.ndjson", import.meta.url)),
);

const BIG_ITEM_COUNT = 300_000;

/** JSON text for a test label or an inline fixture, through the Schema JSON codec. */
const Json = Schema.fromJsonString(Schema.Unknown);
const toJson = Schema.encodeSync(Json);
const parseJson = Schema.decodeSync(Json);

/** Refines an entity-dump record to its per-line error member. */
const isLineError = (record: Dumps.EntityRecord | null): record is Dumps.DumpLineError =>
  Predicate.isTagged(record, "error");

let tmp: string;
let slicePath: string;
let bigPath: string;
let bigUncompressedBytes: number;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "dumps-entities-"));
  slicePath = join(tmp, "slice.json.gz");
  writeFileSync(slicePath, gzipSync(fixtureNdjson));
  // Generate the large dump here (not inside the timed test) so the
  // constant-memory assertion window covers only the streaming.
  bigPath = join(tmp, "big.json.gz");
  bigUncompressedBytes = await writeBigDump(bigPath, BIG_ITEM_COUNT);
}, 120_000);

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Collects a stream to an array under the test runtime. */
const collect = <A, E>(stream: Stream.Stream<A, E, never>): Promise<ReadonlyArray<A>> =>
  runTest(Stream.runCollect(stream));

/** Counts a stream under the test runtime. */
const count = <A, E>(stream: Stream.Stream<A, E, never>): Promise<number> =>
  runTest(Stream.runCount(stream));

// ── stripFraming (table-driven) ──────────────────────────────────────────

describe("stripFraming", () => {
  const cases: ReadonlyArray<readonly [string, string | null]> = [
    ["[", null],
    ["]", null],
    ["", null],
    ["   ", null],
    ['{"id":"Q1"},', '{"id":"Q1"}'],
    ['{"id":"Q1"}', '{"id":"Q1"}'],
    ['  {"id":"Q1"} , ', '{"id":"Q1"}'],
  ];
  Arr.forEach(cases, ([input, expected]) => {
    it(`${toJson(input)} → ${toJson(expected)}`, () => {
      expect(Dumps.stripFraming(input)).toBe(expected);
    });
  });
});

// ── decodeEntityLine (table-driven) ──────────────────────────────────────

describe("decodeEntityLine", () => {
  it("frames-only lines yield null", () => {
    expect(Dumps.decodeEntityLine("[", 1)).toBeNull();
    expect(Dumps.decodeEntityLine("]", 9)).toBeNull();
  });

  it("a valid entity line decodes to an entity record with its line number", () => {
    const record = Dumps.decodeEntityLine('{"type":"item","id":"Q1"},', 5);
    expect(record?._tag).toBe("entity");
    if (record?._tag !== "entity") return expect.unreachable("expected entity");
    expect(record.line).toBe(5);
    expect(record.item.id).toBe("Q1");
  });

  it("invalid JSON degrades to an invalid-json error element", () => {
    const record = Dumps.decodeEntityLine("{ not json },", 3);
    expect(record?._tag).toBe("error");
    if (!isLineError(record)) return expect.unreachable("expected error");
    expect(record.reason).toBe("dumps/invalid-json");
    expect(record.line).toBe(3);
  });

  it("valid JSON that is not an entity degrades to a not-an-entity error element", () => {
    const record = Dumps.decodeEntityLine('{"foo":"bar"},', 4);
    expect(record?._tag).toBe("error");
    if (!isLineError(record)) return expect.unreachable("expected error");
    expect(record.reason).toBe("dumps/not-an-entity");
  });

  // `null` is valid JSON, so it is not an invalid-json line: it parses, and
  // what it parses to is not an entity, the same as `42` or `"x"` (#116).
  Arr.forEach(["null", "42", '"x"', "[]"], (body) => {
    it(`a JSON ${body} line degrades to a not-an-entity error element`, () => {
      const record = Dumps.decodeEntityLine(`${body},`, 3);
      expect(record?._tag).toBe("error");
      if (!isLineError(record)) return expect.unreachable("expected error");
      expect(record.reason).toBe("dumps/not-an-entity");
      expect(record.raw).toBe(body);
    });
  });

  // Wikibase marks an entity that does not exist with `missing`; such an
  // object has a valid id but is still not an entity (#122).
  it("an object Wikibase flagged missing degrades to a not-an-entity error element", () => {
    const record = Dumps.decodeEntityLine('{"id":"Q42","missing":""},', 5);
    expect(record?._tag).toBe("error");
    if (!isLineError(record)) return expect.unreachable("expected error");
    expect(record.reason).toBe("dumps/not-an-entity");
    expect(record.raw).toBe('{"id":"Q42","missing":""}');
  });
});

// ── Pure predicates ──────────────────────────────────────────────────────

const q42 = Wikidata.decodeEntity(
  parseJson(
    '{"type":"item","id":"Q42","claims":{"P569":[{"mainsnak":{"snaktype":"value","property":"P569","datatype":"time","datavalue":{"type":"string","value":"x"}},"type":"statement","rank":"normal"}]},"sitelinks":{"enwiki":{"site":"enwiki","title":"Douglas Adams"}}}',
  ),
);

describe("predicates", () => {
  it("hasType", () => {
    expect(q42 && Dumps.hasType(q42, "item")).toBe(true);
    expect(q42 && Dumps.hasType(q42, "property")).toBe(false);
  });

  it("hasClaim (valid + missing + malformed property)", () => {
    if (q42 === null) return expect.unreachable("fixture decode failed");
    expect(Dumps.hasClaim(q42, "P569")).toBe(true);
    expect(Dumps.hasClaim(q42, "P31")).toBe(false);
    expect(Dumps.hasClaim(q42, "not-a-property")).toBe(false);
  });

  it("hasSitelink", () => {
    if (q42 === null) return expect.unreachable("fixture decode failed");
    expect(Dumps.hasSitelink(q42, "enwiki")).toBe(true);
    expect(Dumps.hasSitelink(q42, "dewiki")).toBe(false);
    // Inherited names are never sitelinks (#164).
    expect(Dumps.hasSitelink(q42, "toString")).toBe(false);
    expect(Dumps.hasSitelink(q42, "constructor")).toBe(false);
    expect(Dumps.hasSitelink(q42, "__proto__")).toBe(false);
  });
});

// ── The pipeline over the fixture ────────────────────────────────────────

describe("entityRecords pipeline", () => {
  it("keeps streaming past a line whose nested containers are the wrong kind (#147)", async () => {
    const lines = [
      "[",
      `${toJson({ type: "item", id: "Q1", claims: { P31: [null] } })},`,
      `${toJson({ type: "item", id: "Q2", sitelinks: { enwiki: null } })},`,
      toJson({ type: "item", id: "Q3" }),
      "]",
    ];
    const bytes = Stream.make(new TextEncoder().encode(lines.join("\n")));
    const records = await collect(Dumps.entityRecords(bytes));
    expect(records.filter(isLineError)).toEqual([]);
    const hits = records.filter((r): r is Dumps.EntityHit => !isLineError(r));
    expect(hits.map((r) => [r.line, r.item.id])).toEqual([
      [2, "Q1"],
      [3, "Q2"],
      [4, "Q3"],
    ]);
  });

  it("decodes the fixture: 5 entities + 2 error elements, in line order", async () => {
    const records = await collect(Dumps.entityRecords(Dumps.fromFile(slicePath)));
    const entities = records.filter(Predicate.isTagged("entity"));
    const errors = records.filter(isLineError);
    expect(entities.length).toBe(5);
    expect(errors.length).toBe(2);
    expect(errors.map((e) => e.reason)).toEqual(["dumps/invalid-json", "dumps/not-an-entity"]);
  });

  it("byType keeps only items (4)", async () => {
    const n = await count(
      Dumps.fromFile(slicePath).pipe(Dumps.entityRecords, Dumps.onlyEntities, Dumps.byType("item")),
    );
    expect(n).toBe(4);
  });

  it("withClaim P569 keeps the 2 items with a date-of-birth claim", async () => {
    const n = await count(
      Dumps.fromFile(slicePath).pipe(
        Dumps.entityRecords,
        Dumps.onlyEntities,
        Dumps.withClaim("P569"),
      ),
    );
    expect(n).toBe(2);
  });

  it("withSitelink enwiki keeps the 1 item with an enwiki sitelink", async () => {
    const n = await count(
      Dumps.fromFile(slicePath).pipe(
        Dumps.entityRecords,
        Dumps.onlyEntities,
        Dumps.withSitelink("enwiki"),
      ),
    );
    expect(n).toBe(1);
  });
});

// ── Constant-memory (heap ceiling) ───────────────────────────────────────

const BIG_ITEM_LINE =
  '{"type":"item","id":"Q42","claims":{"P569":[{"mainsnak":{"snaktype":"value","property":"P569","datatype":"time","datavalue":{"type":"string","value":"x"}},"type":"statement","rank":"normal"}]}}';

/**
 * Streams a gzipped entity dump of `n` item lines to `path` (generated line by
 * line so the *fixture build* never buffers the whole dump either). Returns the
 * uncompressed byte size.
 */
async function writeBigDump(path: string, n: number): Promise<number> {
  // Written in ~256 KB blocks (not per line) — keeps the fixture build fast
  // and low-memory, ~200x faster than yielding 300k tiny strings. Every line
  // but the last carries the array's trailing comma.
  const BLOCK_BYTES = 262_144;
  const linesPerBlock = Math.ceil(BLOCK_BYTES / (BIG_ITEM_LINE.length + 2));
  const blockCount = Math.ceil(n / linesPerBlock);
  let bytes = 0;
  const block = (index: number): string => {
    const lines = Math.min(linesPerBlock, n - index * linesPerBlock);
    const body =
      index === blockCount - 1
        ? `${BIG_ITEM_LINE},\n`.repeat(lines - 1) + `${BIG_ITEM_LINE}\n]\n`
        : `${BIG_ITEM_LINE},\n`.repeat(lines);
    const text = index === 0 ? `[\n${body}` : body;
    bytes += Buffer.byteLength(text);
    return text;
  };
  await pipeline(
    Readable.from(Iterable.makeBy(block, { length: blockCount })),
    createGzip(),
    createWriteStream(path),
  );
  return bytes;
}

/**
 * A full, synchronous garbage collection, for measuring *retained* memory.
 * The suite runs without `--expose-gc`, so this file turns the flag on,
 * fetches `gc` from a fresh context, which is created after the flag is set
 * and so has it as a global, and turns the flag off again (the technique
 * `jest-leak-detector` uses). No other file sees it.
 */
const collectGarbage = (() => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  // The captured `gc` keeps working with the flag off, and a context created
  // later (another file sharing this worker, under `isolate: false` or
  // threads) gets no `gc` global.
  setFlagsFromString("--no-expose-gc");
  return gc;
})();

/** Retained heap and off-heap bytes, as {@link retained} reads them. */
interface Retained {
  readonly heap: number;
  readonly offHeap: number;
}

/**
 * Heap and off-heap bytes still reachable after full collections. Two, because
 * some native memory is only released on the second: after one, `external`
 * still counts 10-17 MB left over from the gzip stream `beforeAll` wrote the
 * dump through, which the next collection frees. `external` includes
 * `arrayBuffers` (every `Buffer` and `Uint8Array`), so it alone is the
 * off-heap figure.
 */
function retained(): Retained {
  collectGarbage();
  collectGarbage();
  const m = process.memoryUsage();
  return { heap: m.heapUsed, offHeap: m.external };
}

/** How many streamed items pass between retained-memory samples. */
const SAMPLE_EVERY = 10_000;

describe("constant memory", () => {
  // `heapUsed` read without a collection counts garbage V8 hasn't collected
  // yet, so a peak of raw samples measures V8's GC heuristics (how far it has
  // grown the young generation, when its next full collection is due), not
  // the pipeline (#112). With a 64 MB semi-space the old raw-peak version of
  // this test read 43 MB while the pipeline retained under 1 MB. Instead,
  // sample memory retained after a full collection, from inside the stream,
  // every `SAMPLE_EVERY` items: whatever the pipeline holds at that point
  // (buffered lines, chunks, decoded items) is reachable, and nothing else
  // is counted.
  it("streams a dump larger than the heap ceiling without buffering it", async () => {
    // The ~300k-item dump (~57 MB uncompressed) was generated in beforeAll,
    // so only the streaming is measured here.
    expect(bigUncompressedBytes).toBeGreaterThan(45_000_000);

    const base = retained();
    const samples: Array<Retained> = [];
    let seen = 0;

    const n = await count(
      Dumps.fromFile(bigPath).pipe(
        Dumps.entityRecords,
        Dumps.onlyEntities,
        Dumps.withClaim("P569"),
        Stream.tap(() =>
          Effect.sync(() => {
            seen += 1;
            if (seen % SAMPLE_EVERY === 0) {
              const r = retained();
              samples.push({ heap: r.heap - base.heap, offHeap: r.offHeap - base.offHeap });
            }
          }),
        ),
      ),
    );

    expect(n).toBe(BIG_ITEM_COUNT);
    expect(samples).toHaveLength(BIG_ITEM_COUNT / SAMPLE_EVERY);
    const mb = (bytes: number) => bytes / 1_000_000;
    const peakHeapMb = mb(Math.max(...samples.map((s) => s.heap)));
    const peakOffHeapMb = mb(Math.max(...samples.map((s) => s.offHeap)));
    // Growth, on- and off-heap, from the first sample (pipeline warmed up,
    // 10k items in) to the last (the whole dump read): a pipeline that holds
    // one line at a time retains the same at both, while one that keeps
    // something per line grows with the number of lines read in between.
    const [first] = samples;
    const last = samples.at(-1);
    const growthMb =
      first && last ? mb(last.heap + last.offHeap - first.heap - first.offHeap) : Number.NaN;

    // Retained working set is one line at a time (observed: heap and off-heap
    // each under 1 MB, growth within about 0.1 MB, with or without coverage).
    // The 40 MB ceiling sits below the ~57 MB uncompressed dump, so a
    // regression that kept the file, on- or off-heap, would blow it; the growth
    // bound catches a leak too small to reach the ceiling. Observed growth is
    // about -0.1 to -0.02 MB (Node 20-26), so the 2 MB bound is ~20x the
    // largest drift, and still fails a pipeline that keeps one number per line
    // (~2.9 MB over the 290k lines between the first and last samples). (The
    // stronger proof, a 600 MB dump completing under a hard
    // `--max-old-space-size=250` cap, is documented in the PR, not run in CI,
    // to keep this suite fast.)
    expect(peakHeapMb).toBeLessThan(40);
    expect(peakOffHeapMb).toBeLessThan(40);
    expect(growthMb).toBeLessThan(2);
  }, 120_000);
});
