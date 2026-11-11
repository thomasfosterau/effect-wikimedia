/**
 * Line-level reading of a fragment for the views that work by line
 * (`lists`, `paragraphs`; #209): a text node that holds several lines is cut
 * into fresh per-line text nodes with their own spans, and every other node
 * is kept whole on the line it starts on. Internal to `Wikitext`.
 *
 * @copyright Thomas Foster
 * @module wikitext/lines
 */

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Str from "effect/String";
import type { Node, Text } from "./ast.ts";

/** One line of the input: its pieces, and where it starts and ends (before its newline). */
export interface Line {
  readonly start: number;
  readonly end: number;
  readonly pieces: readonly Node[];
}

/** Whether `node` is a text node. */
export const isText = (node: Node): node is Text => P.isTagged(node, "Text");

/** A fresh text node holding `text`, starting at source offset `start`. */
export const textAt = (start: number, text: string): Text => ({
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
export function linesOf(nodes: readonly Node[]): readonly Line[] {
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
