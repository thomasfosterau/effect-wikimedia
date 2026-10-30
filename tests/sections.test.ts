/**
 * The section view (#209): the heading tree over a parsed document, its
 * MediaWiki nesting rule, and the lossless partition back to the AST.
 *
 * @module tests/sections
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Arr from "effect/Array";
import { describe, expect, it } from "vite-plus/test";
import {
  type Document,
  parse,
  type Section,
  sections,
  serialize,
  serializeNode,
  serializeNodes,
} from "../src/wikitext/index.ts";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

/** Each section's heading and own nodes, serialized back to back. */
const rebuild = (all: readonly Section[]): string =>
  all
    .map((s) => (s.heading === undefined ? "" : serializeNode(s.heading)) + serializeNodes(s.nodes))
    .join("");

/** The invariants every section list holds against its document. */
function expectLossless(doc: Document): void {
  const all = sections(doc);
  expect(rebuild(all)).toBe(serialize(doc));
  expect(all.flatMap((s) => (s.heading === undefined ? s.nodes : [s.heading, ...s.nodes]))).toEqual(
    doc.children,
  );
  Arr.forEach(all, (s) => {
    const own = (s.heading === undefined ? "" : serializeNode(s.heading)) + serializeNodes(s.nodes);
    expect(doc.source.slice(s.span.start, s.span.end)).toBe(own);
    expect(s.fullSpan.start).toBe(s.span.start);
    expect(s.fullSpan.end).toBeGreaterThanOrEqual(s.span.end);
    Arr.forEach(s.children, (child) => {
      expect(all[child].parent).toBe(s.index);
      expect(all[child].fullSpan.end).toBeLessThanOrEqual(s.fullSpan.end);
    });
  });
  expect(all[0].span.start).toBe(0);
  expect(all[all.length - 1].span.end).toBe(doc.source.length);
}

const outline = (all: readonly Section[]) =>
  all.map(({ index, level, title, parent, children }) => ({
    index,
    level,
    title,
    parent,
    children,
  }));

describe("sections", () => {
  it("always has a lead, even for an empty page", () => {
    const all = sections(parse(""));
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual({
      index: 0,
      heading: undefined,
      level: 0,
      title: "",
      parent: undefined,
      children: [],
      nodes: [],
      span: { start: 0, end: 0 },
      fullSpan: { start: 0, end: 0 },
    });
  });

  it("gives a heading-free page one lead section holding every node", () => {
    const doc = parse("Just '''prose''' and a [[link]].\n");
    const all = sections(doc);
    expect(all).toHaveLength(1);
    expect(all[0].nodes).toEqual(doc.children);
    expect(all[0].span).toEqual({ start: 0, end: doc.source.length });
  });

  it("gives an empty lead to a page that opens on a heading", () => {
    const doc = parse("== A ==\nbody\n");
    const [lead, a] = sections(doc);
    expect(lead.nodes).toEqual([]);
    expect(lead.span).toEqual({ start: 0, end: 0 });
    expect(a.heading).toBe(doc.children[0]);
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
    expect(outline(sections(doc))).toEqual([
      { index: 0, level: 0, title: "", parent: undefined, children: [] },
      { index: 1, level: 2, title: "A", parent: undefined, children: [2, 3] },
      { index: 2, level: 4, title: "A.1", parent: 1, children: [] },
      { index: 3, level: 3, title: "A.2", parent: 1, children: [] },
      { index: 4, level: 2, title: "B", parent: undefined, children: [] },
      { index: 5, level: 1, title: "C", parent: undefined, children: [6] },
      { index: 6, level: 2, title: "C.1", parent: 5, children: [] },
    ]);
    expectLossless(doc);
  });

  it("gives fullSpan the text action=edit&section=N replaces", () => {
    const doc = parse("== A ==\na\n=== A.1 ===\nx\n== B ==\nb");
    const slice = (s: Section, which: "span" | "fullSpan") =>
      doc.source.slice(s[which].start, s[which].end);
    const [lead, a, a1, b] = sections(doc);
    expect(slice(lead, "fullSpan")).toBe("");
    expect(slice(a, "span")).toBe("== A ==\na\n");
    expect(slice(a, "fullSpan")).toBe("== A ==\na\n=== A.1 ===\nx\n");
    expect(slice(a1, "fullSpan")).toBe("=== A.1 ===\nx\n");
    expect(slice(b, "fullSpan")).toBe("== B ==\nb");
  });

  it("reads the title as trimmed plain text and keeps the heading node", () => {
    const doc = parse("== [[Ada Lovelace|Ada]] &amp; {{lang|fr|x}} '''life''' ==\n");
    const [, s] = sections(doc);
    expect(s.title).toBe("Ada &  life");
    expect(s.heading).toBe(doc.children[0]);
    expect(s.level).toBe(2);
  });

  it("takes the shorter equals run as the level", () => {
    const [, s] = sections(parse("=== Surplus ==\n"));
    expect(s.level).toBe(2);
    expect(s.title).toBe("= Surplus");
  });

  it("splits only on top-level headings, not one inside a table cell", () => {
    const doc = parse("{|\n|\n== In a cell ==\n|}\n== Real ==\n");
    const all = sections(doc);
    expect(all.map((s) => s.title)).toEqual(["", "Real"]);
    expectLossless(doc);
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

  it.each(["ada-lovelace.txt", "pathological.txt", "tables-and-autolinks.txt"])(
    "partitions the %s fixture losslessly",
    (name) => expectLossless(parse(fixture(name))),
  );

  it("outlines the Ada Lovelace fixture", () => {
    expect(outline(sections(parse(fixture("ada-lovelace.txt"))))).toEqual([
      { index: 0, level: 0, title: "", parent: undefined, children: [] },
      { index: 1, level: 2, title: "Biography", parent: undefined, children: [2] },
      { index: 2, level: 3, title: "Early life", parent: 1, children: [] },
      { index: 3, level: 2, title: "See also", parent: undefined, children: [] },
    ]);
  });
});
