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
 * - if a line has an odd number of bold markers *and* an odd number of
 *   italic markers (a `'''''` counts as one of each), one `'''` is
 *   reinterpreted as a literal apostrophe + `''`. The first `'''` whose
 *   preceding text ends in a single-letter word (`x '''`) is chosen; failing
 *   that, the first ending in a longer word or in nothing at all (the line
 *   start); failing that, the first ending in a space. "Preceding text" is
 *   MediaWiki's: the line from the previous run (or the line start) up to
 *   this one, plus the literal apostrophe a run of four sheds.
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

const SPACE = " ";

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

/**
 * What `before`, the text preceding a `'''` run, ends in, as `doQuotes`
 * reads it: only `' '` counts as a space, an empty text (the run starts the
 * line) is a longer word, and, as in PHP's `substr($s, -2, 1)`, the
 * second-to-last character of a one-character text is that character (#137).
 */
function precedingKind(before: string): Preceding {
  const x1 = before.at(-1);
  const x2 = before.length >= 2 ? before.at(-2) : before.at(0);
  if (x1 === SPACE) return "space";
  return x2 === SPACE ? "single-letter-word" : "multi-letter-word";
}

/**
 * The text `doQuotes` sees before token `i`: the line from the previous run
 * on it (or from the line start) up to this run, plus the literal apostrophe
 * a run of four sheds (#137).
 */
function precedingText(
  tokens: readonly Formatting[],
  norm: readonly Normalised[],
  i: number,
  src: string,
): string {
  const start = tokens[i].span.start;
  const prev = tokens[i - 1];
  const from = prev === undefined ? src.lastIndexOf("\n", start - 1) + 1 : prev.span.end;
  return src.slice(from, start) + "'".repeat(norm[i].lead);
}

// MediaWiki's per-line doQuotes resolution (run normalisation + odd-bold heuristic).
function resolveLine(tokens: readonly Formatting[], src: string): Normalised[] {
  const norm = tokens.map((t) => normalise(t.marks.length));
  const numBold = Arr.countBy(norm, (n) => n.markupLen !== 2);
  const numItalics = Arr.countBy(norm, (n) => n.markupLen !== 3);
  // MediaWiki requires an odd count of both (#137).
  if (numBold % 2 === 0 || numItalics % 2 === 0) return norm;
  // Reinterpret one `'''` as a literal apostrophe + `''`.
  const kinds = tokens.map((_, i) =>
    norm[i].markupLen === 3
      ? Option.some(precedingKind(precedingText(tokens, norm, i, src)))
      : Option.none(),
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
