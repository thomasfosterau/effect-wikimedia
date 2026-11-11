/**
 * The list view (#209): list lines grouped into lists, markers and kinds,
 * per-line text split with exact spans, and the document's own nodes kept.
 *
 * @module tests/lists
 */

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import { describe, expect, it } from "vite-plus/test";
import {
  type Document,
  type List,
  type ListItem,
  lists,
  type Node,
  parse,
  type Table,
  serializeNodes,
} from "../src/wikitext/index.ts";

/** The value of `option`, failing the test when it is `None`. */
const some = <A>(option: Option.Option<A>, what: string): A =>
  Option.match(option, { onNone: () => expect.unreachable(`no ${what}`), onSome: (a) => a });

const slice = (doc: Document, span: { start: number; end: number }): string =>
  doc.source.slice(span.start, span.end);

/** Every item's nodes are exact slices of the source: each node's span holds its own text. */
function expectExactSpans(doc: Document, all: readonly List[]): void {
  Arr.forEach(all, (list) =>
    Arr.forEach(list.items, (item) =>
      Arr.forEach(item.nodes, (node) => {
        expect(slice(doc, node.span)).toBe(serializeNodes([node]));
      }),
    ),
  );
}

const summary = (item: ListItem) => [item.marker, item.kind, serializeNodes(item.nodes)];

describe("lists", () => {
  it("groups consecutive list lines into one list, with markers, depths and kinds", () => {
    const doc = parse("Intro\n* a\n** b\n*# c\n# d\nAfter");
    const all = lists(doc);
    expectExactSpans(doc, all);
    expect(all).toHaveLength(1);
    const list = some(Arr.head(all), "list");
    expect(list.items.map(summary)).toEqual([
      ["*", "bullet", " a"],
      ["**", "bullet", " b"],
      ["*#", "number", " c"],
      ["#", "number", " d"],
    ]);
    expect(list.items.map((item) => item.depth)).toEqual([1, 2, 2, 1]);
    expect(slice(doc, list.span)).toBe("* a\n** b\n*# c\n# d");
    expect(list.items.map((item) => slice(doc, item.span))).toEqual(["* a", "** b", "*# c", "# d"]);
  });

  it("ends a list at a blank or non-list line", () => {
    const doc = parse("* a\n\n* b\ntext\n: c");
    const all = lists(doc);
    expect(all.map((list) => list.items.map((item) => serializeNodes(item.nodes)))).toEqual([
      [" a"],
      [" b"],
      [" c"],
    ]);
    expect(all.map((list) => list.items[0]?.kind)).toEqual(["bullet", "bullet", "indent"]);
  });

  it("keeps the document's own inline nodes, and splits only the text", () => {
    const doc = parse("* see [[Berlin]] and {{lang|de|Stadt}}\n* two");
    const list = some(Arr.head(lists(doc)), "list");
    const first = some(Arr.head(list.items), "item");
    const link = first.nodes.find(P.isTagged("Wikilink"));
    expect(link).toBeDefined();
    expect(doc.children).toContain(link);
    const template = first.nodes.find(P.isTagged("Template"));
    expect(doc.children).toContain(template);
    expectExactSpans(doc, [list]);
  });

  it("keeps a multi-line template whole in the item whose line it starts on", () => {
    const doc = parse("* {{a\n|b}} tail\n* next");
    const list = some(Arr.head(lists(doc)), "list");
    expect(list.items.map((item) => serializeNodes(item.nodes))).toEqual([
      " {{a\n|b}} tail",
      " next",
    ]);
  });

  it("splits a one-line ;term:definition at its own colon, not one inside a link", () => {
    const doc = parse("; [[a:b]] term : the definition\n; alone\n: its definition\n:: indent");
    const list = some(Arr.head(lists(doc)), "list");
    expectExactSpans(doc, [list]);
    expect(list.items.map(summary)).toEqual([
      [";", "term", " [[a:b]] term "],
      [":", "definition", " the definition"],
      [";", "term", " alone"],
      [":", "definition", " its definition"],
      ["::", "indent", " indent"],
    ]);
    expect(list.items.slice(0, 2).map((item) => slice(doc, item.span))).toEqual([
      "; [[a:b]] term ",
      ": the definition",
    ]);
  });

  it("finds nothing in a list marker that doesn't start a line, or in a table", () => {
    const doc = parse("a * b\n{|\n|\n* in a cell\n|}");
    expect(lists(doc)).toEqual([]);
  });

  it("reads a fragment, such as a table cell's content", () => {
    const doc = parse("{|\n|\n* in a cell\n* two\n|}");
    const isTable = (node: Node): node is Table => P.isTagged(node, "Table");
    const table = some(Arr.findFirst(doc.children, isTable), "table");
    const cell = some(Arr.head(some(Arr.head(table.rows), "row").cells), "cell");
    const content: readonly Node[] = cell.content;
    expect(lists(content).flatMap((list) => list.items.map((item) => item.marker))).toEqual([
      "*",
      "*",
    ]);
  });

  it("returns nothing for text without list lines", () => {
    expect(lists(parse("Just a paragraph.\n\nAnd another."))).toEqual([]);
    expect(lists(parse(""))).toEqual([]);
  });
});
