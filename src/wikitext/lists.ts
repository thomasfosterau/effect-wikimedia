/**
 * The list view over parsed wikitext (#209): the `*`, `#`, `:` and `;`
 * lines MediaWiki renders as lists, grouped into lists of items. A
 * projection, not a change to the tree. The parser keeps list lines as
 * plain {@link Text}, and one text node can hold several lines, so this view
 * splits such a node into fresh per-line {@link Text} nodes with their own
 * spans; every other node in an item is the document's own.
 *
 * @copyright Thomas Foster
 * @module wikitext/lists
 */

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import type { Node, Span, Text } from "./ast.ts";
import type { Fragment } from "./query.ts";

/** What a list item is, from the last character of its marker. */
export type ListItemKind = "bullet" | "number" | "indent" | "term" | "definition";

/** One list item: a list line, or one half of a `;term:definition` line. */
export interface ListItem {
  /**
   * The item's full marker prefix, such as `*`, `#*` or `;`. For the
   * definition half of a one-line `;term:definition`, the term's marker with
   * its last `;` read as `:`, which is what MediaWiki nests it as.
   */
  readonly marker: string;
  /** How deep the item is nested: the marker's length. */
  readonly depth: number;
  /**
   * The item's kind, from the marker's last character: `*` a bullet, `#` a
   * number, `;` a term. A `:` is a definition when it follows a term at the
   * same depth (on the next line, or after the term's `:` on its line), and
   * an indent otherwise.
   */
  readonly kind: ListItemKind;
  /**
   * The item's content on its line, after the marker (after the `:` for a
   * definition half), whitespace kept. Text is a fresh {@link Text} node for
   * the slice on this line; every other node is the document's own. A node
   * that spans lines, such as a multi-line template, stays whole in the item
   * whose line it starts on.
   */
  readonly nodes: readonly Node[];
  /** The item's source range, marker included, up to its line's end (or the term's `:`). */
  readonly span: Span;
}

/** A run of consecutive list lines. */
export interface List {
  /** The items in document order, nested ones included: nesting is in each item's {@link ListItem.marker}. */
  readonly items: readonly ListItem[];
  /** From the first item's start to the last item's end. */
  readonly span: Span;
}

/** One line of the input: its pieces, and where it starts and ends (before its newline). */
interface Line {
  readonly start: number;
  readonly end: number;
  readonly pieces: readonly Node[];
}

const isText = (node: Node): node is Text => Predicate.isTagged(node, "Text");

const textAt = (start: number, text: string): Text => ({
  _tag: "Text",
  span: { start, end: start + text.length },
  text,
});

/** A node cut at its newlines: one run of pieces per line it touches, and each newline's offset. */
interface Cut {
  readonly runs: readonly (readonly Node[])[];
  readonly breaks: readonly number[];
}

function cut(node: Node): Cut {
  if (!isText(node) || !node.text.includes("\n")) return { runs: [[node]], breaks: [] };
  const parts = node.text.split("\n");
  const [, offsets] = Arr.mapAccum(parts, node.span.start, (offset, part) => [
    offset + part.length + 1,
    offset,
  ]);
  return {
    runs: Arr.map(Arr.zip(parts, offsets), ([part, offset]) =>
      Str.isEmpty(part) ? [] : [textAt(offset, part)],
    ),
    // Each line after the first starts just past a newline.
    breaks: Arr.map(Arr.drop(offsets, 1), (offset) => offset - 1),
  };
}

/** The line being read: where it starts, and its pieces so far. */
interface OpenLine {
  readonly start: number;
  readonly pieces: readonly Node[];
}

/** Splits a fragment into lines, cutting text nodes at their newlines. */
function linesOf(nodes: readonly Node[]): readonly Line[] {
  const done: Line[] = [];
  const first: OpenLine = {
    start: Option.match(Arr.head(nodes), { onNone: () => 0, onSome: (n) => n.span.start }),
    pieces: [],
  };
  const last = Arr.reduce(nodes, first, (open, node): OpenLine => {
    const { runs, breaks } = cut(node);
    const joined: OpenLine = { start: open.start, pieces: [...open.pieces, ...(runs[0] ?? [])] };
    return Arr.reduce(Arr.drop(runs, 1), joined, (line, run, i): OpenLine => {
      const at = breaks[i] ?? line.start;
      done.push({ start: line.start, end: at, pieces: line.pieces });
      return { start: at + 1, pieces: run };
    });
  });
  const end = Option.match(Arr.last(last.pieces), {
    onNone: () => last.start,
    onSome: (n) => n.span.end,
  });
  return [...done, { start: last.start, end, pieces: last.pieces }];
}

/** The run of list markers a line starts with. */
const MARKER = /^[*#:;]+/;

const kindOf = (marker: string, previous: Option.Option<ListItem>): ListItemKind => {
  const last = marker.at(-1);
  if (last === "*") return "bullet";
  if (last === "#") return "number";
  if (last === ";") return "term";
  const term = `${marker.slice(0, -1)};`;
  return Option.exists(previous, (item) => item.marker === term) ? "definition" : "indent";
};

/** Where a `;term:definition` line's `:` is: the first `:` in its content's own text. */
function colonIn(
  nodes: readonly Node[],
): Option.Option<{ readonly at: number; readonly offset: number }> {
  return Arr.findFirst(nodes, (node, at) =>
    isText(node) && node.text.includes(":")
      ? Option.some({ at, offset: node.span.start + node.text.indexOf(":") })
      : Option.none(),
  );
}

/** Splits `nodes` at a source `offset` inside the text node at index `at`, dropping the one character there. */
function splitAt(
  nodes: readonly Node[],
  at: number,
  offset: number,
): readonly [readonly Node[], readonly Node[]] {
  const node = nodes[at];
  if (node === undefined || !isText(node)) return [nodes, []];
  const cutAt = offset - node.span.start;
  const before = node.text.slice(0, cutAt);
  const after = node.text.slice(cutAt + 1);
  return [
    [...nodes.slice(0, at), ...(Str.isEmpty(before) ? [] : [textAt(node.span.start, before)])],
    [...(Str.isEmpty(after) ? [] : [textAt(offset + 1, after)]), ...nodes.slice(at + 1)],
  ];
}

/** The item (two, for a one-line `;term:definition`) a line holds, or none when it isn't a list line. */
function itemsOf(line: Line, previous: Option.Option<ListItem>): readonly ListItem[] {
  const first = line.pieces[0];
  if (first === undefined || !isText(first) || first.span.start !== line.start) return [];
  const marker = MARKER.exec(first.text)?.[0];
  if (marker === undefined) return [];
  const rest = first.text.slice(marker.length);
  const nodes = [
    ...(Str.isEmpty(rest) ? [] : [textAt(first.span.start + marker.length, rest)]),
    ...line.pieces.slice(1),
  ];
  const item: ListItem = {
    marker,
    depth: marker.length,
    kind: kindOf(marker, previous),
    nodes,
    span: { start: line.start, end: line.end },
  };
  if (!marker.endsWith(";")) return [item];
  return Option.match(colonIn(nodes), {
    onNone: () => [item],
    onSome: ({ at, offset }) => {
      const [term, definition] = splitAt(nodes, at, offset);
      const dd = `${marker.slice(0, -1)}:`;
      return [
        { ...item, nodes: term, span: { start: line.start, end: offset } },
        {
          marker: dd,
          depth: dd.length,
          kind: "definition",
          nodes: definition,
          span: { start: offset, end: line.end },
        },
      ];
    },
  });
}

/**
 * Finds the lists in `input`, in document order: each run of consecutive
 * lines that start with a list marker (`*`, `#`, `:` or `;`, in any
 * combination, such as `#*` or `::`), as MediaWiki renders them. A line that
 * isn't one, a blank line included, ends a list. Only lines of the input's
 * own top-level nodes count, so a list inside a table cell is found by
 * passing the cell's content. A one-line `;term:definition` gives two items,
 * split at the first `:` in the line's own text (one inside a link or
 * template doesn't count). Pure and total.
 */
export function lists(input: Fragment): readonly List[] {
  const nodes = Predicate.isTagged(input, "Document") ? input.children : input;
  const groups: ListItem[][] = [];
  Arr.forEach(linesOf(nodes), (line) => {
    const current = Option.filter(Arr.last(groups), Arr.isReadonlyArrayNonEmpty);
    const items = itemsOf(line, Option.flatMap(current, Arr.last));
    if (Arr.isReadonlyArrayEmpty(items)) {
      // A line that isn't a list line closes the open list, if there is one.
      if (Option.isSome(current)) groups.push([]);
      return;
    }
    Option.match(current, {
      onNone: () => groups.push([...items]),
      onSome: (group) => group.push(...items),
    });
  });
  return Arr.getSomes(
    Arr.map(groups, (items) =>
      Option.map(Option.all([Arr.head(items), Arr.last(items)]), ([first, last]) => ({
        items,
        span: { start: first.span.start, end: last.span.end },
      })),
    ),
  );
}
