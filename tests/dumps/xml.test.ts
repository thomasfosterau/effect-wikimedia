/**
 * Unit tests for the XML pages dump pipeline (`src/dumps/xml.ts`): the pure
 * scanner primitives (table-driven), chunk-boundary safety of
 * {@link XmlPageReader}, and the full `Stream` pipeline over a fixture —
 * page/revision metadata round-trips and a malformed revision degrades per
 * record.
 *
 * @module tests/dumps/xml
 */

import * as Struct from "effect/Struct";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Stream from "effect/Stream";
import { Dumps } from "../../src/index.ts";

const fixtureXml = readFileSync(
  fileURLToPath(new URL("../fixtures/dumps/pages-slice.xml", import.meta.url)),
);

const bytesOf = (text: string): Stream.Stream<Uint8Array> =>
  Stream.make(new TextEncoder().encode(text));

const collect = <A, E>(stream: Stream.Stream<A, E>): Effect.Effect<ReadonlyArray<A>, E> =>
  Stream.runCollect(stream);

// ── tagName (table-driven) ───────────────────────────────────────────────

describe("tagName", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["revision", "revision"],
    ['text xml:space="preserve"', "text"],
    ["ns ", "ns"],
    ["PAGE", "page"],
    ["minor/", "minor"],
  ];
  it.each(cases)("%j → %s", (input, expected) => {
    expect(Dumps.tagName(input)).toBe(expected);
  });
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
    [
      '<text xml:space="preserve" bytes="4">',
      [{ t: "open", name: "text", attributes: 'xml:space="preserve" bytes="4"' }],
    ],
    [
      '<redirect title="A &amp; B" />',
      [
        { t: "open", name: "redirect", attributes: 'title="A &amp; B"' },
        { t: "close", name: "redirect" },
      ],
    ],
    ["<page >", [{ t: "open", name: "page" }]],
  ];
  it.each(cases)("%j", (input, expected) => {
    expect(Dumps.classifyTag(input)).toEqual(expected);
  });
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
  it.each(cases)("%j → %j", (input, expected) => {
    expect(Dumps.decodeXmlEntities(input)).toBe(expected);
  });

  it("decodes each of XML's five predefined entities", () => {
    expect(Dumps.decodeXmlEntities("&amp;&lt;&gt;&quot;&apos;")).toBe("&<>\"'");
  });

  // The lookup is own-key only: an `Object.prototype` name is a well-formed
  // entity, and an object-literal table "found" it as a built-in function.
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty"])(
    "keeps &%s; as written",
    (name) => {
      expect(Dumps.decodeXmlEntities(`a &${name}; b`)).toBe(`a &${name}; b`);
    },
  );

  it("keeps a name outside XML's five as written, even an HTML one", () => {
    expect(Dumps.decodeXmlEntities("&nbsp;&AMP;&Lt;")).toBe("&nbsp;&AMP;&Lt;");
  });

  // XML 1.0 `Char`: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF].
  const valid: ReadonlyArray<readonly [string, string]> = [
    ["&#9;", "\t"],
    ["&#xA;", "\n"],
    ["&#xD;", "\r"],
    ["&#x20;", " "],
    ["&#xD7FF;", "\uD7FF"],
    ["&#xE000;", "\uE000"],
    ["&#xFFFD;", "\uFFFD"],
    ["&#x10000;", "\u{10000}"],
    ["&#x10FFFF;", "\u{10FFFF}"],
    ["&#0065;", "A"],
    ["&#X41;", "A"],
  ];
  it.each(valid)("decodes %s, a code point XML allows", (input, expected) => {
    expect(Dumps.decodeXmlEntities(input)).toBe(expected);
  });

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
  Arr.forEach(invalid, (input) => {
    const shown = input.length > 24 ? `${input.slice(0, 20)}…` : input;
    it(`keeps ${shown} as written, a code point XML forbids`, () => {
      expect(Dumps.decodeXmlEntities(`a${input}b`)).toBe(`a${input}b`);
    });
  });

  // Only a whole decimal or hex reference decodes; the leading digits of a
  // malformed one never do.
  it.each(["&#65a;", "&#9f;", "&#12.5;", "&#1e2;", "&#65.0;", "&#x41g;", "&#x;", "&#;", "&#-65;"])(
    "keeps the malformed reference %s as written",
    (input) => {
      expect(Dumps.decodeXmlEntities(input)).toBe(input);
    },
  );
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

  it("emits a stray > as text, and a tag runs to the first > after its <", () => {
    expect(Dumps.tokenizeXml("a>b<id<x>c>d")).toEqual({
      tokens: [
        { t: "text", value: "a>b" },
        { t: "open", name: "id<x" },
        { t: "text", value: "c>d" },
      ],
      rest: "",
    });
  });

  it("carries from the first < after the last >", () => {
    expect(Dumps.tokenizeXml("<id>1 < 2 <b")).toEqual({
      tokens: [
        { t: "open", name: "id" },
        { t: "text", value: "1 " },
      ],
      rest: "< 2 <b",
    });
    expect(Dumps.tokenizeXml("x<y")).toEqual({ tokens: [{ t: "text", value: "x" }], rest: "<y" });
    expect(Dumps.tokenizeXml("")).toEqual({ tokens: [], rest: "" });
  });
});

// ── The pipeline over the fixture ────────────────────────────────────────

/** The {@link Dumps.PageRef} the reader gives for these values, `None` for an omitted `redirect`. */
const pageRef = (title: string, ns: number, id: number, redirect?: string): Dumps.PageRef => ({
  title: Option.some(title),
  ns: Option.some(ns),
  id: Option.some(id),
  redirect: Option.fromUndefinedOr(redirect),
});

describe("pageRecords pipeline", () => {
  it.effect("round-trips page/revision metadata and degrades the malformed revision", () =>
    Effect.gen(function* () {
      const records = yield* collect(Dumps.pageRecords(bytesOf(fixtureXml.toString("utf8"))));
      expect(records.length).toBe(3);

      const hits = records.filter(P.isTagged("revision"));
      const errors = records.filter(P.isTagged("error"));
      expect(hits.length).toBe(2);
      expect(errors.length).toBe(1);

      const first = hits[0];
      if (!P.isTagged(first, "revision")) return expect.unreachable("expected revision");
      expect(first.page).toEqual(pageRef("Douglas Adams", 0, 8091));
      expect(first.revision.id).toBe(100);
      expect(first.revision.isMinor).toBe(true);
      expect(first.revision.comment).toEqual(Option.some("first version"));
      expect(first.revision.contributor).toEqual(
        Option.some({ username: Option.some("AxelBoldt"), id: Option.some(2), ip: Option.none() }),
      );
      expect(first.revision.text).toEqual(Option.some("'''Douglas Adams''' < check 1 & 2 > 0"));

      const second = hits[1];
      if (!P.isTagged(second, "revision")) return expect.unreachable("expected revision");
      expect(second.revision.id).toBe(101);
      expect(second.revision.parentId).toEqual(Option.some(100));
      expect(second.revision.contributor).toEqual(
        Option.some({ username: Option.none(), id: Option.none(), ip: Option.some("10.0.0.1") }),
      );
      expect(second.revision.isMinor).toBe(false);

      const error = errors[0];
      if (!P.isTagged(error, "error")) return expect.unreachable("expected error");
      expect(error.reason).toBe("dumps/malformed-revision");
      expect(error.page).toEqual(pageRef("Category:Writers", 14, 200));
    }),
  );

  const perByte = (text: string): Stream.Stream<Uint8Array> => {
    const encoded = new TextEncoder().encode(text);
    // One UTF-8 *byte* per chunk — the worst case for tag / entity straddling
    // and for multibyte code points split mid-sequence.
    return Stream.fromIterable([...encoded].map((b) => Uint8Array.of(b)));
  };

  it.effect("is chunk-boundary safe: byte-by-byte input yields the same records", () =>
    Effect.gen(function* () {
      const text = fixtureXml.toString("utf8");
      const whole = yield* collect(Dumps.pageRecords(bytesOf(text)));
      const chunked = yield* collect(Dumps.pageRecords(perByte(text)));
      expect(chunked).toEqual(whole);
    }),
  );

  it.effect(
    "is multibyte-safe: a title / text with multibyte code points survives a per-byte split",
    () =>
      Effect.gen(function* () {
        const xml =
          "<mediawiki><page><title>Café 日本語</title><ns>0</ns><id>5</id>" +
          "<revision><id>3</id><timestamp>t</timestamp><text>é 漢 &amp; ok</text></revision></page></mediawiki>";
        const whole = yield* collect(Dumps.pageRecords(bytesOf(xml)));
        const chunked = yield* collect(Dumps.pageRecords(perByte(xml)));
        expect(chunked).toEqual(whole);
        const hit = whole[0];
        if (!P.isTagged(hit, "revision")) return expect.unreachable("expected revision");
        expect(hit.page.title).toEqual(Option.some("Café 日本語"));
        expect(hit.revision.text).toEqual(Option.some("é 漢 & ok"));
      }),
  );

  it.effect("incrementalRecords decodes the same schema", () =>
    Effect.gen(function* () {
      const records = yield* collect(
        Dumps.incrementalRecords(bytesOf(fixtureXml.toString("utf8"))),
      );
      expect(records.length).toBe(3);
    }),
  );

  it.effect("flushes a truncated trailing revision as a per-record error", () =>
    Effect.gen(function* () {
      const truncated =
        "<mediawiki><page><title>T</title><ns>0</ns><id>1</id><revision><id>5</id><text>hi";
      const records = yield* collect(Dumps.pageRecords(bytesOf(truncated)));
      expect(records.length).toBe(1);
      const error = records[0];
      if (!P.isTagged(error, "error")) return expect.unreachable("expected error");
      expect(error.reason).toBe("dumps/malformed-revision");
      expect(error.detail).toContain("truncated");
      expect(error.page).toEqual(pageRef("T", 0, 1));
    }),
  );

  it.effect("degrades a revision left unclosed before </page> (not silently dropped)", () =>
    Effect.gen(function* () {
      const xml =
        "<mediawiki><page><title>A</title><ns>0</ns><id>1</id>" +
        "<revision><id>7</id><text>hi</text></page></mediawiki>";
      const records = yield* collect(Dumps.pageRecords(bytesOf(xml)));
      expect(records.length).toBe(1);
      const error = records[0];
      if (!P.isTagged(error, "error")) return expect.unreachable("expected error");
      expect(error.reason).toBe("dumps/malformed-revision");
      expect(error.detail).toContain("not closed");
      expect(error.page).toEqual(pageRef("A", 0, 1));
    }),
  );

  it.effect(
    "degrades a revision left unclosed before the next <revision>, keeping the next one",
    () =>
      Effect.gen(function* () {
        const xml =
          "<mediawiki><page><title>B</title><ns>0</ns><id>2</id>" +
          "<revision><id>8</id><text>x</text>" +
          "<revision><id>9</id><timestamp>t</timestamp><text>y</text></revision></page></mediawiki>";
        const records = yield* collect(Dumps.pageRecords(bytesOf(xml)));
        expect(records.map((r) => Struct.get(r, "_tag"))).toEqual(["error", "revision"]);
        const good = records[1];
        if (!P.isTagged(good, "revision")) return expect.unreachable("expected revision");
        expect(good.revision.id).toBe(9);
      }),
  );

  it.effect("degrades a revision whose text exceeds the field cap (bounded memory)", () =>
    Effect.gen(function* () {
      // 17 MB > the 16 MB MAX_TEXT_LENGTH — the buffer is capped, and the
      // revision degrades rather than being retained without limit.
      const huge = "z".repeat(17 * 1024 * 1024);
      const xml =
        "<mediawiki><page><title>C</title><ns>0</ns><id>3</id>" +
        `<revision><id>10</id><timestamp>t</timestamp><text>${huge}</text></revision></page></mediawiki>`;
      const records = yield* collect(Dumps.pageRecords(bytesOf(xml)));
      expect(records.length).toBe(1);
      const error = records[0];
      if (!P.isTagged(error, "error")) return expect.unreachable("expected error");
      expect(error.reason).toBe("dumps/malformed-revision");
      expect(error.detail).toBe("revision field exceeds the 16777216-code-unit cap");
    }),
  );

  it.effect("counts the cap in UTF-16 code units of the escaped text, not bytes (#155)", () =>
    Effect.gen(function* () {
      const revisionWith = (text: string) =>
        "<mediawiki><page><title>C</title><ns>0</ns><id>3</id>" +
        `<revision><id>10</id><text>${text}</text></revision></page></mediawiki>`;
      // 16,777,216 code units of 3-byte UTF-8 (50 MB) is within the cap.
      const atCap = yield* collect(
        Dumps.pageRecords(bytesOf(revisionWith("€".repeat(16_777_216)))),
      );
      expect(atCap.map((r) => Struct.get(r, "_tag"))).toEqual(["revision"]);
      // 3,355,444 `&amp;` decode to that many characters but are 16,777,220 escaped code units.
      const escaped = yield* collect(
        Dumps.pageRecords(bytesOf(revisionWith("&amp;".repeat(3_355_444)))),
      );
      expect(escaped.map((r) => Struct.get(r, "_tag"))).toEqual(["error"]);
    }),
  );

  describe("a multi-slot revision (export schema 0.11) (#154)", () => {
    const multiSlot = (extraSlotText: string) =>
      "<mediawiki><page><title>File:T.jpg</title><ns>6</ns><id>1</id><revision><id>5</id>\n" +
      '<model>wikitext</model><format>text/x-wiki</format><text bytes="4">main</text>\n' +
      "<content><role>mediainfo</role><origin>5</origin><model>wikibase-mediainfo</model>\n" +
      `<format>application/json</format><text bytes="2">${extraSlotText}</text></content>\n` +
      "<sha1>x</sha1></revision></page></mediawiki>";

    it.effect("reads model, format and text from the main slot (the issue's repro)", () =>
      Effect.gen(function* () {
        const records = yield* collect(Dumps.pageRecords(bytesOf(multiSlot("{}"))));
        expect(records.map((r) => Struct.get(r, "_tag"))).toEqual(["revision"]);
        const hit = records[0];
        if (!P.isTagged(hit, "revision")) return expect.unreachable("expected revision");
        expect(hit.revision).toMatchObject({
          id: 5,
          model: Option.some("wikitext"),
          format: Option.some("text/x-wiki"),
          text: Option.some("main"),
          sha1: Option.some("x"),
        });
      }),
    );

    it.effect("doesn't count another slot's text towards the field cap", () =>
      Effect.gen(function* () {
        const records = yield* collect(
          Dumps.pageRecords(bytesOf(multiSlot("z".repeat(17 * 1024 * 1024)))),
        );
        expect(records.map((r) => Struct.get(r, "_tag"))).toEqual(["revision"]);
      }),
    );
  });

  describe("redirects (#207)", () => {
    const page = (id: number, head: string, revision = `<revision><id>${id}0</id></revision>`) =>
      `<page><title>P${id}</title><ns>0</ns><id>${id}</id>${head}${revision}</page>`;
    const dump =
      "<mediawiki>" +
      page(1, '<redirect title="Ada &amp; &quot;Lovelace&quot;" />') +
      page(2, "") +
      page(3, "<redirect title='  Single quoted  ' />") +
      page(4, "<redirect />") +
      page(5, '<redirect title="   " />') +
      page(6, '<redirect title="Gone" />', "<revision><text>no id</text></revision>") +
      page(7, "", `<revision><id>70</id><redirect title="Inside" /></revision>`) +
      "</mediawiki>";

    it.effect("reads <redirect title> onto PageRef.redirect, decoded and trimmed", () =>
      Effect.gen(function* () {
        const records = yield* collect(Dumps.pageRecords(bytesOf(dump)));
        expect(records.map((r) => Option.getOrNull(r.page.redirect))).toEqual([
          'Ada & "Lovelace"',
          null,
          "Single quoted",
          null,
          null,
          "Gone",
          null,
        ]);
        expect(records[0]?.page).toEqual(pageRef("P1", 0, 1, 'Ada & "Lovelace"'));
      }),
    );

    it.effect("doesn't carry a redirect over to the next page", () =>
      Effect.gen(function* () {
        const records = yield* collect(
          Dumps.pageRecords(
            bytesOf("<mediawiki>" + page(1, '<redirect title="X"/>') + page(2, "")),
          ),
        );
        expect(records.map((r) => Option.getOrNull(r.page.redirect))).toEqual(["X", null]);
      }),
    );

    it.effect("is chunk-boundary safe", () =>
      Effect.gen(function* () {
        const whole = yield* collect(Dumps.pageRecords(bytesOf(dump)));
        const chunked = yield* collect(Dumps.pageRecords(perByte(dump)));
        expect(chunked).toEqual(whole);
      }),
    );

    it.effect("cuts a long redirect title to 4,096 code units", () =>
      Effect.gen(function* () {
        const long = "x".repeat(5000);
        const records = yield* collect(
          Dumps.pageRecords(bytesOf(page(1, `<redirect title="${long}" />`))),
        );
        expect(Option.getOrNull(records[0]?.page.redirect ?? Option.none())).toBe("x".repeat(4096));
      }),
    );

    it.effect("skipRedirects drops redirect pages' records, errors included", () =>
      Effect.gen(function* () {
        const records = yield* collect(Dumps.pageRecords(bytesOf(dump)).pipe(Dumps.skipRedirects));
        expect(records.map((r) => Option.getOrNull(r.page.id))).toEqual([2, 4, 5, 7]);
        const hits = yield* collect(
          Dumps.pageRecords(bytesOf(dump)).pipe(Dumps.onlyRevisions, Dumps.skipRedirects),
        );
        expect(hits.map((r) => r.revision.id)).toEqual([20, 40, 50, 70]);
      }),
    );
    it.effect("skipRedirects keeps an error record on a page that isn't a redirect", () =>
      Effect.gen(function* () {
        const orphan: Dumps.PageRevisionError = {
          _tag: "error",
          reason: "dumps/malformed-revision",
          page: pageRef("P", 0, 1),
          detail: "revision missing id",
        };
        expect(yield* collect(Stream.make(orphan).pipe(Dumps.skipRedirects))).toEqual([orphan]);
      }),
    );
  });

  it.effect("onlyRevisions drops the error elements", () =>
    Effect.gen(function* () {
      const revs = yield* Stream.runCount(
        Dumps.pageRecords(bytesOf(fixtureXml.toString("utf8"))).pipe(Dumps.onlyRevisions),
      );
      expect(revs).toBe(2);
    }),
  );
});
