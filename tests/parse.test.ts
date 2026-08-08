/**
 * Structural parsing unit tests — that the parser produces the *right* tree,
 * not merely a round-trippable one. Round-trip is proven separately
 * (`roundtrip.test.ts`); here we assert node shapes, nesting, and the
 * documented fail-soft degradations.
 *
 * @module tests/parse
 */

import { describe, expect, it } from "vite-plus/test";
import {
  type Argument,
  type ExternalLink,
  type Heading,
  type Node,
  parse,
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

  it("leaves a bare ampersand as text", () => {
    const doc = parse("a & b");
    expect(doc.children.every((n) => n._tag === "Text")).toBe(true);
  });
});
