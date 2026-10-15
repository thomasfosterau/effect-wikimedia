/**
 * Query / manipulation surface: template extraction (name + params against a
 * real infobox), node filters, and strip-to-plain-text.
 *
 * @module tests/query
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
  filter,
  findTemplates,
  getParam,
  normaliseTemplateName,
  parse,
  stripToText,
  templateName,
  walk,
} from "../src/wikitext/index.ts";

const ada = readFileSync(
  fileURLToPath(new URL("./fixtures/ada-lovelace.txt", import.meta.url)),
  "utf8",
);

describe("template extraction against a real infobox", () => {
  const doc = parse(ada);

  it("finds the infobox by (normalised) name", () => {
    const boxes = findTemplates(doc, "infobox person");
    expect(boxes).toHaveLength(1);
    expect(templateName(boxes[0])).toBe("Infobox person");
  });

  it("extracts named parameter values", () => {
    const box = findTemplates(doc, "Infobox person")[0];
    expect(getParam(box, "name")).toBe("Ada Lovelace");
    expect(getParam(box, "birth_name")).toBe("Augusta Ada Byron");
    expect(getParam(box, "nationality")).toBe("British");
  });

  it("keeps nested-template values as their raw wikitext", () => {
    const box = findTemplates(doc, "Infobox person")[0];
    expect(getParam(box, "birth_date")).toBe("{{birth date|1815|12|10|df=y}}");
  });

  it("finds nested templates too", () => {
    // {{birth date|…}}, {{death date and age|…}}, {{sfn|…}}, etc. are nested.
    expect(findTemplates(doc, "birth date")).toHaveLength(1);
    expect(findTemplates(doc).length).toBeGreaterThan(5);
  });

  it("reads positional parameters by 1-based index", () => {
    const t = parse("{{convert|10|km|mi}}");
    const conv = findTemplates(t, "convert")[0];
    expect(getParam(conv, 1)).toBe("10");
    expect(getParam(conv, 2)).toBe("km");
    expect(getParam(conv, 3)).toBe("mi");
  });

  it("lets an explicit numbered param override the positional slot", () => {
    const t = parse("{{t|first|1=override}}");
    expect(getParam(findTemplates(t, "t")[0], 1)).toBe("override");
  });
});

describe("normaliseTemplateName", () => {
  it("treats underscores/spaces/first-letter case as equivalent", () => {
    expect(normaliseTemplateName("infobox_person")).toBe("Infobox person");
    expect(normaliseTemplateName("  Infobox   person  ")).toBe("Infobox person");
    expect(normaliseTemplateName("infobox person")).toBe(normaliseTemplateName("Infobox_person"));
  });
});

describe("filter / walk", () => {
  it("collects every wikilink at any depth", () => {
    const doc = parse(ada);
    const links = filter(doc, (n) => n._tag === "Wikilink");
    expect(links.length).toBeGreaterThan(3);
  });

  it("visits nested nodes in pre-order and can skip subtrees", () => {
    const doc = parse("a{{t|[[L]]}}b");
    const seen: string[] = [];
    walk(doc, (n) => {
      seen.push(n._tag);
      if (n._tag === "Template") return false; // don't descend
    });
    expect(seen).toContain("Template");
    expect(seen).not.toContain("Wikilink");
  });
});

describe("strip to plain text", () => {
  it("removes markup, keeps prose, resolves links to labels", () => {
    const doc = parse("'''Bold''' and ''italic'' text with a [[Target|label]] and [[Plain]] link.");
    expect(stripToText(doc)).toBe("Bold and italic text with a label and Plain link.");
  });

  it("drops templates, comments, and reference tags", () => {
    const doc = parse("Prose{{template}} more<!-- c --> text<ref>cite</ref>.");
    expect(stripToText(doc)).toBe("Prose more text.");
  });

  it("decodes entities and keeps nowiki content literal", () => {
    const doc = parse("A&nbsp;B &amp; <nowiki>'''C'''</nowiki>");
    expect(stripToText(doc)).toBe("A\u00a0B & '''C'''");
  });

  it("drops file/category links but keeps ordinary link labels", () => {
    const doc = parse("[[File:x.png|thumb|cap]][[Category:Y]][[Article|shown]]");
    expect(stripToText(doc)).toBe("shown");
  });

  it("turns a lead paragraph into clean prose", () => {
    // A template-free sentence: strip should match what a reader sees.
    const doc = parse(
      "The [[Analytical Engine]] was a ''proposed'' [[mechanical computer|machine]].",
    );
    expect(stripToText(doc)).toBe("The Analytical Engine was a proposed machine.");
  });

  it("renders a bare autolinked url as its own text", () => {
    const doc = parse("See http://example.org for more.");
    expect(stripToText(doc)).toBe("See http://example.org for more.");
  });

  it("joins table cell text with spaces between cells and newlines between rows", () => {
    // Best-effort, not cleaned up: stripToText leaves whitespace as-is, so
    // each cell's own trailing newline shows through the join too.
    const doc = parse("{|\n|+ Cap\n! A !! B\n|-\n| 1 || 2\n|}");
    expect(stripToText(doc)).toBe(" Cap\n\n A   B\n\n 1   2\n");
  });
});

describe("strip to plain text: entities (#107)", () => {
  /** Strips `src`, first checking the parser read all of it as entities. */
  const stripEntities = (src: string): string => {
    const doc = parse(src);
    expect(doc.children.map((n) => n._tag)).toEqual(doc.children.map(() => "HtmlEntity"));
    return stripToText(doc);
  };

  it.each([
    ["&#65;", "A"],
    ["&#0065;", "A"],
    ["&#x41;", "A"],
    ["&#X41;", "A"],
    ["&#xe9;", "\u00e9"],
    ["&#xE9;", "\u00e9"],
    ["&#233;", "\u00e9"],
    ["&#x1F600;", "\u{1F600}"],
    ["&#128512;", "\u{1F600}"],
  ])("decodes the numeric reference %s", (src, text) => {
    expect(stripEntities(src)).toBe(text);
  });

  // The edges of MediaWiki's `Sanitizer::validateCodepoint`.
  it.each([
    ["&#9;", "\t"],
    ["&#10;", "\n"],
    ["&#x20;", " "],
    ["&#x7E;", "~"],
    ["&#xA0;", "\u00a0"],
    ["&#xD7FF;", "\ud7ff"],
    ["&#xE000;", "\ue000"],
    ["&#xFFFD;", "\ufffd"],
    ["&#x10000;", "\u{10000}"],
    ["&#x10FFFF;", "\u{10FFFF}"],
  ])("decodes %s, the edge of a renderable range", (src, text) => {
    expect(stripEntities(src)).toBe(text);
  });

  // MediaWiki renders these as the literal reference, so a reader sees it as
  // written. Decoding would put a control character or a lone surrogate (not
  // well-formed UTF-16) into the text.
  it.each([
    ["NUL", "&#0;"],
    ["a C0 control", "&#x1F;"],
    ["carriage return", "&#13;"],
    ["DEL", "&#x7F;"],
    ["a C1 control", "&#x9F;"],
    ["a high surrogate", "&#xD800;"],
    ["a low surrogate", "&#xDFFF;"],
    ["a noncharacter", "&#xFFFE;"],
    ["the last BMP noncharacter", "&#xFFFF;"],
    ["a code point past U+10FFFF", "&#x110000;"],
    ["a decimal past U+10FFFF", "&#1114112;"],
    ["a decimal too long for a double", `&#${"9".repeat(400)};`],
    ["a hex reference too long for a double", `&#x${"F".repeat(300)};`],
  ])("keeps a reference to %s as written", (_, src) => {
    expect(stripEntities(src)).toBe(src);
  });

  it("keeps a surrogate pair spelt as two references as written, not joined", () => {
    expect(stripEntities("&#55357;&#56832;")).toBe("&#55357;&#56832;");
  });

  it.each([
    ["&amp;", "&"],
    ["&lt;", "<"],
    ["&gt;", ">"],
    ["&quot;", '"'],
    ["&apos;", "'"],
    ["&nbsp;", "\u00a0"],
    ["&ndash;", "\u2013"],
    ["&mdash;", "\u2014"],
    ["&hellip;", "\u2026"],
    ["&times;", "\u00d7"],
    ["&deg;", "\u00b0"],
  ])("decodes the named entity %s", (src, text) => {
    expect(stripEntities(src)).toBe(text);
  });

  // Each is a well-formed entity to the parser; a lookup on a plain object
  // would find the inherited `Object.prototype` member and print its source.
  it.each(["&unknown;", "&constructor;", "&toString;", "&valueOf;", "&hasOwnProperty;"])(
    "keeps the unknown named entity %s as written",
    (src) => {
      expect(stripEntities(src)).toBe(src);
    },
  );

  it.each(["&#;", "&#x;", "&#xZZ;", "&#12", "&#-5;", "&#12.5;"])(
    "leaves the malformed reference %s as literal text",
    (src) => {
      expect(stripToText(parse(src))).toBe(src);
    },
  );

  // An `HtmlEntity` built by hand rather than parsed: only a whole decimal
  // or hex reference decodes.
  it.each(["&#-5;", "&#12.5;", "&#x41g;", "&#+65;", "&# 65;"])(
    "keeps a hand-built malformed reference %s as written",
    (raw) => {
      const node = { _tag: "HtmlEntity", span: { start: 0, end: raw.length }, raw } as const;
      expect(stripToText(node)).toBe(raw);
    },
  );
});

describe("tables and autolinks reachable via walk/filter (issue #1287)", () => {
  it("finds an AutoLink node at any depth", () => {
    const doc = parse("'''bold''' http://example.org more");
    expect(filter(doc, (n) => n._tag === "AutoLink")).toHaveLength(1);
  });

  it("descends into table captions and cell content", () => {
    const doc = parse(
      "{|\n|+ has a [[Caption Link]]\n| has [[Cell Link]] and http://example.org\n|}",
    );
    const links = filter(doc, (n) => n._tag === "Wikilink");
    expect(links).toHaveLength(2);
    expect(filter(doc, (n) => n._tag === "AutoLink")).toHaveLength(1);
  });
});
