/**
 * Structural parsing unit tests — that the parser produces the *right* tree,
 * not merely a round-trippable one. Round-trip is proven separately
 * (`roundtrip.test.ts`); here we assert node shapes, nesting, and the
 * documented fail-soft degradations.
 *
 * @module tests/parse
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
  type Argument,
  type AutoLink,
  type ExternalLink,
  filter,
  type Heading,
  type Node,
  parse,
  serialize,
  type Table,
  type Tag,
  type Template,
  type Wikilink,
} from "../src/wikitext/index.ts";
import { serializeNodes } from "../src/wikitext/index.ts";

/** The single top-level node of `src`, asserted to be tag `T`. */
function only<T extends Node["_tag"]>(src: string, tag: T): Extract<Node, { _tag: T }> {
  const doc = parse(src);
  const structural = doc.children.filter((n) => n._tag !== "Text");
  expect(structural.length, `expected one ${tag}`).toBe(1);
  expect(structural[0]._tag).toBe(tag);
  return structural[0] as Extract<Node, { _tag: T }>;
}

const text = (nodes: readonly Node[]): string => serializeNodes(nodes);

describe("templates", () => {
  it("parses name and positional + named params", () => {
    const t = only("{{Infobox|a|b|key=value}}", "Template") as Template;
    expect(text(t.name)).toBe("Infobox");
    expect(t.params).toHaveLength(3);
    expect(t.params[0].name).toBeUndefined();
    expect(text(t.params[0].value)).toBe("a");
    expect(text(t.params[1].value)).toBe("b");
    expect(t.params[2].name && text(t.params[2].name)).toBe("key");
    expect(text(t.params[2].value)).toBe("value");
  });

  it("splits a param on the first equals only", () => {
    const t = only("{{t|k=a=b}}", "Template") as Template;
    expect(t.params[0].name && text(t.params[0].name)).toBe("k");
    expect(text(t.params[0].value)).toBe("a=b");
  });

  it("keeps whitespace inside name/value (not on the separators)", () => {
    const t = only("{{ t | k = v }}", "Template") as Template;
    expect(text(t.name)).toBe(" t ");
    expect(t.params[0].name && text(t.params[0].name)).toBe(" k ");
    expect(text(t.params[0].value)).toBe(" v ");
  });

  it("nests templates in a parameter value", () => {
    const t = only("{{outer|x={{inner|y}}}}", "Template") as Template;
    const inner = t.params[0].value.find((n) => n._tag === "Template") as Template;
    expect(inner).toBeDefined();
    expect(text(inner.name)).toBe("inner");
  });

  it("parses parser functions structurally without evaluating", () => {
    const t = only("{{#if:{{{x|}}}|yes|no}}", "Template") as Template;
    expect(text(t.name)).toBe("#if:{{{x|}}}");
    expect(text(t.params[0].value)).toBe("yes");
    expect(text(t.params[1].value)).toBe("no");
  });

  it("degrades an unclosed template to text", () => {
    const doc = parse("{{foo|bar");
    expect(doc.children.every((n) => n._tag === "Text")).toBe(true);
  });
});

describe("arguments (triple brace)", () => {
  it("parses name and default", () => {
    const a = only("{{{name|fallback}}}", "Argument") as Argument;
    expect(text(a.name)).toBe("name");
    expect(a.default && text(a.default)).toBe("fallback");
  });

  it("has no default when the pipe is absent", () => {
    const a = only("{{{1}}}", "Argument") as Argument;
    expect(text(a.name)).toBe("1");
    expect(a.default).toBeUndefined();
  });
});

describe("wikilinks", () => {
  it("parses a bare target", () => {
    const w = only("[[London]]", "Wikilink") as Wikilink;
    expect(text(w.target)).toBe("London");
    expect(w.segments).toHaveLength(0);
  });

  it("parses target and label", () => {
    const w = only("[[London|the capital]]", "Wikilink") as Wikilink;
    expect(text(w.target)).toBe("London");
    expect(w.segments.map(text)).toEqual(["the capital"]);
  });

  it("keeps every pipe segment for file links", () => {
    const w = only("[[File:X.png|thumb|right|caption]]", "Wikilink") as Wikilink;
    expect(text(w.target)).toBe("File:X.png");
    expect(w.segments.map(text)).toEqual(["thumb", "right", "caption"]);
  });

  it("degrades an unclosed wikilink to text", () => {
    const doc = parse("[[London");
    expect(doc.children.every((n) => n._tag === "Text")).toBe(true);
  });
});

describe("external links", () => {
  it("parses url and label", () => {
    const e = only("[https://example.org Example]", "ExternalLink") as ExternalLink;
    expect(e.url).toBe("https://example.org");
    expect(e.label && text(e.label)).toBe(" Example");
  });

  it("parses a bare bracketed url", () => {
    const e = only("[https://example.org]", "ExternalLink") as ExternalLink;
    expect(e.url).toBe("https://example.org");
    expect(e.label).toBeUndefined();
  });

  it("leaves a non-url bracket as text", () => {
    const doc = parse("[not a link]");
    expect(doc.children.every((n) => n._tag === "Text")).toBe(true);
  });
});

describe("headings", () => {
  it("parses level and title", () => {
    const h = only("== Biography ==\n", "Heading") as Heading;
    expect(h.level).toBe(2);
    expect(text(h.title)).toBe(" Biography ");
  });

  it("takes level from the shorter equals run and keeps the surplus raw", () => {
    const h = only("=== Title ==\n", "Heading") as Heading;
    expect(h.level).toBe(2);
    expect(h.leftEquals).toBe("===");
    expect(h.rightEquals).toBe("==");
  });

  it("is not a heading when text follows the closing run on the line", () => {
    const doc = parse("== x == trailing\n");
    expect(doc.children.some((n) => n._tag === "Heading")).toBe(false);
  });

  it("parses links inside a title", () => {
    const h = only("== See [[also]] ==\n", "Heading") as Heading;
    expect(h.title.some((n) => n._tag === "Wikilink")).toBe(true);
  });
});

describe("comments", () => {
  it("parses a closed comment", () => {
    const doc = parse("a<!-- hi -->b");
    const c = doc.children.find((n) => n._tag === "Comment");
    expect(c).toMatchObject({ _tag: "Comment", text: " hi ", closed: true });
  });

  it("absorbs an unclosed comment to end of input", () => {
    const doc = parse("a<!-- no end");
    const c = doc.children.find((n) => n._tag === "Comment");
    expect(c).toMatchObject({ _tag: "Comment", text: " no end", closed: false });
  });
});

describe("tags", () => {
  it("captures an extension tag body raw", () => {
    const t = only("<ref>{{cite|x}} '''kept'''</ref>", "Tag") as Tag;
    expect(t.name).toBe("ref");
    expect(t.rawContent).toBe("{{cite|x}} '''kept'''");
    expect(t.closeRaw).toBe("</ref>");
  });

  it("does not parse the raw body of an extension tag as wikitext", () => {
    const doc = parse("<nowiki>[[not a link]]</nowiki>");
    expect(doc.children.filter((n) => n._tag === "Wikilink")).toHaveLength(0);
  });

  it("treats presentational tags as flat markers", () => {
    const doc = parse("<div>content</div>");
    const tags = doc.children.filter((n): n is Tag => n._tag === "Tag");
    expect(tags).toHaveLength(2);
    expect(tags[0]).toMatchObject({ name: "div", closing: false });
    expect(tags[1]).toMatchObject({ name: "div", closing: true });
    expect(doc.children.some((n) => n._tag === "Text" && n.text === "content")).toBe(true);
  });

  it("parses a self-closing tag", () => {
    const t = only("<br/>", "Tag") as Tag;
    expect(t).toMatchObject({ name: "br", selfClosing: true });
  });

  it("keeps a quoted attribute containing '>' inside the tag", () => {
    const t = only('<span title="a>b">', "Tag") as Tag;
    expect(t.raw).toBe('<span title="a>b">');
  });

  it("degrades an unclosed extension tag to an open-only marker", () => {
    const t = only("<ref>citation with no close", "Tag") as Tag;
    expect(t).toMatchObject({ name: "ref", rawContent: undefined, closeRaw: undefined });
  });
});

describe("html entities", () => {
  it("parses named, decimal, and hex entities", () => {
    const doc = parse("&nbsp;&#160;&#x1F600;");
    const entities = doc.children.filter((n) => n._tag === "HtmlEntity");
    expect(entities.map((e) => (e as { raw: string }).raw)).toEqual([
      "&nbsp;",
      "&#160;",
      "&#x1F600;",
    ]);
  });

  // MediaWiki's `CHAR_REFS_REGEX` reads a name as ASCII letters and digits or
  // any non-ASCII character, so its Hebrew and Arabic aliases for `&rlm;`
  // are entities (#118).
  it("parses a named entity whose name has non-ASCII letters", () => {
    const doc = parse("a&רלמ;b&café;c");
    expect(doc.children.map((n) => [n._tag, serializeNodes([n])])).toEqual([
      ["Text", "a"],
      ["HtmlEntity", "&רלמ;"],
      ["Text", "b"],
      ["HtmlEntity", "&café;"],
      ["Text", "c"],
    ]);
  });

  it.each(["&é b", "&café", "&_x;", "&a-b;"])(
    "leaves %s, which is no well-formed named entity, as text",
    (src) => {
      const doc = parse(src);
      expect(doc.children.every((n) => n._tag === "Text")).toBe(true);
    },
  );

  it("leaves a bare ampersand as text", () => {
    const doc = parse("a & b");
    expect(doc.children.every((n) => n._tag === "Text")).toBe(true);
  });
});

describe("bare url autolinking (issue #1287)", () => {
  it("recognises a bare http(s) url in running text", () => {
    const l = only("See http://example.org for details.", "AutoLink") as AutoLink;
    expect(l.url).toBe("http://example.org");
  });

  it("is case-insensitive on the protocol", () => {
    expect((only("HTTPS://Example.org", "AutoLink") as AutoLink).url).toBe("HTTPS://Example.org");
  });

  it("does not link a lone protocol with nothing after it", () => {
    const doc = parse("http:// nope");
    expect(doc.children.every((n) => n._tag === "Text")).toBe(true);
  });

  it.each([
    [".", "."],
    [",", ","],
    [";", ";"],
    [":", ":"],
    ["!", "!"],
    ["?", "?"],
    ["!?!.", "!?!."],
  ])("trims trailing terminal punctuation %s off the link", (trail, expected) => {
    const doc = parse(`See http://example.org${trail} end`);
    const link = filter(doc, (n) => n._tag === "AutoLink")[0] as AutoLink;
    expect(link.url).toBe("http://example.org");
    expect(serialize(doc)).toBe(`See http://example.org${expected} end`);
  });

  it("trims a trailing ) when the url contains no (", () => {
    const doc = parse("(http://example.org)");
    const link = filter(doc, (n) => n._tag === "AutoLink")[0] as AutoLink;
    expect(link.url).toBe("http://example.org");
  });

  it("keeps a trailing ) when the url itself contains a (", () => {
    // MediaWiki checks for presence of `(` anywhere in the match, not paren
    // balance — both closing parens stay part of the link.
    const doc = parse("(http://en.wikipedia.org/wiki/Foo_(bar))");
    const link = filter(doc, (n) => n._tag === "AutoLink")[0] as AutoLink;
    expect(link.url).toBe("http://en.wikipedia.org/wiki/Foo_(bar))");
  });

  it("keeps a trailing entity reference whole instead of splitting off its ;", () => {
    const doc = parse("http://example.org?x=1&amp;");
    const link = filter(doc, (n) => n._tag === "AutoLink")[0] as AutoLink;
    expect(link.url).toBe("http://example.org?x=1&amp;");
  });

  it('stops the url body at whitespace, ], <, > and "', () => {
    expect((only("http://example.org/a b", "AutoLink") as AutoLink).url).toBe(
      "http://example.org/a",
    );
    const doc = parse("http://example.org]after");
    const link = filter(doc, (n) => n._tag === "AutoLink")[0] as AutoLink;
    expect(link.url).toBe("http://example.org");
  });

  it("does not double-link a url already inside bracketed external link syntax", () => {
    const doc = parse("[http://example.org label]");
    expect(filter(doc, (n) => n._tag === "AutoLink")).toHaveLength(0);
    const ext = doc.children.find((n) => n._tag === "ExternalLink") as ExternalLink | undefined;
    expect(ext?.url).toBe("http://example.org");
  });

  it("autolinks a bare url immediately following a bracketed link, unaffected by it", () => {
    const doc = parse("[http://a.org A] http://b.org");
    const links = filter(doc, (n) => n._tag === "AutoLink") as AutoLink[];
    expect(links.map((l) => l.url)).toEqual(["http://b.org"]);
  });

  it("round-trips byte-identically with the link included", () => {
    const src = "Prose http://example.org/path?q=1 more prose.";
    expect(serialize(parse(src))).toBe(src);
  });
});

describe("wikitables (issue #1287)", () => {
  it("parses a minimal table with an implicit first row", () => {
    const t = only("{|\n| a\n|}", "Table") as Table;
    expect(t.open).toBe("\n");
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0].open).toBeUndefined();
    expect(t.rows[0].cells).toHaveLength(1);
    expect(t.rows[0].cells[0]).toMatchObject({ header: false, inline: false });
    expect(text(t.rows[0].cells[0].content)).toBe(" a\n");
  });

  it("distinguishes an explicit |- row (open defined) from the implicit first row", () => {
    const t = only('{|\n| a\n|- style="x"\n| b\n|}', "Table") as Table;
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0].open).toBeUndefined();
    expect(t.rows[1].open).toBe(' style="x"\n');
  });

  it("parses header cells and keeps table attributes verbatim", () => {
    const t = only('{| class="wikitable"\n! Name\n! Age\n|}', "Table") as Table;
    expect(t.open).toBe(' class="wikitable"\n');
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0].cells.map((c) => c.header)).toEqual([true, true]);
    expect(t.rows[0].cells.map((c) => text(c.content))).toEqual([" Name\n", " Age\n"]);
  });

  it("splits inline cells on || / !! and marks them inline", () => {
    const t = only("{|\n! A !! B\n|-\n| 1 || 2\n|}", "Table") as Table;
    const [headerRow, dataRow] = t.rows;
    expect(headerRow.cells.map((c) => c.inline)).toEqual([false, true]);
    expect(headerRow.cells.map((c) => text(c.content))).toEqual([" A ", " B\n"]);
    expect(dataRow.cells.map((c) => c.inline)).toEqual([false, true]);
    expect(dataRow.cells.map((c) => text(c.content))).toEqual([" 1 ", " 2\n"]);
  });

  it("splits a cell's leading attributes from its content on the single pipe", () => {
    const t = only('{|\n| style="color:red" | content\n|}', "Table") as Table;
    const cell = t.rows[0].cells[0];
    expect(cell.attrs).toBe(' style="color:red" ');
    expect(text(cell.content)).toBe(" content\n");
  });

  it("does not split attrs when there is no pipe at all", () => {
    const t = only("{|\n| just content\n|}", "Table") as Table;
    expect(t.rows[0].cells[0].attrs).toBeUndefined();
  });

  it("does not misread a wikilink's own pipe as the attrs separator", () => {
    // The documented `Parser::doTableStuff` guard: reject the attrs split
    // when the text before the pipe contains `[[`.
    const t = only("{|\n| [[Foo|Bar]]\n|}", "Table") as Table;
    const cell = t.rows[0].cells[0];
    expect(cell.attrs).toBeUndefined();
    const link = cell.content.find((n) => n._tag === "Wikilink") as Wikilink;
    expect(text(link.target)).toBe("Foo");
    expect(link.segments.map(text)).toEqual(["Bar"]);
  });

  it("parses nested formatting and links inside a cell", () => {
    const t = only("{|\n| '''bold''' and [[Link]] and ''italic''\n|}", "Table") as Table;
    const content = t.rows[0].cells[0].content;
    expect(content.some((n) => n._tag === "Formatting")).toBe(true);
    expect(content.some((n) => n._tag === "Wikilink")).toBe(true);
  });

  it("parses a caption with attributes, split the same way as cells", () => {
    const t = only('{|\n|+ style="text-align:left" | The caption\n| a\n|}', "Table") as Table;
    expect(t.captions).toHaveLength(1);
    expect(t.captions[0].attrs).toBe(' style="text-align:left" ');
    expect(text(t.captions[0].content)).toBe(" The caption\n");
  });

  it("extends a cell's content across continuation lines up to the next marker", () => {
    const t = only("{|\n| line one\nline two\n|-\n| next\n|}", "Table") as Table;
    expect(text(t.rows[0].cells[0].content)).toBe(" line one\nline two\n");
  });

  it("parses a nested table inside a cell without confusing its markers for the outer table's", () => {
    const src = "{|\n| outer\n{|\n| inner\n|}\nmore\n|}";
    const t = only(src, "Table") as Table;
    expect(t.rows).toHaveLength(1);
    const inner = t.rows[0].cells[0].content.find((n) => n._tag === "Table") as Table;
    expect(inner).toBeDefined();
    expect(text(inner.rows[0].cells[0].content)).toBe(" inner\n");
  });

  it("treats a |- line as a row marker even where it looks like a negative number", () => {
    const t = only("{|\n| a\n|-5\n|}", "Table") as Table;
    expect(t.rows).toHaveLength(2);
    expect(t.rows[1].open).toBe("5\n");
    expect(t.rows[1].cells).toHaveLength(0);
  });

  it("degrades an unclosed table to text", () => {
    const doc = parse("{|\nrow without a close");
    expect(doc.children.every((n) => n._tag === "Text")).toBe(true);
  });

  it("does not recognise {| outside block level (e.g. inside a template parameter)", () => {
    const src = "{{t|{|\nnot a table\n|end}}";
    const doc = parse(src);
    expect(filter(doc, (n) => n._tag === "Table")).toHaveLength(0);
    expect(serialize(doc)).toBe(src);
  });

  it("round-trips byte-identically with rows, inline cells, and a caption", () => {
    const src =
      '{| class="wikitable"\n|+ Caption\n! A !! B\n|-\n| 1 || style="x" | 2\n|-\n| 3\n| 4\n|}';
    expect(serialize(parse(src))).toBe(src);
  });
});

describe("regression: existing vocabulary is unaffected by tables/autolink (issue #1287)", () => {
  const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));
  const ada = readFileSync(`${fixturesDir}ada-lovelace.txt`, "utf8");

  it("still round-trips a real article with no tables or bare urls, byte-identically", () => {
    expect(serialize(parse(ada))).toBe(ada);
  });

  it("introduces no Table or AutoLink nodes into content that has neither", () => {
    const doc = parse(ada);
    expect(filter(doc, (n) => n._tag === "Table" || n._tag === "AutoLink")).toHaveLength(0);
  });

  it("does not mistake ordinary prose words starting with h/H for a url", () => {
    const src = "History, Hello, high hopes, and Http (no protocol) stay ordinary text.";
    const doc = parse(src);
    expect(filter(doc, (n) => n._tag === "AutoLink")).toHaveLength(0);
    expect(serialize(doc)).toBe(src);
  });

  it("does not mistake a template/argument/link kitchen sink for table syntax", () => {
    const src =
      "{{Infobox|a|b=c}} {{{arg|def}}} [[Wikilink|label]] [https://example.org ext] " +
      "== Heading ==\n'''bold''' ''italic'' <ref>cite</ref> &nbsp; <!-- c -->";
    const doc = parse(src);
    expect(filter(doc, (n) => n._tag === "Table" || n._tag === "AutoLink")).toHaveLength(0);
    expect(serialize(doc)).toBe(src);
  });
});
