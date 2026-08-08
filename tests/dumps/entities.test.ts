/**
 * Unit tests for the entity JSON dump pipeline (`src/dumps/entities.ts`):
 * per-line framing / decode (table-driven, lenient degrade), the pure
 * predicates, and the full `Stream` pipeline over a gzipped truncated-dump
 * fixture — correct counts plus a **constant-memory** assertion (peak heap
 * delta stays flat while streaming a dump many times the ceiling).
 *
 * @module tests/dumps/entities
 */

import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import * as Stream from "effect/Stream";
import { Dumps, Wikidata } from "../../src/index.ts";
import { runTest } from "../helpers/effect.ts";

const fixtureNdjson = readFileSync(
  fileURLToPath(new URL("../fixtures/dumps/entities-slice.ndjson", import.meta.url)),
);

const BIG_ITEM_COUNT = 300_000;

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
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(Dumps.stripFraming(input)).toBe(expected);
    });
  }
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
    if (record?._tag !== "entity") throw new Error("expected entity");
    expect(record.line).toBe(5);
    expect(record.item.id).toBe("Q1");
  });

  it("invalid JSON degrades to an invalid-json error element", () => {
    const record = Dumps.decodeEntityLine("{ not json },", 3);
    expect(record?._tag).toBe("error");
    if (record?._tag !== "error") throw new Error("expected error");
    expect(record.reason).toBe("dumps/invalid-json");
    expect(record.line).toBe(3);
  });

  it("valid JSON that is not an entity degrades to a not-an-entity error element", () => {
    const record = Dumps.decodeEntityLine('{"foo":"bar"},', 4);
    expect(record?._tag).toBe("error");
    if (record?._tag !== "error") throw new Error("expected error");
    expect(record.reason).toBe("dumps/not-an-entity");
  });
});

// ── Pure predicates ──────────────────────────────────────────────────────

const q42 = Wikidata.decodeEntity(
  JSON.parse(
    '{"type":"item","id":"Q42","claims":{"P569":[{"mainsnak":{"snaktype":"value","property":"P569","datatype":"time","datavalue":{"type":"string","value":"x"}},"type":"statement","rank":"normal"}]},"sitelinks":{"enwiki":{"site":"enwiki","title":"Douglas Adams"}}}',
  ) as unknown,
);

describe("predicates", () => {
  it("hasType", () => {
    expect(q42 && Dumps.hasType(q42, "item")).toBe(true);
    expect(q42 && Dumps.hasType(q42, "property")).toBe(false);
  });

  it("hasClaim (valid + missing + malformed property)", () => {
    if (q42 === null) throw new Error("fixture decode failed");
    expect(Dumps.hasClaim(q42, "P569")).toBe(true);
    expect(Dumps.hasClaim(q42, "P31")).toBe(false);
    expect(Dumps.hasClaim(q42, "not-a-property")).toBe(false);
  });

  it("hasSitelink", () => {
    if (q42 === null) throw new Error("fixture decode failed");
    expect(Dumps.hasSitelink(q42, "enwiki")).toBe(true);
    expect(Dumps.hasSitelink(q42, "dewiki")).toBe(false);
  });
});

// ── The pipeline over the fixture ────────────────────────────────────────

describe("entityRecords pipeline", () => {
  it("decodes the fixture: 5 entities + 2 error elements, in line order", async () => {
    const records = await collect(Dumps.entityRecords(Dumps.fromFile(slicePath)));
    const entities = records.filter((r) => r._tag === "entity");
    const errors = records.filter((r) => r._tag === "error");
    expect(entities.length).toBe(5);
    expect(errors.length).toBe(2);
    expect(errors.map((e) => (e._tag === "error" ? e.reason : ""))).toEqual([
      "dumps/invalid-json",
      "dumps/not-an-entity",
    ]);
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
  const BLOCK_BYTES = 262_144;
  let bytes = 0;
  function* blocks(): Generator<string> {
    let buffer = "[\n";
    for (let i = 0; i < n; i++) {
      buffer += BIG_ITEM_LINE + (i < n - 1 ? ",\n" : "\n");
      // Yield in ~256 KB blocks (not per line) — keeps the fixture build fast
      // and low-memory, ~200x faster than yielding 300k tiny strings.
      if (buffer.length >= BLOCK_BYTES) {
        bytes += Buffer.byteLength(buffer);
        yield buffer;
        buffer = "";
      }
    }
    buffer += "]\n";
    bytes += Buffer.byteLength(buffer);
    yield buffer;
  }
  await pipeline(Readable.from(blocks()), createGzip(), createWriteStream(path));
  return bytes;
}

describe("constant memory", () => {
  it("streams a dump larger than the heap ceiling without buffering it", async () => {
    // The ~300k-item dump (~57 MB uncompressed) was generated in beforeAll,
    // so only the streaming is timed here.
    expect(bigUncompressedBytes).toBeGreaterThan(45_000_000);

    const base = process.memoryUsage();
    let peakHeap = 0;
    let peakOffHeap = 0;
    const sampler = setInterval(() => {
      const m = process.memoryUsage();
      peakHeap = Math.max(peakHeap, m.heapUsed - base.heapUsed);
      // Off-heap too, so a regression that buffered the dump into `Buffer`s /
      // ArrayBuffers (invisible to `heapUsed`) is caught as well.
      peakOffHeap = Math.max(
        peakOffHeap,
        m.external - base.external,
        m.arrayBuffers - base.arrayBuffers,
      );
    }, 3);

    const n = await count(
      Dumps.fromFile(bigPath).pipe(
        Dumps.entityRecords,
        Dumps.onlyEntities,
        Dumps.withClaim("P569"),
      ),
    );
    clearInterval(sampler);

    expect(n).toBe(BIG_ITEM_COUNT);
    const peakHeapMb = peakHeap / 1_000_000;
    const peakOffHeapMb = peakOffHeap / 1_000_000;
    // Working set is one line at a time (observed heap ~10 MB, off-heap <1 MB,
    // both flat across dump sizes). The 40 MB ceiling sits below the ~57 MB
    // uncompressed dump, so a regression that buffered the file — on- or
    // off-heap — would blow it, while the true constant-memory pipeline clears
    // it with headroom for slow-GC CI runners. (The stronger proof — a 600 MB
    // dump completing under a hard `--max-old-space-size=250` cap — is
    // documented in the PR, not run in CI, to keep this suite fast.)
    expect(peakHeapMb).toBeLessThan(40);
    expect(peakOffHeapMb).toBeLessThan(40);
  }, 120_000);
});
