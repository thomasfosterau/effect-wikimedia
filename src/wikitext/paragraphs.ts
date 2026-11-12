/**
 * The paragraph view over parsed wikitext (#209): the runs of prose lines
 * MediaWiki wraps in `<p>`, split at blank lines and at the block-level
 * lines (lists, tables, headings, rules, preformatted text) that end a
 * paragraph. A projection, not a change to the tree: text is cut into fresh
 * per-line {@link Text} nodes as the list view does, and every other node is
 * the document's own.
 *
 * @copyright Thomas Foster
 * @module wikitext/paragraphs
 */

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Str from "effect/String";
import type { Node, Span } from "./ast.ts";
import { isText, type Line, linesOf, textAt } from "./lines.ts";
import { type Fragment, type StripToTextOptions, stripToText } from "./query.ts";

/** One paragraph: a run of consecutive prose lines. */
export interface Paragraph {
  /**
   * The paragraph's nodes, its line breaks included as text, so
   * `serializeNodes` of them is the source of {@link span}. Text is a
   * fresh {@link Text} node per line; every other node is the document's
   * own.
   */
  readonly nodes: readonly Node[];
  /** From the first line's start to the last line's end (before its newline). */
  readonly span: Span;
  /** The paragraph as plain text, trimmed: {@link stripToText} of {@link nodes}, with the options given to {@link paragraphs}. */
  readonly text: string;
}

/** A line that ends a paragraph and belongs to none: a list item, a rule, preformatted text. */
const BLOCK_LINE = /^(?:[*#:;]|-{4}| )/;

/** Whether a line has nothing but whitespace. */
const isBlank = (line: Line): boolean =>
  Arr.every(line.pieces, (node) => isText(node) && Str.isEmpty(node.text.trim()));

/** Whether a line is block-level: it opens with a block marker, or holds a table or heading. */
const isBlock = (line: Line): boolean =>
  Option.exists(Arr.head(line.pieces), (first) => isText(first) && BLOCK_LINE.test(first.text)) ||
  Arr.some(line.pieces, (node) => P.isTagged(node, "Table") || P.isTagged(node, "Heading"));

/** A run of prose lines as a paragraph, the newline between each pair as a text node. */
function paragraphOf(lines: readonly [Line, ...Line[]], options?: StripToTextOptions): Paragraph {
  const first = lines[0];
  const last = Arr.lastNonEmpty(lines);
  const nodes = Arr.flatMap(lines, (line, i) =>
    i === 0 ? line.pieces : [textAt(lines[i - 1]?.end ?? line.start, "\n"), ...line.pieces],
  );
  return {
    nodes,
    span: { start: first.start, end: last.end },
    text: stripToText(nodes, options).trim(),
  };
}

/**
 * Finds the paragraphs in `input`, in document order: each run of
 * consecutive lines of prose. A blank line ends a paragraph, and so does a
 * block-level line, which belongs to none: a list item (`*`, `#`, `:`, `;`),
 * a `----` rule, a line starting with a space (MediaWiki's preformatted
 * text), or a line holding a table or a heading. Only the input's own
 * top-level lines count, so for a section's paragraphs pass its
 * `Section.nodes`, and for a table cell's, its content. Pure and total.
 */
export function paragraphs(input: Fragment, options?: StripToTextOptions): readonly Paragraph[] {
  const nodes = P.isTagged(input, "Document") ? input.children : input;
  const runs: Line[][] = [[]];
  Arr.forEach(linesOf(nodes), (line) => {
    if (isBlank(line) || isBlock(line)) runs.push([]);
    else runs.at(-1)?.push(line);
  });
  return Arr.getSomes(
    Arr.map(runs, (run) =>
      Arr.isArrayNonEmpty(run) ? Option.some(paragraphOf(run, options)) : Option.none(),
    ),
  );
}
