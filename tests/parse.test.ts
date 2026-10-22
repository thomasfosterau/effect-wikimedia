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
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import { describe, expect, it } from "vite-plus/test";
import {
  type Argument,
  type AutoLink,
  type ExternalLink,
  filter,
  findTemplates,
  getParam,
  type Heading,
  type Node,
  parse,
  serialize,
  serializeNode,
  stripToText,
  type Table,
  type Tag,
  type Template,
  walk,
  type Wikilink,
} from "../src/wikitext/index.ts";
import { serializeNodes } from "../src/wikitext/index.ts";

/** The single top-level node of `src`, asserted to be tag `T`. */
function only<T extends Node["_tag"]>(src: string, tag: T): Extract<Node, { _tag: T }> {
  const doc = parse(src);
  const structural = doc.children.filter(Predicate.not(Predicate.isTagged("Text")));
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
    const inner = t.params[0].value.find(Predicate.isTagged("Template")) as Template;
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
    expect(doc.children.every(Predicate.isTagged("Text"))).toBe(true);
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
    expect(doc.children.every(Predicate.isTagged("Text"))).toBe(true);
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
    expect(doc.children.every(Predicate.isTagged("Text"))).toBe(true);
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
    expect(doc.children.some(Predicate.isTagged("Heading"))).toBe(false);
  });

  it("parses links inside a title", () => {
    const h = only("== See [[also]] ==\n", "Heading") as Heading;
    expect(h.title.some(Predicate.isTagged("Wikilink"))).toBe(true);
  });
});

describe("comments", () => {
  it("parses a closed comment", () => {
    const doc = parse("a<!-- hi -->b");
    const c = doc.children.find(Predicate.isTagged("Comment"));
    expect(c).toMatchObject({ _tag: "Comment", text: " hi ", closed: true });
  });

  it("absorbs an unclosed comment to end of input", () => {
    const doc = parse("a<!-- no end");
    const c = doc.children.find(Predicate.isTagged("Comment"));
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
    expect(doc.children.filter(Predicate.isTagged("Wikilink"))).toHaveLength(0);
  });

  it("treats presentational tags as flat markers", () => {
    const doc = parse("<div>content</div>");
    const tags = doc.children.filter(Predicate.isTagged("Tag"));
    expect(tags).toHaveLength(2);
    expect(tags[0]).toMatchObject({ name: "div", closing: false });
    expect(tags[1]).toMatchObject({ name: "div", closing: true });
    expect(doc.children.some((n) => Predicate.isTagged(n, "Text") && n.text === "content")).toBe(
      true,
    );
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
    const entities = doc.children.filter(Predicate.isTagged("HtmlEntity"));
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
      expect(doc.children.every(Predicate.isTagged("Text"))).toBe(true);
    },
  );

  it("leaves a bare ampersand as text", () => {
    const doc = parse("a & b");
    expect(doc.children.every(Predicate.isTagged("Text"))).toBe(true);
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
    expect(doc.children.every(Predicate.isTagged("Text"))).toBe(true);
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
    const link = filter(doc, Predicate.isTagged("AutoLink"))[0] as AutoLink;
    expect(link.url).toBe("http://example.org");
    expect(serialize(doc)).toBe(`See http://example.org${expected} end`);
  });

  it("trims a trailing ) when the url contains no (", () => {
    const doc = parse("(http://example.org)");
    const link = filter(doc, Predicate.isTagged("AutoLink"))[0] as AutoLink;
    expect(link.url).toBe("http://example.org");
  });

  it("keeps a trailing ) when the url itself contains a (", () => {
    // MediaWiki checks for presence of `(` anywhere in the match, not paren
    // balance — both closing parens stay part of the link.
    const doc = parse("(http://en.wikipedia.org/wiki/Foo_(bar))");
    const link = filter(doc, Predicate.isTagged("AutoLink"))[0] as AutoLink;
    expect(link.url).toBe("http://en.wikipedia.org/wiki/Foo_(bar))");
  });

  it("keeps a trailing entity reference whole instead of splitting off its ;", () => {
    const doc = parse("http://example.org?x=1&amp;");
    const link = filter(doc, Predicate.isTagged("AutoLink"))[0] as AutoLink;
    expect(link.url).toBe("http://example.org?x=1&amp;");
  });

  it('stops the url body at whitespace, ], <, > and "', () => {
    expect((only("http://example.org/a b", "AutoLink") as AutoLink).url).toBe(
      "http://example.org/a",
    );
    const doc = parse("http://example.org]after");
    const link = filter(doc, Predicate.isTagged("AutoLink"))[0] as AutoLink;
    expect(link.url).toBe("http://example.org");
  });

  it("does not double-link a url already inside bracketed external link syntax", () => {
    const doc = parse("[http://example.org label]");
    expect(filter(doc, Predicate.isTagged("AutoLink"))).toHaveLength(0);
    const ext = doc.children.find(Predicate.isTagged("ExternalLink")) as ExternalLink | undefined;
    expect(ext?.url).toBe("http://example.org");
  });

  it("autolinks a bare url immediately following a bracketed link, unaffected by it", () => {
    const doc = parse("[http://a.org A] http://b.org");
    const links = filter(doc, Predicate.isTagged("AutoLink")) as AutoLink[];
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
    const link = cell.content.find(Predicate.isTagged("Wikilink")) as Wikilink;
    expect(text(link.target)).toBe("Foo");
    expect(link.segments.map(text)).toEqual(["Bar"]);
  });

  it("parses nested formatting and links inside a cell", () => {
    const t = only("{|\n| '''bold''' and [[Link]] and ''italic''\n|}", "Table") as Table;
    const content = t.rows[0].cells[0].content;
    expect(content.some(Predicate.isTagged("Formatting"))).toBe(true);
    expect(content.some(Predicate.isTagged("Wikilink"))).toBe(true);
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
    const inner = t.rows[0].cells[0].content.find(Predicate.isTagged("Table")) as Table;
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
    expect(doc.children.every(Predicate.isTagged("Text"))).toBe(true);
  });

  it("does not recognise {| outside block level (e.g. inside a template parameter)", () => {
    const src = "{{t|{|\nnot a table\n|end}}";
    const doc = parse(src);
    expect(filter(doc, Predicate.isTagged("Table"))).toHaveLength(0);
    expect(serialize(doc)).toBe(src);
  });

  it("round-trips byte-identically with rows, inline cells, and a caption", () => {
    const src =
      '{| class="wikitable"\n|+ Caption\n! A !! B\n|-\n| 1 || style="x" | 2\n|-\n| 3\n| 4\n|}';
    expect(serialize(parse(src))).toBe(src);
  });
});

describe("wikitables: nested constructs in cells and captions (#132)", () => {
  /** The table `src` parses to, after checking it round-trips and every node's span is its own slice. */
  function table(src: string): Table {
    const doc = parse(src);
    expect(serialize(doc)).toBe(src);
    walk(doc, (n) => {
      expect(serializeNode(n), `${n._tag} @ ${n.span.start}`).toBe(
        src.slice(n.span.start, n.span.end),
      );
    });
    return only(src, "Table") as Table;
  }

  const names = (nodes: readonly Node[]): string[] =>
    findTemplates(nodes).map((t) => text(t.name).trim());

  it("keeps a template's own pipe out of the attribute split (the issue's example)", () => {
    const doc = parse("{|\n| {{flag|France}}\n|}");
    const cell = (only("{|\n| {{flag|France}}\n|}", "Table") as Table).rows[0].cells[0];
    expect(cell.attrs).toBeUndefined();
    expect(text(cell.content)).toBe(" {{flag|France}}\n");
    expect(names(cell.content)).toEqual(["flag"]);
    expect(findTemplates(doc)).toHaveLength(1);
    expect(stripToText(doc)).toBe(" \n");
  });

  it("(A) keeps a citation in a cell whole, with and without attributes", () => {
    const bare = table("{|\n| Paris<ref>{{cite web|url=x}}</ref> {{efn|a=b}}\n|}").rows[0].cells[0];
    expect(bare.attrs).toBeUndefined();
    const ref = bare.content.find(Predicate.isTagged("Tag")) as Tag;
    expect(ref).toMatchObject({ name: "ref", rawContent: "{{cite web|url=x}}" });
    expect(names(bare.content)).toEqual(["efn"]);
    expect(stripToText(bare.content)).toBe(" Paris \n");

    const withAttrs = table('{|\n| style="x" | Paris<ref>{{cite web|url=x}}</ref>\n|}').rows[0]
      .cells[0];
    expect(withAttrs.attrs).toBe(' style="x" ');
    expect(text(withAttrs.content)).toBe(" Paris<ref>{{cite web|url=x}}</ref>\n");
  });

  it("(B) keeps a template in an inline cell whole", () => {
    const cells = table("{|\n| a || {{flagicon|FRA}} b\n|}").rows[0].cells;
    expect(cells).toHaveLength(2);
    expect(cells[1]).toMatchObject({ inline: true, attrs: undefined });
    const [flag] = findTemplates(cells[1].content, "flagicon");
    expect(getParam(flag, 1)).toBe("FRA");
    expect(stripToText(cells[1].content)).toBe("  b\n");
  });

  it("(C) doesn't read a template's empty parameter as a cell separator", () => {
    const cells = table("{|\n| {{x||y}} || z\n|}").rows[0].cells;
    expect(cells.map((c) => text(c.content))).toEqual([" {{x||y}} ", " z\n"]);
    const [x] = findTemplates(cells[0].content, "x");
    expect(x.params.map((p) => text(p.value))).toEqual(["", "y"]);
  });

  it("(D) doesn't read a line inside a multi-line template as a new cell", () => {
    const t = table("{|\n| {{Infobox\n|a=b\n|c=d\n}}\n| next\n|}");
    expect(t.rows).toHaveLength(1);
    const [first, second] = t.rows[0].cells;
    expect(t.rows[0].cells).toHaveLength(2);
    expect(first.attrs).toBeUndefined();
    const [infobox] = findTemplates(first.content, "Infobox");
    expect(getParam(infobox, "a")).toBe("b");
    expect(getParam(infobox, "c")).toBe("d");
    expect(text(second.content)).toBe(" next\n");
  });

  it("(D) doesn't read a |- or |} line inside a multi-line template as table structure", () => {
    const t = table("{|\n| {{a\n|-\n|}}\n|}");
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0].cells).toHaveLength(1);
    expect(names(t.rows[0].cells[0].content)).toEqual(["a"]);
  });

  it("splits header cells on !! and attributes on | outside templates", () => {
    const cells = table('{|\n! scope="col" | {{abbr|A|Alpha}} !! {{abbr|B|Beta}}\n|}').rows[0]
      .cells;
    expect(cells.map((c) => [c.header, c.inline, c.attrs])).toEqual([
      [true, false, ' scope="col" '],
      [true, true, undefined],
    ]);
    expect(names(cells[0].content)).toEqual(["abbr"]);
    expect(names(cells[1].content)).toEqual(["abbr"]);
  });

  it("doesn't split a header cell on a template parameter that starts with !", () => {
    const cells = table("{|\n! {{x|!!y}}\n|}").rows[0].cells;
    expect(cells).toHaveLength(1);
    expect(names(cells[0].content)).toEqual(["x"]);
  });

  it("keeps a template in a caption whole, with and without attributes", () => {
    const bare = table("{|\n|+ {{flag|France}} results\n| a\n|}").captions[0];
    expect(bare.attrs).toBeUndefined();
    expect(names(bare.content)).toEqual(["flag"]);
    const withAttrs = table('{|\n|+ style="x" | {{a|b}}\n| a\n|}').captions[0];
    expect(withAttrs.attrs).toBe(' style="x" ');
    expect(names(withAttrs.content)).toEqual(["a"]);
  });

  it("steps over arguments, wikilinks, comments and extension tags in every scan", () => {
    const cells = table(
      "{|\n| {{{1|a||b}}} [[A||B]] <!-- x || y\n| z --> <nowiki>||\n|</nowiki> <ref name=a/> || w\n|}",
    ).rows[0].cells;
    expect(cells).toHaveLength(2);
    expect(cells[0].attrs).toBeUndefined();
    expect(cells[0].content.map((n) => n._tag)).toEqual(
      expect.arrayContaining(["Argument", "Wikilink", "Comment", "Tag"]),
    );
    expect(text(cells[1].content)).toBe(" w\n");
  });

  it("keeps the [[ guard: a wikilink before the first pipe means there are no attributes", () => {
    const cell = table("{|\n| [[A]] | b\n|}").rows[0].cells[0];
    expect(cell.attrs).toBeUndefined();
    expect(text(cell.content)).toBe(" [[A]] | b\n");
  });

  it("puts a template written in the attributes into attrs", () => {
    const cell = table('{|\n| style="{{x|y}}" | b\n|}').rows[0].cells[0];
    expect(cell.attrs).toBe(' style="{{x|y}}" ');
    expect(text(cell.content)).toBe(" b\n");
  });

  it("finds every template across a table's cells and captions", () => {
    const doc = parse(
      "{|\n|+ {{cap|1}}\n! {{h|a}} !! {{h|b}}\n|-\n| {{x||y}} || {{flagicon|FRA}}\n| {{Infobox\n|a=b\n}}\n|}",
    );
    expect(findTemplates(doc).map((t) => text(t.name).trim())).toEqual([
      "cap",
      "h",
      "h",
      "x",
      "flagicon",
      "Infobox",
    ]);
    expect(stripToText(doc)).not.toMatch(/[|}=]/);
  });

  it("matches unbalanced brackets as the rest of the parser does", () => {
    // A closer matches the nearest opener of its kind; an opener of the other
    // kind left open inside it stays literal, as recursive descent leaves it.
    const cells = (src: string) => table(src).rows[0].cells;
    const [braces] = cells("{|\n| {{a|[[b}} || c\n|}");
    expect(braces.attrs).toBeUndefined();
    expect(names(braces.content)).toEqual(["a"]);
    const [link] = cells("{|\n| [[a|{{b]] || c\n|}");
    expect(link.attrs).toBeUndefined();
    expect(link.content.some(Predicate.isTagged("Wikilink"))).toBe(true);
    // Three braces closed by two: the first is literal, the rest a template.
    const [three] = cells("{|\n| {{{a|b}} || c\n|}");
    expect(three.attrs).toBeUndefined();
    expect(text(three.content)).toBe(" {{{a|b}} ");
    // A single `}` or `]` closes nothing.
    expect(cells("{|\n| {{a|b} || c\n|}").map((c) => c.attrs)).toEqual([" {{a", undefined]);
    // Five braces closed by five: an argument inside a template.
    const [five] = cells("{|\n| {{{{{a|b}}}}} || c\n|}");
    expect(five.attrs).toBeUndefined();
    expect(text(five.content)).toBe(" {{{{{a|b}}}}} ");
  });

  it("treats an unclosed {{, [[, <!-- or <ref> as literal text without swallowing the table", () => {
    Arr.forEach(["{{", "{{{", "[[", "<!--", "<ref>"], (open) => {
      const src = `{|\n| ${open}stray\n| b || {{t|c}}\n|-\n| d\n|}\nafter`;
      const t = table(src);
      expect(
        t.rows.map((r) => r.cells.length),
        open,
      ).toEqual([3, 1]);
      expect(t.rows[0].cells[2].attrs, open).toBeUndefined();
      expect(names(t.rows[0].cells[2].content), open).toEqual(["t"]);
      expect(text(t.rows[1].cells[0].content), open).toBe(" d\n");
    });
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
    expect(
      filter(doc, Predicate.or(Predicate.isTagged("Table"), Predicate.isTagged("AutoLink"))),
    ).toHaveLength(0);
  });

  it("does not mistake ordinary prose words starting with h/H for a url", () => {
    const src = "History, Hello, high hopes, and Http (no protocol) stay ordinary text.";
    const doc = parse(src);
    expect(filter(doc, Predicate.isTagged("AutoLink"))).toHaveLength(0);
    expect(serialize(doc)).toBe(src);
  });

  it("does not mistake a template/argument/link kitchen sink for table syntax", () => {
    const src =
      "{{Infobox|a|b=c}} {{{arg|def}}} [[Wikilink|label]] [https://example.org ext] " +
      "== Heading ==\n'''bold''' ''italic'' <ref>cite</ref> &nbsp; <!-- c -->";
    const doc = parse(src);
    expect(
      filter(doc, Predicate.or(Predicate.isTagged("Table"), Predicate.isTagged("AutoLink"))),
    ).toHaveLength(0);
    expect(serialize(doc)).toBe(src);
  });
});
