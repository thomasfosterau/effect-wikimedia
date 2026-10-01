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

/**
 * Resolves the bold/italic role of every {@link Formatting} node in a
 * fragment, returning a new list (unchanged when the fragment has none).
 */
export function resolveQuotes(nodes: Node[], src: string): Node[] {
  let hasFormatting = false;
  for (const n of nodes) {
    if (n._tag === "Formatting") {
      hasFormatting = true;
      break;
    }
  }
  if (!hasFormatting) return nodes;

  // Resolved (mode, lead) per Formatting node, keyed by identity.
  const resolved = new Map<Formatting, Normalised>();

  // Group the formatting tokens by source line: a newline anywhere between
  // one token's end and the next's start starts a fresh line group.
  let group: Formatting[] = [];
  let prevEnd = -1;
  const flush = () => {
    if (group.length > 0) resolveLine(group, src, resolved);
    group = [];
  };
  for (const n of nodes) {
    if (n._tag !== "Formatting") continue;
    if (prevEnd >= 0 && src.lastIndexOf("\n", n.span.start - 1) >= prevEnd) {
      flush();
    }
    group.push(n);
    prevEnd = n.span.end;
  }
  flush();

  return nodes.map((n) => {
    if (n._tag !== "Formatting") return n;
    const r = resolved.get(n);
    if (!r) return n;
    return { ...n, mode: modeOf(r.markupLen), leadingLiterals: r.lead };
  });
}

// reason: MediaWiki's per-line doQuotes resolution (run normalisation + odd-bold heuristic); CRAP is estimate-inflated because the audit runs without unit coverage — covered by quotes.test.ts.
function resolveLine(
  tokens: readonly Formatting[],
  src: string,
  out: Map<Formatting, Normalised>,
): void {
  const norm = tokens.map((t) => normalise(t.marks.length));

  let numBold = 0;
  for (const n of norm) if (n.markupLen === 3 || n.markupLen === 5) numBold++;

  if (numBold % 2 === 1) {
    // Odd bold count: reinterpret one `'''` as `''` + a literal apostrophe.
    let firstSingle = -1;
    let firstMulti = -1;
    let firstSpace = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (norm[i].markupLen !== 3) continue;
      const start = tokens[i].span.start;
      const x1 = start - 1 >= 0 ? src.charCodeAt(start - 1) : SPACE;
      const x2 = start - 2 >= 0 ? src.charCodeAt(start - 2) : SPACE;
      const x1Space = x1 === SPACE || x1 === NEWLINE;
      const x2Space = x2 === SPACE || x2 === NEWLINE;
      if (x1Space) {
        if (firstSpace === -1) firstSpace = i;
      } else if (x2Space) {
        firstSingle = i; // single-letter word — highest priority, stop looking
        break;
      } else if (firstMulti === -1) {
        firstMulti = i;
      }
    }
    const chosen = firstSingle > -1 ? firstSingle : firstMulti > -1 ? firstMulti : firstSpace;
    if (chosen > -1) {
      norm[chosen] = { markupLen: 2, lead: norm[chosen].lead + 1 };
    }
  }

  for (let i = 0; i < tokens.length; i++) out.set(tokens[i], norm[i]);
}
