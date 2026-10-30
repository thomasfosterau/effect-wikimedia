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
import type { Document, Heading, Node, Span } from "./ast.ts";
import { stripToText } from "./query.ts";

/**
 * One section of a document: the lead (index 0, before the first heading) or
 * a heading with the nodes up to the next heading of any level.
 *
 * The sections of a document partition its top-level nodes: for each
 * section in order, its {@link heading} (when present) followed by its
 * {@link nodes} rebuilds `Document.children` exactly, so serializing them in
 * order reproduces {@link serialize} of the document.
 */
export interface Section {
  /**
   * The section's position in document order, `0` for the lead. On a page
   * whose headings are all written at the top level (none comes from a
   * template or sits inside a table cell) it is MediaWiki's section number,
   * as `action=parse&section=N` and `action=edit&section=N` take it.
   */
  readonly index: number;
  /**
   * The document's own heading node that opens the section; `undefined`
   * only for the lead.
   */
  readonly heading: Heading | undefined;
  /** The heading's {@link Heading.level}, 1 to 6; `0` for the lead. */
  readonly level: number;
  /**
   * The heading title as plain text, trimmed; `""` for the lead. It is
   * {@link stripToText} of {@link Heading.title} between the surplus `=` of
   * an unbalanced heading, which MediaWiki reads as title text
   * (`=== A ==` has the title `= A`). Templates in the title strip to
   * nothing, so read {@link heading} for the markup.
   */
  readonly title: string;
  /**
   * The {@link index} of the enclosing section: the nearest earlier heading
   * with a lower level. `undefined` for the lead and for a top-level
   * section (no earlier heading is shallower); the lead is never a parent.
   */
  readonly parent: number | undefined;
  /**
   * The {@link index} of each direct subsection, in document order; empty
   * when there is none. Every child's {@link parent} is this section.
   */
  readonly children: readonly number[];
  /**
   * The section's own body: the top-level nodes after its heading (from the
   * document's start for the lead), up to the next heading of any level.
   * The same node objects as in `Document.children`, never copies; a
   * subsection's nodes are in that subsection, not here.
   */
  readonly nodes: readonly Node[];
  /**
   * The source range of the heading and own body: from the heading's start
   * (`0` for the lead) to the next heading's start, or the end of the
   * document. Offsets into `Document.source`, as on every node.
   */
  readonly span: Span;
  /**
   * The source range of the section with all its subsections: from the
   * heading's start to the next heading whose level is at most this one's,
   * or the end of the document. It is the text `action=edit&section=N`
   * replaces. Equal to {@link span} for the lead and for a section with no
   * subsection.
   */
  readonly fullSpan: Span;
}

/** Where a section opens: its heading and that heading's top-level index. */
interface Opening {
  /** The heading's index in `Document.children`; `-1` for the lead. */
  readonly at: number;
  readonly heading: Heading | undefined;
}

/** How each section sits in the tree, by index into the openings. */
interface Nesting {
  readonly parents: readonly (number | undefined)[];
  readonly children: readonly (readonly number[])[];
  /** Per section, the first later section whose level is at most its own. */
  readonly closers: readonly (number | undefined)[];
}

const levelOf = (opening: Opening): number => opening.heading?.level ?? 0;

/** A heading's title as MediaWiki reads it, surplus `=` included. */
const titleOf = (heading: Heading): string =>
  (
    heading.leftEquals.slice(heading.level) +
    stripToText(heading.title) +
    heading.rightEquals.slice(heading.level)
  ).trim();

/**
 * MediaWiki's nesting rule over the openings, in one pass over a stack of
 * the sections still open: a new heading closes every open section at its
 * level or deeper, and its parent is whichever stays on top. The stack's
 * levels rise strictly from bottom to top, so the sections a heading closes
 * are always a suffix of it, and each section is pushed and closed once.
 * The lead (index 0) never enters the stack, so it is nobody's parent.
 */
function nest(openings: readonly Opening[]): Nesting {
  const parents = Arr.makeBy(openings.length, (): number | undefined => undefined);
  const closers = Arr.makeBy(openings.length, (): number | undefined => undefined);
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
      closers[closed] = index;
    });
    const parent = Arr.last(open);
    parents[index] = Option.getOrUndefined(parent);
    if (Option.isSome(parent)) children[parent.value].push(index);
    open.push(index);
  });
  return { parents, children, closers };
}

/**
 * Splits a document into its {@link Section}s, in document order: the lead
 * at index 0 (always present, with no nodes for a page that opens on a
 * heading or is empty), then one per top-level {@link Heading}.
 *
 * The tree is given by {@link Section.parent} and {@link Section.children}
 * indices into the returned array, so the result holds no cycles. Nesting
 * follows MediaWiki: a heading's parent is the nearest earlier heading with
 * a lower level, so `==` then `====` nests the second in the first, and a
 * later `=` starts a new top-level section.
 *
 * Only top-level headings open a section. A heading inside a table cell (the
 * parser builds those too) stays in the table's section, so on such a page
 * {@link Section.index} runs behind MediaWiki's numbering; a heading written
 * by a template is invisible here, as it is to {@link parse}. Spans come
 * from the nodes, so on an edited tree they still point at the original
 * source. Pure and total: it never fails.
 */
export function sections(doc: Document): readonly Section[] {
  const nodes = doc.children;
  const openings: readonly Opening[] = [
    { at: -1, heading: undefined },
    ...Arr.flatMap(nodes, (node, at): Opening[] =>
      Predicate.isTagged(node, "Heading") ? [{ at, heading: node }] : [],
    ),
  ];
  const { parents, children, closers } = nest(openings);
  // Where section `index` starts in the source: the document's start for the
  // lead, and its end past the last section.
  const startOf = (index: number | undefined): number => {
    if (index === undefined || index >= openings.length) return doc.span.end;
    const { at } = openings[index];
    return at < 0 ? doc.span.start : nodes[at].span.start;
  };
  return Arr.map(openings, (opening, index): Section => {
    const { heading } = opening;
    const start = startOf(index);
    const end = startOf(index + 1);
    return {
      index,
      heading,
      level: levelOf(opening),
      title: heading === undefined ? "" : titleOf(heading),
      parent: parents[index],
      children: children[index],
      nodes: nodes.slice(opening.at + 1, openings[index + 1]?.at ?? nodes.length),
      span: { start, end },
      fullSpan: { start, end: index === 0 ? end : startOf(closers[index]) },
    };
  });
}
