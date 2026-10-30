/**
 * The section view (#209): the heading tree over a parsed document, its
 * MediaWiki nesting and numbering (in-table headings included), and the
 * lossless partition back to the AST.
 *
 * @module tests/sections
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { describe, expect, it } from "vite-plus/test";
import {
  type Document,
  filter,
  type Node,
  parse,
  type Section,
  sections,
  serialize,
  serializeNodes,
} from "../src/wikitext/index.ts";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

/** A section's heading (when it has one) followed by its own nodes. */
const ownNodes = (s: Section): readonly Node[] =>
  Option.match(s.heading, { onNone: () => s.nodes, onSome: (h) => [h, ...s.nodes] });

const slice = (doc: Document, span: { start: number; end: number }): string =>
  doc.source.slice(span.start, span.end);

/** The invariants every section list holds against its document. */
function expectLossless(doc: Document): readonly Section[] {
  const all = sections(doc);
  const topLevel = all.filter((s) => Option.isNone(s.table));
  expect(topLevel.flatMap(ownNodes)).toEqual(doc.children);
  expect(topLevel.map((s) => serializeNodes(ownNodes(s))).join("")).toBe(serialize(doc));
  Arr.forEach(all, (s) => {
    expect(slice(doc, s.span)).toBe(serializeNodes(ownNodes(s)));
    expect(s.fullSpan.start).toBe(s.span.start);
    Arr.forEach(s.children, (child) => {
      expect(all[child].parent).toEqual(Option.some(s.index));
      expect(all[child].fullSpan.end).toBeLessThanOrEqual(s.fullSpan.end);
    });
  });
  // The numbering counts every heading the parser built, at any depth.
  const headings = filter(doc, (node) => Predicate.isTagged(node, "Heading"));
  expect(all.slice(1).map((s) => Option.getOrUndefined(s.heading))).toEqual(headings);
  expect(all[0].span.start).toBe(0);
  expect(topLevel[topLevel.length - 1].span.end).toBe(doc.source.length);
  return all;
}

const outline = (all: readonly Section[]) =>
  all.map(({ index, level, title, parent, children, table }) => ({
    index,
    level,
    title: Option.getOrUndefined(title),
    parent: Option.getOrUndefined(parent),
    children,
    inTable: Option.isSome(table),
  }));

describe("sections", () => {
  it("always has a lead, even for an empty page", () => {
    const all = sections(parse(""));
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual({
      index: 0,
      heading: Option.none(),
      level: 0,
      title: Option.none(),
      parent: Option.none(),
      children: [],
      table: Option.none(),
      nodes: [],
      span: { start: 0, end: 0 },
      fullSpan: { start: 0, end: 0 },
    });
  });

  it("gives a heading-free page one lead section holding every node", () => {
    const doc = parse("Just '''prose''' and a [[link]].\n");
    const all = expectLossless(doc);
    expect(all).toHaveLength(1);
    expect(all[0].nodes).toEqual(doc.children);
    expect(all[0].span).toEqual({ start: 0, end: doc.source.length });
    expect(all[0].fullSpan).toEqual(all[0].span);
  });

  it("gives an empty lead to a page that opens on a heading", () => {
    const doc = parse("== A ==\nbody\n");
    const [lead, a] = sections(doc);
    expect(lead.nodes).toEqual([]);
    expect(lead.span).toEqual({ start: 0, end: 0 });
    expect(Option.getOrUndefined(a.heading)).toBe(doc.children[0]);
    expect(serializeNodes(a.nodes)).toBe("\nbody\n");
  });

  it("nests by MediaWiki's rule, level jumps and shallower restarts included", () => {
    const doc = parse(
      [
        "lead",
        "== A ==",
        "a",
        "==== A.1 ====",
        "x",
        "=== A.2 ===",
        "== B ==",
        "= C =",
        "== C.1 ==",
      ].join("\n"),
    );
    expect(outline(expectLossless(doc))).toEqual([
      { index: 0, level: 0, title: undefined, parent: undefined, children: [], inTable: false },
      { index: 1, level: 2, title: "A", parent: undefined, children: [2, 3], inTable: false },
      { index: 2, level: 4, title: "A.1", parent: 1, children: [], inTable: false },
      { index: 3, level: 3, title: "A.2", parent: 1, children: [], inTable: false },
      { index: 4, level: 2, title: "B", parent: undefined, children: [], inTable: false },
      { index: 5, level: 1, title: "C", parent: undefined, children: [6], inTable: false },
      { index: 6, level: 2, title: "C.1", parent: 5, children: [], inTable: false },
    ]);
  });

  it("gives fullSpan the text action=edit&section=N replaces", () => {
    const doc = parse("== A ==\na\n=== A.1 ===\nx\n== B ==\nb");
    const [lead, a, a1, b] = expectLossless(doc);
    expect(slice(doc, lead.fullSpan)).toBe("");
    expect(slice(doc, a.span)).toBe("== A ==\na\n");
    expect(slice(doc, a.fullSpan)).toBe("== A ==\na\n=== A.1 ===\nx\n");
    expect(slice(doc, a1.fullSpan)).toBe("=== A.1 ===\nx\n");
    expect(slice(doc, b.fullSpan)).toBe("== B ==\nb");
  });

  it("reads the title as trimmed plain text and keeps the heading node", () => {
    const doc = parse("== [[Ada Lovelace|Ada]] &amp; {{lang|fr|x}} '''life''' ==\n");
    const [, s] = sections(doc);
    expect(s.title).toEqual(Option.some("Ada &  life"));
    expect(Option.getOrUndefined(s.heading)).toBe(doc.children[0]);
    expect(s.level).toBe(2);
  });

  it("passes its options to stripToText for the title", () => {
    const doc = parse("== {{lang|fr|Bonjour}} ==\n");
    const [, s] = sections(doc, { templates: { lang: () => "Bonjour" } });
    expect(s.title).toEqual(Option.some("Bonjour"));
  });

  it("keeps the surplus equals of an unbalanced heading in the title", () => {
    const [, s] = sections(parse("=== Surplus ==\n"));
    expect(s.level).toBe(2);
    expect(s.title).toEqual(Option.some("= Surplus"));
  });

  it("does not see a heading inside a template parameter", () => {
    const all = sections(parse("{{Box|\n== Not a heading ==\n}}\n"));
    expect(all).toHaveLength(1);
  });

  it("holds the document's own node objects", () => {
    const doc = parse("lead\n== A ==\nbody [[x]]\n");
    const [lead, a] = sections(doc);
    expect(lead.nodes[0]).toBe(doc.children[0]);
    expect(a.nodes.at(-1)).toBe(doc.children.at(-1));
  });

  describe("headings inside table cells", () => {
    const source = [
      "== A ==",
      "{|",
      "|",
      "=== In a cell ===",
      "x",
      "|-",
      "|",
      "== Also in a cell ==",
      "y",
      "|}",
      "== B ==",
      "b",
    ].join("\n");
    const doc = parse(source);
    const table = doc.children.find((node) => Predicate.isTagged(node, "Table"));

    it("counts them in MediaWiki's numbering and nesting", () => {
      expect(outline(expectLossless(doc))).toEqual([
        { index: 0, level: 0, title: undefined, parent: undefined, children: [], inTable: false },
        { index: 1, level: 2, title: "A", parent: undefined, children: [2], inTable: false },
        { index: 2, level: 3, title: "In a cell", parent: 1, children: [], inTable: true },
        {
          index: 3,
          level: 2,
          title: "Also in a cell",
          parent: undefined,
          children: [],
          inTable: true,
        },
        { index: 4, level: 2, title: "B", parent: undefined, children: [], inTable: false },
      ]);
    });

    it("leaves the table whole in its section and points the in-table sections at it", () => {
      const [, a, inCell, alsoInCell, b] = sections(doc);
      expect(a.nodes).toContain(table);
      expect(inCell.table).toEqual(Option.some(table));
      expect(Option.getOrUndefined(inCell.table)).toBe(table);
      expect(inCell.nodes).toEqual([]);
      expect(slice(doc, inCell.span)).toBe("=== In a cell ===");
      expect(slice(doc, alsoInCell.span)).toBe("== Also in a cell ==");
      expect(slice(doc, a.span)).toBe(source.slice(0, source.indexOf("== B ==")));
      expect(slice(doc, b.span)).toBe("== B ==\nb");
    });

    it("gives fullSpan MediaWiki's text-level edit range, cutting into the table", () => {
      const [lead, a, inCell, alsoInCell, b] = sections(doc);
      expect(slice(doc, lead.fullSpan)).toBe("");
      expect(slice(doc, a.fullSpan)).toBe(source.slice(0, source.indexOf("== Also")));
      expect(slice(doc, inCell.fullSpan)).toBe("=== In a cell ===\nx\n|-\n|\n");
      expect(slice(doc, alsoInCell.fullSpan)).toBe("== Also in a cell ==\ny\n|}\n");
      expect(slice(doc, b.fullSpan)).toBe("== B ==\nb");
    });

    it("finds them in nested tables and ends the lead's edit range at the first", () => {
      const nested = parse("lead\n{|\n|\n{|\n|\n== Deep ==\n|}\n|}\n");
      const [lead, deep] = expectLossless(nested);
      expect(deep.title).toEqual(Option.some("Deep"));
      expect(Option.getOrUndefined(deep.table)).toBe(nested.children[1]);
      expect(slice(nested, lead.span)).toBe(nested.source);
      expect(slice(nested, lead.fullSpan)).toBe("lead\n{|\n|\n{|\n|\n");
    });
  });

  it.each(["ada-lovelace.txt", "pathological.txt", "tables-and-autolinks.txt"])(
    "partitions the %s fixture losslessly",
    (name) => {
      expectLossless(parse(fixture(name)));
    },
  );

  it("outlines the Ada Lovelace fixture", () => {
    expect(outline(sections(parse(fixture("ada-lovelace.txt"))))).toEqual([
      { index: 0, level: 0, title: undefined, parent: undefined, children: [], inTable: false },
      { index: 1, level: 2, title: "Biography", parent: undefined, children: [2], inTable: false },
      { index: 2, level: 3, title: "Early life", parent: 1, children: [], inTable: false },
      { index: 3, level: 2, title: "See also", parent: undefined, children: [], inTable: false },
    ]);
  });
});
