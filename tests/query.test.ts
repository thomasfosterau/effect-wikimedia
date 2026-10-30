/**
 * Query / manipulation surface: template extraction (name + params against a
 * real infobox), node filters, and strip-to-plain-text.
 *
 * @module tests/query
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  basicTemplateRenderers,
  EXTENSION_TAGS,
  filter,
  findTemplates,
  getParam,
  type Node,
  normaliseTemplateName,
  parse,
  stripToText,
  type TemplateRenderer,
  templateName,
  templateParams,
  walk,
} from "../src/wikitext/index.ts";
import { NAMED_ENTITIES } from "../src/wikitext/entities.ts";

/** `JSON.stringify` through the `Schema` JSON boundary (encoding `Unknown` is the identity). */
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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

  it("returns the effective parameters as a HashMap, later duplicates winning", () => {
    const params = templateParams(findTemplates(parse("{{t| a |x=1|b|x= 2 }}"), "t")[0]);
    expect(HashMap.isHashMap(params)).toBe(true);
    expect(Arr.sort(HashMap.toEntries(params), Order.Tuple([Order.String, Order.String]))).toEqual([
      ["1", "a"],
      ["2", "b"],
      ["x", "2"],
    ]);
  });
});

describe("EXTENSION_TAGS", () => {
  it("is a HashSet of the opaque-bodied tag names", () => {
    expect(HashSet.isHashSet(EXTENSION_TAGS)).toBe(true);
    expect(HashSet.has(EXTENSION_TAGS, "nowiki")).toBe(true);
    expect(HashSet.has(EXTENSION_TAGS, "div")).toBe(false);
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
    const links = filter(doc, Predicate.isTagged("Wikilink"));
    expect(links.length).toBeGreaterThan(3);
  });

  it("visits nested nodes in pre-order and can skip subtrees", () => {
    const doc = parse("a{{t|[[L]]}}b");
    const seen: string[] = [];
    walk(doc, (n) => {
      seen.push(n._tag);
      if (Predicate.isTagged(n, "Template")) return false; // don't descend
    });
    expect(seen).toContain("Template");
    expect(seen).not.toContain("Wikilink");
  });

  it("visits siblings in source order, each node's children before its next sibling (#175)", () => {
    const doc = parse("{{A|{{B}}}} {{C|[[D]]}}");
    const seen: string[] = [];
    walk(doc, (n) => {
      seen.push(`${n._tag}@${n.span.start}`);
    });
    // Each template's `name` fragment holds a Text node, visited before its params.
    expect(seen).toEqual([
      "Template@0",
      "Text@2",
      "Template@4",
      "Text@6",
      "Text@11",
      "Template@12",
      "Text@14",
      "Wikilink@16",
      "Text@18",
    ]);
  });

  it("agrees with filter on order, so findTemplates returns document order (#175)", () => {
    const doc = parse("{{A}} {{B|{{C}}}} {{D}}");
    const tags = (n: Node) => `${n._tag}@${n.span.start}`;
    const walked: string[] = [];
    walk(doc, (n) => {
      walked.push(tags(n));
    });
    expect(walked).toEqual(filter(doc, () => true).map(tags));
    expect(findTemplates(doc).map(templateName)).toEqual(["A", "B", "C", "D"]);
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

describe("strip to plain text: template renderers (#210)", () => {
  const withBasic = (src: string): string =>
    stripToText(parse(src), { templates: basicTemplateRenderers });

  it("renders every template as nothing without options, as before", () => {
    expect(stripToText(parse("a {{nowrap|37 ft}} wall"))).toBe("a  wall");
    expect(stripToText(parse("a {{nowrap|37 ft}} wall"), {})).toBe("a  wall");
  });

  it.each([
    ["a {{nowrap|37 ft}} wall", "a 37 ft wall"],
    ["{{small|(fine print)}}", "(fine print)"],
    ["{{abbr|NASA|National Aeronautics and Space Administration}}", "NASA"],
    ["the {{lang|fr|mot juste}} here", "the mot juste here"],
    ["{{lang|fr}}", ""],
    ["{{nowrap}}", ""],
  ])("basicTemplateRenderers renders %j as %j", (src, text) => {
    expect(withBasic(src)).toBe(text);
  });

  it("matches names via normaliseTemplateName, on both sides", () => {
    expect(withBasic("{{ Nowrap_ |x}}{{NOWRAP|y}}")).toBe("x");
    const shout: TemplateRenderer = () => "!";
    expect(
      stripToText(parse("{{Big deal}}{{big_deal}}"), { templates: { " big_deal ": shout } }),
    ).toBe("!!");
  });

  it("renders nested templates and markup inside a parameter", () => {
    expect(withBasic("{{nowrap|[[Paris|the city]] {{lang|fr|''ville''}}{{unknown}}}}")).toBe(
      "the city ville",
    );
  });

  it("keeps positional whitespace and trims named values, as MediaWiki does", () => {
    const show: TemplateRenderer = (_, { param }) => `[${param(1) ?? "-"}|${param("k") ?? "-"}]`;
    const strip = (src: string) => stripToText(parse(src), { templates: { show } });
    expect(strip("{{show| a b | k = v }}")).toBe("[ a b |v]");
    expect(strip("{{show|x|1= y }}")).toBe("[y|-]");
    expect(strip("{{show}}")).toBe("[-|-]");
  });

  it("calls the fallback for unregistered templates only", () => {
    const fallback: TemplateRenderer = (t) => `<${templateName(t)}>`;
    expect(
      stripToText(parse("{{nowrap|a}} {{convert|37|ft}}"), {
        templates: basicTemplateRenderers,
        templateFallback: fallback,
      }),
    ).toBe("a <convert>");
    expect(stripToText(parse("x{{a}}y"), { templateFallback: () => "-" })).toBe("x-y");
  });

  it("lets a renderer strip any fragment with the same options", () => {
    const first: TemplateRenderer = (t, { strip }) => strip(t.params[0]?.value ?? []);
    expect(
      stripToText(parse("{{first|{{nowrap|n}}&amp;}}"), {
        templates: { ...basicTemplateRenderers, first },
      }),
    ).toBe("n&");
  });

  it("restores the {{nowrap}} prose of the recorded Ada Lovelace article", () => {
    const plain = stripToText(parse(ada));
    const rendered = stripToText(parse(ada), { templates: basicTemplateRenderers });
    expect(plain).toContain("including  and Michael Faraday.");
    expect(rendered).toContain("including Charles Babbage and Michael Faraday.");
  });

  it("applies to a single node and a bare fragment", () => {
    const doc = parse("{{nowrap|z}}");
    expect(stripToText(doc.children[0], { templates: basicTemplateRenderers })).toBe("z");
    expect(stripToText(doc.children, { templates: basicTemplateRenderers })).toBe("z");
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
    // HTML5 names past the eleven `stripToText` knew before #118.
    ["&eacute;", "\u00e9"],
    ["&Eacute;", "\u00c9"],
    ["&copy;", "\u00a9"],
    ["&COPY;", "\u00a9"],
    ["&AMP;", "&"],
    ["&euro;", "\u20ac"],
    ["&rarr;", "\u2192"],
    ["&frac12;", "\u00bd"],
    ["&rlm;", "\u200f"],
    ["&NewLine;", "\n"],
    ["&Afr;", "\u{1D504}"],
    ["&CounterClockwiseContourIntegral;", "\u2233"],
    // Two code points each.
    ["&NotEqualTilde;", "\u2242\u0338"],
    ["&ThickSpace;", "\u205f\u200a"],
    ["&fjlig;", "fj"],
  ])("decodes the named entity %s", (src, text) => {
    expect(stripEntities(src)).toBe(text);
  });

  // MediaWiki's `Sanitizer::MW_ENTITY_ALIASES`, read as `&rlm;`.
  it.each([
    ["the Hebrew alias", "&\u05e8\u05dc\u05de;"],
    ["the Arabic alias", "&\u0631\u0644\u0645;"],
  ])("decodes %s of &rlm;", (_, src) => {
    expect(stripEntities(src)).toBe("\u200f");
  });

  it("holds exactly the names and text of HTML5's table", () => {
    // A digest of the sorted entries, so a changed value or a renamed entry
    // fails even though the round-trip test below reads its expectations from
    // the table itself. The same digest comes from `character-entities` 2.0.2
    // and from remex-html's `;`-terminated entries (#123's review).
    const entries = Arr.sort(
      NAMED_ENTITIES,
      Order.mapInput(Order.String, ([name]: readonly [string, string]) => name),
    );
    expect(createHash("sha256").update(encodeJson(entries)).digest("hex")).toBe(
      "083dc02ec806d6d630ad69cdcd3ebf4b3f04509f8ad00ad8772f8905d285beb4",
    );
  });

  it("decodes every name in the HTML5 table", () => {
    // HTML5's 2,231 names less its 106 legacy forms without the `;`.
    expect(HashMap.size(NAMED_ENTITIES)).toBe(2125);
    Arr.forEach(Arr.fromIterable(NAMED_ENTITIES), ([name, text]) => {
      expect(name).toMatch(/^[A-Za-z0-9]+$/);
      expect(text).toMatch(/^.{1,2}$/su); // one or two code points
      expect(stripEntities(`&${name};`)).toBe(text);
    });
  });

  // Each is a well-formed entity to the parser. Names are case-sensitive, so
  // `&Amp;` and `&NBSP;` name nothing, and a name with a non-ASCII letter is
  // read whole but is no entity. A lookup on a plain object would find the
  // inherited `Object.prototype` member and print its source.
  it.each([
    "&unknown;",
    "&Amp;",
    "&NBSP;",
    "&eacutex;",
    "&caf\u00e9;",
    "&\u05e8\u05dc;",
    "&constructor;",
    "&toString;",
    "&valueOf;",
    "&hasOwnProperty;",
  ])("keeps the unknown named entity %s as written", (src) => {
    expect(stripEntities(src)).toBe(src);
  });

  // MediaWiki matches a name only with its `;`, so HTML5's legacy forms
  // without it (`&eacute`, `&copy`, `&amp`) are literal text.
  it.each(["&eacute", "caf&eacute au lait", "&copy 2026", "&amp", "&AMP"])(
    "leaves %s, without the semicolon, as literal text",
    (src) => {
      const doc = parse(src);
      expect(doc.children.some(Predicate.isTagged("HtmlEntity"))).toBe(false);
      expect(stripToText(doc)).toBe(src);
    },
  );

  it.each(["&#;", "&#x;", "&#xZZ;", "&#12", "&#-5;", "&#12.5;"])(
    "leaves the malformed reference %s as literal text",
    (src) => {
      expect(stripToText(parse(src))).toBe(src);
    },
  );

  // An `HtmlEntity` built by hand rather than parsed: only a whole decimal
  // or hex reference decodes. `&x#65;` would decode to "A" if
  // `NUMERIC_ENTITY_RE` lost its `^` anchor.
  it.each(["&#12.5;", "&#x41g;", "&#+65;", "&# 65;", "&x#65;", "&__proto__;"])(
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
    expect(filter(doc, Predicate.isTagged("AutoLink"))).toHaveLength(1);
  });

  it("descends into table captions and cell content", () => {
    const doc = parse(
      "{|\n|+ has a [[Caption Link]]\n| has [[Cell Link]] and http://example.org\n|}",
    );
    const links = filter(doc, Predicate.isTagged("Wikilink"));
    expect(links).toHaveLength(2);
    expect(filter(doc, Predicate.isTagged("AutoLink"))).toHaveLength(1);
  });
});
