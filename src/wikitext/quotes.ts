/**
 * Bold/italic resolution — MediaWiki's "apostrophe jungle" (`Parser::doQuotes`).
 *
 * The scanner emits every run of two-or-more apostrophes as a flat
 * {@link Formatting} marker carrying its literal text; this pass assigns each
 * one its semantic {@link Formatting.mode} (`italic` / `bold` / `bold-italic`)
 * and its {@link Formatting.leadingLiterals} count, per line, matching
 * MediaWiki:
 *
 * - a run's markup length normalises to 2, 3 or 5 apostrophes — a run of
 *   four is `'` (literal) + `'''`, a run of six-plus is the surplus as
 *   literals + `'''''`;
 * - if a line has an odd number of bold markers, one `'''` is reinterpreted
 *   as `''` + a literal apostrophe, chosen by the classic
 *   single-letter-word / multi-letter-word / space heuristic on the
 *   character(s) preceding the run.
 *
 * **Deliberate divergence from MediaWiki.** MediaWiki runs `doQuotes` on
 * fully *expanded* output, line by line, after templates and tags resolve.
 * A structural parser has no expansion, so this pass runs per *fragment*
 * (top-level text, a parameter value, a heading title — each independently)
 * over the *source* line. The literal apostrophes are always preserved, so
 * this only affects the semantic annotation, never the round-trip.
 *
 * @copyright Thomas Foster
 * @module wikitext/quotes
 */

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type { Formatting, Node } from "./ast.ts";

const SPACE = 0x20;
const NEWLINE = 0x0a;

interface Normalised {
  markupLen: 2 | 3 | 5;
  lead: number;
}

/** Normalises an apostrophe run length to its MediaWiki markup + literals. */
function normalise(runLen: number): Normalised {
  if (runLen === 2) return { markupLen: 2, lead: 0 };
  if (runLen === 3) return { markupLen: 3, lead: 0 };
  if (runLen === 4) return { markupLen: 3, lead: 1 };
  if (runLen === 5) return { markupLen: 5, lead: 0 };
  return { markupLen: 5, lead: runLen - 5 };
}

function modeOf(markupLen: 2 | 3 | 5): Formatting["mode"] {
  return markupLen === 2 ? "italic" : markupLen === 3 ? "bold" : "bold-italic";
}

const isFormattingTag = Predicate.isTagged("Formatting");
const isFormatting = (node: Node): node is Formatting => isFormattingTag(node);

/**
 * Resolves the bold/italic role of every {@link Formatting} node in a
 * fragment, returning a new list (unchanged when the fragment has none).
 */
export function resolveQuotes(nodes: Node[], src: string): Node[] {
  if (!Arr.some(nodes, isFormatting)) return nodes;
  // Resolved (mode, lead) per Formatting node, in the nodes' order.
  const resolved = Arr.flatMap(lineGroups(Arr.filter(nodes, isFormatting), src), (group) =>
    resolveLine(group, src),
  );
  let next = 0;
  return nodes.map((n) => {
    if (!isFormatting(n)) return n;
    const r = resolved[next++];
    return { ...n, mode: modeOf(r.markupLen), leadingLiterals: r.lead };
  });
}

/**
 * Groups the formatting tokens by source line: a newline anywhere between
 * one token's end and the next's start starts a fresh line group.
 */
function lineGroups(tokens: readonly Formatting[], src: string): Formatting[][] {
  return Arr.reduce(tokens, Arr.empty<Formatting[]>(), (groups, token, i) => {
    const prev = tokens[i - 1];
    const last = groups[groups.length - 1];
    if (prev === undefined || last === undefined) groups.push([token]);
    else if (src.lastIndexOf("\n", token.span.start - 1) >= prev.span.end) groups.push([token]);
    else last.push(token);
    return groups;
  });
}

/** What precedes a `'''` run, as the odd-bold heuristic reads it. */
type Preceding = "single-letter-word" | "multi-letter-word" | "space";

/**
 * The odd-bold heuristic's preference: the first `'''` after a single-letter
 * word, else the first after a longer word, else the first after a space.
 */
const PRECEDING_PRIORITY: readonly Preceding[] = [
  "single-letter-word",
  "multi-letter-word",
  "space",
];

const isLineSpace = (c: number): boolean => c === SPACE || c === NEWLINE;

/** What precedes the run starting at `start` (the start of input reads as a space). */
function precedingKind(src: string, start: number): Preceding {
  const x1 = start - 1 >= 0 ? src.charCodeAt(start - 1) : SPACE;
  const x2 = start - 2 >= 0 ? src.charCodeAt(start - 2) : SPACE;
  if (isLineSpace(x1)) return "space";
  return isLineSpace(x2) ? "single-letter-word" : "multi-letter-word";
}

// MediaWiki's per-line doQuotes resolution (run normalisation + odd-bold heuristic).
function resolveLine(tokens: readonly Formatting[], src: string): Normalised[] {
  const norm = tokens.map((t) => normalise(t.marks.length));
  const numBold = Arr.countBy(norm, (n) => n.markupLen === 3 || n.markupLen === 5);
  if (numBold % 2 === 0) return norm;
  // Odd bold count: reinterpret one `'''` as `''` + a literal apostrophe.
  const kinds = tokens.map((t, i) =>
    norm[i].markupLen === 3 ? Option.some(precedingKind(src, t.span.start)) : Option.none(),
  );
  const chosen = Arr.findFirst(PRECEDING_PRIORITY, (kind) =>
    Arr.findFirstIndex(kinds, Option.contains(kind)),
  );
  return Option.match(chosen, {
    onNone: () => norm,
    onSome: (at): Normalised[] =>
      norm.map((n, i) => (i === at ? { markupLen: 2, lead: n.lead + 1 } : n)),
  });
}
