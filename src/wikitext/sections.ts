/**
 * The section view over a parsed {@link Document} (#209): the heading tree
 * MediaWiki builds from `== … ==` lines, as flat records that point back at
 * the AST. A projection, not a change to the tree: every {@link Section}
 * holds the document's own {@link Heading} and child nodes (never copies),
 * so an edit still goes through the tree and {@link serialize}.
 *
 * @copyright Thomas Foster
 * @module wikitext/sections
 */

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type { Document, Heading, Node, Span, Table } from "./ast.ts";
import { filter, type StripToTextOptions, stripToText } from "./query.ts";

/**
 * One section of a document: the lead (index 0, before the first heading),
 * or a heading with what follows it up to the next heading.
 *
 * Every heading MediaWiki numbers opens a section, so {@link index} is
 * MediaWiki's section number. That includes a heading on its own line
 * inside a table cell, which this view calls an *in-table* section
 * ({@link table} is `Some`). A table can't be cut in two, so an in-table
 * section owns no nodes: the table stays whole in the section it sits in,
 * and the in-table section points at it.
 *
 * The sections whose {@link table} is `None` partition the document's
 * top-level nodes: for each in order, its {@link heading} (when `Some`)
 * followed by its {@link nodes} rebuilds `Document.children` exactly, so
 * serializing them reproduces {@link serialize} of the document.
 */
export interface Section {
  /**
   * The section's number, `0` for the lead, counting every heading in
   * document order, in-table ones included. On a page whose headings are all
   * in its own source (none comes from a template) it is the `section=N`
   * that `action=parse` and `action=edit` take.
   */
  readonly index: number;
  /**
   * The document's own heading node that opens the section, a top-level
   * node or one inside a cell of {@link table}; `None` only for the lead.
   */
  readonly heading: Option.Option<Heading>;
  /** The heading's {@link Heading.level}, 1 to 6; `0` for the lead. */
  readonly level: number;
  /**
   * The heading title as plain text, trimmed; `None` for the lead. It is
   * {@link stripToText} of {@link Heading.title} (with the options given to
   * {@link sections}) between the surplus `=` of an unbalanced heading,
   * which MediaWiki reads as title text (`=== A ==` has the title `= A`).
   */
  readonly title: Option.Option<string>;
  /**
   * The {@link index} of the enclosing section: the nearest earlier heading
   * with a lower level, in-table or not. `None` for the lead and for a
   * top-level section (no earlier heading is shallower); the lead is never
   * a parent.
   */
  readonly parent: Option.Option<number>;
  /**
   * The {@link index} of each direct subsection, in document order; empty
   * when there is none. Every child's {@link parent} is this section.
   */
  readonly children: readonly number[];
  /**
   * For an in-table section, the top-level {@link Table} node whose cell
   * (at any depth of nested tables) holds its {@link heading}; that table is
   * among the {@link nodes} of an earlier section. `None` for the lead and
   * for a section whose heading is a top-level node.
   */
  readonly table: Option.Option<Table>;
  /**
   * The section's own body: the top-level nodes after its heading (from the
   * document's start for the lead), up to the next top-level heading. The
   * same node objects as in `Document.children`, never copies. Empty for an
   * in-table section, whose content stays in its {@link table}.
   */
  readonly nodes: readonly Node[];
  /**
   * The source range of the heading and {@link nodes}: from the heading's
   * start (`0` for the lead) to the next top-level heading's start, or the
   * end of the document. For an in-table section, the heading's own span.
   * Always node-aligned: it never cuts a node. Offsets into
   * `Document.source`, as on every node.
   */
  readonly span: Span;
  /**
   * The source range `action=edit&section=N` replaces: from the heading's
   * start to the next heading, in-table or not, whose level is at most this
   * one's (any heading, for the lead), or the end of the document. It is
   * MediaWiki's text-level rule, so where a heading sits in a table cell
   * the range can start or end inside that table, and can end before
   * {@link span} does. On a page with no in-table heading it contains
   * {@link span}, and equals it for the lead and for a section with no
   * subsection.
   */
  readonly fullSpan: Span;
}

/** Where a section opens: its heading, and where that heading sits. */
interface Opening {
  /** The heading's index in `Document.children`; `-1` for the lead and an in-table heading. */
  readonly at: number;
  readonly heading: Option.Option<Heading>;
  readonly table: Option.Option<Table>;
}

/** How each section sits in the tree, by index into the openings. */
interface Nesting {
  readonly parents: readonly Option.Option<number>[];
  readonly children: readonly (readonly number[])[];
  /** Per section, the first later section whose level is at most its own. */
  readonly closers: readonly Option.Option<number>[];
}

const levelOf = (opening: Opening): number =>
  Option.match(opening.heading, { onNone: () => 0, onSome: (heading) => heading.level });

/** A heading's title as MediaWiki reads it, surplus `=` included. */
const titleOf = (heading: Heading, options: StripToTextOptions | undefined): string =>
  (
    heading.leftEquals.slice(heading.level) +
    stripToText(heading.title, options) +
    heading.rightEquals.slice(heading.level)
  ).trim();

const isHeading = (node: Node): node is Heading => Predicate.isTagged(node, "Heading");

/** The openings a top-level node contributes: itself, or a table's headings. */
function openingsOf(node: Node, at: number): Opening[] {
  if (isHeading(node)) return [{ at, heading: Option.some(node), table: Option.none() }];
  if (!Predicate.isTagged(node, "Table")) return [];
  return Arr.map(Arr.filter(filter([node], isHeading), isHeading), (heading) => ({
    at: -1,
    heading: Option.some(heading),
    table: Option.some(node),
  }));
}

/**
 * MediaWiki's nesting rule over the openings, in one pass over a stack of
 * the sections still open: a new heading closes every open section at its
 * level or deeper, and its parent is whichever stays on top. The stack's
 * levels rise strictly from bottom to top, so the sections a heading closes
 * are always a suffix of it, and each section is pushed and closed once.
 * The lead (index 0) never enters the stack, so it is nobody's parent.
 */
function nest(openings: readonly Opening[]): Nesting {
  const parents = Arr.makeBy(openings.length, (): Option.Option<number> => Option.none());
  const closers = Arr.makeBy(openings.length, (): Option.Option<number> => Option.none());
  const children = Arr.makeBy(openings.length, (): number[] => []);
  const open: number[] = [];
  Arr.forEach(openings, (opening, index) => {
    if (index === 0) return;
    const level = levelOf(opening);
    const kept = Option.getOrElse(
      Arr.findLastIndex(open, (at) => levelOf(openings[at]) < level),
      () => -1,
    );
    Arr.forEach(open.splice(kept + 1), (closed) => {
      closers[closed] = Option.some(index);
    });
    const parent = Arr.last(open);
    parents[index] = parent;
    if (Option.isSome(parent)) children[parent.value].push(index);
    open.push(index);
  });
  return { parents, children, closers };
}

/**
 * For each opening, the index in `Document.children` of the next top-level
 * heading after it (`nodes.length` when there is none): where a top-level
 * section's own nodes end. One pass from the end.
 */
function nodeEnds(openings: readonly Opening[], length: number): readonly number[] {
  let next = length;
  return Arr.reverse(
    Arr.map(Arr.reverse(openings), (opening) => {
      const end = next;
      if (Option.isNone(opening.table) && opening.at >= 0) next = opening.at;
      return end;
    }),
  );
}

/**
 * Splits a document into its {@link Section}s, in document order: the lead
 * at index 0 (always present, with no nodes for a page that opens on a
 * heading or is empty), then one per heading MediaWiki numbers. That is
 * every top-level {@link Heading}, and every heading on its own line in a
 * table cell, which becomes an in-table section (see {@link Section.table}).
 *
 * The tree is given by {@link Section.parent} and {@link Section.children}
 * indices into the returned array, so the result holds no cycles. Nesting
 * follows MediaWiki: a heading's parent is the nearest earlier heading with
 * a lower level, so `==` then `====` nests the second in the first, and a
 * later `=` starts a new top-level section. `options` is passed to
 * {@link stripToText} for each {@link Section.title}.
 *
 * A heading written by a template is invisible here, as it is to
 * {@link parse}, and a heading in a template parameter is not one MediaWiki
 * numbers. Spans come from the nodes, so on an edited tree they still point
 * at the original source. Pure and total: it never fails.
 */
export function sections(doc: Document, options?: StripToTextOptions): readonly Section[] {
  const nodes = doc.children;
  const openings: readonly Opening[] = [
    { at: -1, heading: Option.none(), table: Option.none() },
    ...Arr.flatMap(nodes, openingsOf),
  ];
  const { parents, children, closers } = nest(openings);
  const ends = nodeEnds(openings, nodes.length);
  const startOf = (opening: Opening): number =>
    Option.match(opening.heading, { onNone: () => doc.span.start, onSome: (h) => h.span.start });
  const fullEnd = (closer: Option.Option<number>): number =>
    Option.match(closer, { onNone: () => doc.span.end, onSome: (at) => startOf(openings[at]) });
  // A top-level section's own range runs to the next top-level heading; an
  // in-table section's is its heading's.
  const ownEnd = (opening: Opening, index: number): number =>
    Option.match(
      Option.flatMap(opening.table, () => opening.heading),
      {
        onSome: (heading) => heading.span.end,
        onNone: () => (ends[index] < nodes.length ? nodes[ends[index]].span.start : doc.span.end),
      },
    );
  // The lead's edit range runs to the first heading of any level.
  const leadCloser = openings.length > 1 ? Option.some(1) : Option.none<number>();
  return Arr.map(openings, (opening, index): Section => {
    const { heading, table } = opening;
    const start = startOf(opening);
    return {
      index,
      heading,
      level: levelOf(opening),
      title: Option.map(heading, (h) => titleOf(h, options)),
      parent: parents[index],
      children: children[index],
      table,
      nodes: Option.isSome(table) ? [] : nodes.slice(opening.at + 1, ends[index]),
      span: { start, end: ownEnd(opening, index) },
      fullSpan: { start, end: fullEnd(index === 0 ? leadCloser : closers[index]) },
    };
  });
}
