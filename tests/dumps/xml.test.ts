/**
 * Unit tests for the XML pages dump pipeline (`src/dumps/xml.ts`): the pure
 * scanner primitives (table-driven), chunk-boundary safety of
 * {@link XmlPageReader}, and the full `Stream` pipeline over a fixture —
 * page/revision metadata round-trips and a malformed revision degrades per
 * record.
 *
 * @module tests/dumps/xml
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import * as Stream from "effect/Stream";
import { Dumps } from "../../src/index.ts";
import { runTest } from "../helpers/effect.ts";

const fixtureXml = readFileSync(
  fileURLToPath(new URL("../fixtures/dumps/pages-slice.xml", import.meta.url)),
);

const bytesOf = (text: string): Stream.Stream<Uint8Array, never> =>
  Stream.make(new TextEncoder().encode(text));

const collect = <A, E>(stream: Stream.Stream<A, E, never>): Promise<ReadonlyArray<A>> =>
  runTest(Stream.runCollect(stream));

// ── tagName (table-driven) ───────────────────────────────────────────────

describe("tagName", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["revision", "revision"],
    ['text xml:space="preserve"', "text"],
    ["ns ", "ns"],
    ["PAGE", "page"],
    ["minor/", "minor"],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => {
      expect(Dumps.tagName(input)).toBe(expected);
    });
  }
});

// ── classifyTag (table-driven) ───────────────────────────────────────────

describe("classifyTag", () => {
  const cases: ReadonlyArray<readonly [string, ReadonlyArray<Dumps.XmlToken>]> = [
    ["<page>", [{ t: "open", name: "page" }]],
    ["</page>", [{ t: "close", name: "page" }]],
    [
      "<minor />",
      [
        { t: "open", name: "minor" },
        { t: "close", name: "minor" },
      ],
    ],
    ["<!-- a comment -->", []],
    ["<?xml version='1.0'?>", []],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)}`, () => {
      expect(Dumps.classifyTag(input)).toEqual(expected);
    });
  }
});

// ── decodeXmlEntities (table-driven) ─────────────────────────────────────

describe("decodeXmlEntities", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["plain text", "plain text"],
    ["1 &lt; 2 &amp; 3 &gt; 2", "1 < 2 & 3 > 2"],
    ["&quot;q&quot; &apos;a&apos;", "\"q\" 'a'"],
    ["&#65;&#x42;", "AB"],
    ["&notanentity;", "&notanentity;"],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(Dumps.decodeXmlEntities(input)).toBe(expected);
    });
  }

  it("decodes each of XML's five predefined entities", () => {
    expect(Dumps.decodeXmlEntities("&amp;&lt;&gt;&quot;&apos;")).toBe("&<>\"'");
  });

  // The lookup is own-key only: an `Object.prototype` name is a well-formed
  // entity, and an object-literal table "found" it as a built-in function.
  for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
    it(`keeps &${name}; as written`, () => {
      expect(Dumps.decodeXmlEntities(`a &${name}; b`)).toBe(`a &${name}; b`);
    });
  }

  it("keeps a name outside XML's five as written, even an HTML one", () => {
    expect(Dumps.decodeXmlEntities("&nbsp;&AMP;&Lt;")).toBe("&nbsp;&AMP;&Lt;");
  });

  // XML 1.0 `Char`: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF].
  const valid: ReadonlyArray<readonly [string, string]> = [
    ["&#9;", "\t"],
    ["&#xA;", "\n"],
    ["&#xD;", "\r"],
    ["&#x20;", " "],
    ["&#xD7FF;", "퟿"],
    ["&#xE000;", ""],
    ["&#xFFFD;", "�"],
    ["&#x10000;", "\u{10000}"],
    ["&#x10FFFF;", "\u{10FFFF}"],
    ["&#0065;", "A"],
    ["&#X41;", "A"],
  ];
  for (const [input, expected] of valid) {
    it(`decodes ${input}, a code point XML allows`, () => {
      expect(Dumps.decodeXmlEntities(input)).toBe(expected);
    });
  }

  const invalid: ReadonlyArray<string> = [
    "&#0;",
    "&#1;",
    "&#x8;",
    "&#xB;",
    "&#xC;",
    "&#xE;",
    "&#x1F;",
    "&#xD800;",
    "&#xDFFF;",
    "&#55357;&#56832;",
    "&#xFFFE;",
    "&#xFFFF;",
    "&#x110000;",
    `&#x${"F".repeat(300)};`,
    `&#${"9".repeat(400)};`,
  ];
  for (const input of invalid) {
    it(`keeps ${input.length > 24 ? `${input.slice(0, 20)}…` : input} as written, a code point XML forbids`, () => {
      expect(Dumps.decodeXmlEntities(`a${input}b`)).toBe(`a${input}b`);
    });
  }

  // Only a whole decimal or hex reference decodes; the leading digits of a
  // malformed one never do.
  for (const input of ["&#65a;", "&#9f;", "&#12.5;", "&#x41g;", "&#x;", "&#;", "&#-65;"]) {
    it(`keeps the malformed reference ${input} as written`, () => {
      expect(Dumps.decodeXmlEntities(input)).toBe(input);
    });
  }
});

// ── tokenizeXml carry (chunk-boundary safety) ────────────────────────────

describe("tokenizeXml", () => {
  it("carries a partial trailing tag into rest", () => {
    const { tokens, rest } = Dumps.tokenizeXml("<page><title>Hi</tit");
    expect(tokens).toEqual([
      { t: "open", name: "page" },
      { t: "open", name: "title" },
      { t: "text", value: "Hi" },
    ]);
    expect(rest).toBe("</tit");
  });

  it("emits trailing text (no tag yet) rather than carrying it — bounds the carry", () => {
    const { tokens, rest } = Dumps.tokenizeXml("<id>123");
    expect(tokens).toEqual([
      { t: "open", name: "id" },
      { t: "text", value: "123" },
    ]);
    // Nothing is carried: a huge <text> can't accumulate in `rest` across chunks
    // (entity decoding runs on the assembler's concatenated buffer, so splitting
    // a text run — even mid-entity — reassembles identically).
    expect(rest).toBe("");
  });
});

// ── The pipeline over the fixture ────────────────────────────────────────

describe("pageRecords pipeline", () => {
  it("round-trips page/revision metadata and degrades the malformed revision", async () => {
    const records = await collect(Dumps.pageRecords(bytesOf(fixtureXml.toString("utf8"))));
    expect(records.length).toBe(3);

    const hits = records.filter((r) => r._tag === "revision");
    const errors = records.filter((r) => r._tag === "error");
    expect(hits.length).toBe(2);
    expect(errors.length).toBe(1);

    const first = hits[0];
    if (first?._tag !== "revision") throw new Error("expected revision");
    expect(first.page).toEqual({ title: "Douglas Adams", ns: 0, id: 8091 });
    expect(first.revision.id).toBe(100);
    expect(first.revision.minor).toBe(true);
    expect(first.revision.comment).toBe("first version");
    expect(first.revision.contributor).toEqual({ username: "AxelBoldt", id: 2, ip: null });
    expect(first.revision.text).toBe("'''Douglas Adams''' < check 1 & 2 > 0");

    const second = hits[1];
    if (second?._tag !== "revision") throw new Error("expected revision");
    expect(second.revision.id).toBe(101);
    expect(second.revision.parentId).toBe(100);
    expect(second.revision.contributor).toEqual({ username: null, id: null, ip: "10.0.0.1" });
    expect(second.revision.minor).toBe(false);

    const error = errors[0];
    if (error?._tag !== "error") throw new Error("expected error");
    expect(error.reason).toBe("dumps/malformed-revision");
    expect(error.page).toEqual({ title: "Category:Writers", ns: 14, id: 200 });
  });

  const perByte = (text: string): Stream.Stream<Uint8Array, never> => {
    const encoded = new TextEncoder().encode(text);
    // One UTF-8 *byte* per chunk — the worst case for tag / entity straddling
    // and for multibyte code points split mid-sequence.
    return Stream.fromIterable([...encoded].map((b) => Uint8Array.of(b)));
  };

  it("is chunk-boundary safe: byte-by-byte input yields the same records", async () => {
    const text = fixtureXml.toString("utf8");
    const whole = await collect(Dumps.pageRecords(bytesOf(text)));
    const chunked = await collect(Dumps.pageRecords(perByte(text)));
    expect(chunked).toEqual(whole);
  });

  it("is multibyte-safe: a title / text with multibyte code points survives a per-byte split", async () => {
    const xml =
      "<mediawiki><page><title>Café 日本語</title><ns>0</ns><id>5</id>" +
      "<revision><id>3</id><timestamp>t</timestamp><text>é 漢 &amp; ok</text></revision></page></mediawiki>";
    const whole = await collect(Dumps.pageRecords(bytesOf(xml)));
    const chunked = await collect(Dumps.pageRecords(perByte(xml)));
    expect(chunked).toEqual(whole);
    const hit = whole[0];
    if (hit?._tag !== "revision") throw new Error("expected revision");
    expect(hit.page.title).toBe("Café 日本語");
    expect(hit.revision.text).toBe("é 漢 & ok");
  });

  it("incrementalRecords decodes the same schema", async () => {
    const records = await collect(Dumps.incrementalRecords(bytesOf(fixtureXml.toString("utf8"))));
    expect(records.length).toBe(3);
  });

  it("flushes a truncated trailing revision as a per-record error", async () => {
    const truncated =
      "<mediawiki><page><title>T</title><ns>0</ns><id>1</id><revision><id>5</id><text>hi";
    const records = await collect(Dumps.pageRecords(bytesOf(truncated)));
    expect(records.length).toBe(1);
    const error = records[0];
    if (error?._tag !== "error") throw new Error("expected error");
    expect(error.reason).toBe("dumps/malformed-revision");
    expect(error.detail).toContain("truncated");
    expect(error.page).toEqual({ title: "T", ns: 0, id: 1 });
  });

  it("degrades a revision left unclosed before </page> (not silently dropped)", async () => {
    const xml =
      "<mediawiki><page><title>A</title><ns>0</ns><id>1</id>" +
      "<revision><id>7</id><text>hi</text></page></mediawiki>";
    const records = await collect(Dumps.pageRecords(bytesOf(xml)));
    expect(records.length).toBe(1);
    const error = records[0];
    if (error?._tag !== "error") throw new Error("expected error");
    expect(error.reason).toBe("dumps/malformed-revision");
    expect(error.detail).toContain("not closed");
    expect(error.page).toEqual({ title: "A", ns: 0, id: 1 });
  });

  it("degrades a revision left unclosed before the next <revision>, keeping the next one", async () => {
    const xml =
      "<mediawiki><page><title>B</title><ns>0</ns><id>2</id>" +
      "<revision><id>8</id><text>x</text>" +
      "<revision><id>9</id><timestamp>t</timestamp><text>y</text></revision></page></mediawiki>";
    const records = await collect(Dumps.pageRecords(bytesOf(xml)));
    expect(records.map((r) => r._tag)).toEqual(["error", "revision"]);
    const good = records[1];
    if (good?._tag !== "revision") throw new Error("expected revision");
    expect(good.revision.id).toBe(9);
  });

  it("degrades a revision whose text exceeds the field cap (bounded memory)", async () => {
    // 17 MB > the 16 MB MAX_TEXT_LENGTH — the buffer is capped, and the
    // revision degrades rather than being retained without limit.
    const huge = "z".repeat(17 * 1024 * 1024);
    const xml =
      "<mediawiki><page><title>C</title><ns>0</ns><id>3</id>" +
      `<revision><id>10</id><timestamp>t</timestamp><text>${huge}</text></revision></page></mediawiki>`;
    const records = await collect(Dumps.pageRecords(bytesOf(xml)));
    expect(records.length).toBe(1);
    const error = records[0];
    if (error?._tag !== "error") throw new Error("expected error");
    expect(error.reason).toBe("dumps/malformed-revision");
    expect(error.detail).toContain("exceeds");
  });

  it("onlyRevisions drops the error elements", async () => {
    const revs = await runTest(
      Stream.runCount(
        Dumps.pageRecords(bytesOf(fixtureXml.toString("utf8"))).pipe(Dumps.onlyRevisions),
      ),
    );
    expect(revs).toBe(2);
  });
});
