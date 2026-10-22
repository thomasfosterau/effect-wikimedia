/**
 * Bracket matching for the wikitable scans (#132): one linear pass over the
 * source that records where each template `{{…}}`, argument `{{{…}}}`,
 * wikilink `[[…]]`, closed comment and extension tag ends, so a table's
 * line, cell-separator and attribute scans can step over each one whole.
 *
 * Openers go on a stack, as in MediaWiki's preprocessor, so brackets are
 * matched in one pass, in time linear in the input. The recursive descent in `./parse.ts` instead rescans the
 * rest of the input for every opener that never closes, which is quadratic
 * on a table full of them. Where the two could differ, the stack sides with
 * the parser: a closing run matches the nearest open run of its kind, as
 * recursive descent finds it, where MediaWiki would match only the innermost
 * open run. So `{{a|[[b}}` is a template here, as it is anywhere else in a
 * page, and the scan and the cell's parsed content agree.
 *
 * @copyright Thomas Foster
 * @module wikitext/brackets
 */

import * as Arr from "effect/Array";
import * as Option from "effect/Option";

const OPEN_BRACE = 0x7b; // {
const CLOSE_BRACE = 0x7d; // }
const OPEN_BRACKET = 0x5b; // [
const CLOSE_BRACKET = 0x5d; // ]
const LESS_THAN = 0x3c; // <

/** A run of each bracket character, matched in place (sticky). */
const OPEN_BRACE_RUN = /\{+/y;
const CLOSE_BRACE_RUN = /\}+/y;
const OPEN_BRACKET_RUN = /\[+/y;
const CLOSE_BRACKET_RUN = /\]+/y;

function runPattern(c: number): RegExp {
  if (c === OPEN_BRACE) return OPEN_BRACE_RUN;
  if (c === CLOSE_BRACE) return CLOSE_BRACE_RUN;
  return c === OPEN_BRACKET ? OPEN_BRACKET_RUN : CLOSE_BRACKET_RUN;
}

/** An unmatched run of two or more `{` or `[`. */
interface Piece {
  /** The run's character, `{` or `[`. */
  readonly char: number;
  /** Where the run starts. */
  readonly pos: number;
  /** How many of its characters are still unmatched; matches use the rightmost. */
  count: number;
}

/**
 * Where each construct's end sits in the table {@link matchBrackets} builds:
 * indexed by the construct's first character, holding the index just past
 * its last, or `0` where no construct opens (an end is always past its
 * start, so `0` is never one). A typed array rather than a map: the table
 * scans read it at every bracket they step over.
 */
export type BracketEnds = Int32Array;

/**
 * Where each bracketed construct in `src` ends: a table from the index of its
 * first character to the index just past its last. `extensionTagEnd(at)`
 * returns the end of the extension tag (body and close tag included) opening
 * at `at`, or `-1` when none does.
 *
 * A run of `}` or `]` matches the nearest open run of `{` or `[` (any
 * `[[` or `{{` opened since then is left unclosed, so literal), taking three
 * braces for an argument when both runs have three, otherwise two. A single
 * `{`, `}`, `[` or `]` never matches. A comment or extension tag is opaque:
 * brackets inside it don't count. An unclosed comment is literal text here
 * (MediaWiki would run it to the end of the page), so a stray `<!--` in a
 * table hides nothing.
 */
export function matchBrackets(src: string, extensionTagEnd: (at: number) => number): BracketEnds {
  return new BracketMatcher(src, extensionTagEnd).run();
}

class BracketMatcher {
  private readonly ends: Int32Array;
  private readonly stack: Piece[] = [];
  /**
   * How many pieces of each kind are on `stack`, indexed by the char code of
   * their opening character (`{` or `[`, both ASCII).
   */
  private readonly open = new Int32Array(0x80);
  /** False once a search for `-->` has failed: no later comment closes either. */
  private commentsClose = true;

  private readonly src: string;
  private readonly extensionTagEnd: (at: number) => number;

  constructor(src: string, extensionTagEnd: (at: number) => number) {
    this.src = src;
    this.extensionTagEnd = extensionTagEnd;
    this.ends = new Int32Array(src.length);
  }

  run(): BracketEnds {
    let i = 0;
    while (i < this.src.length) i = this.step(i);
    return this.ends;
  }

  /** Handles the character at `i`; returns where to continue. */
  private step(i: number): number {
    const c = this.src.charCodeAt(i);
    if (c === OPEN_BRACE || c === OPEN_BRACKET) return this.openRun(i);
    if (c === CLOSE_BRACE) return this.closeRun(i, OPEN_BRACE);
    if (c === CLOSE_BRACKET) return this.closeRun(i, OPEN_BRACKET);
    return c === LESS_THAN ? this.opaque(i) : i + 1;
  }

  /** End of the run of the bracket character at `i`. */
  private runEnd(i: number): number {
    const run = runPattern(this.src.charCodeAt(i));
    run.lastIndex = i;
    run.test(this.src);
    return run.lastIndex;
  }

  private openRun(i: number): number {
    const end = this.runEnd(i);
    if (end - i >= 2) this.push({ char: this.src.charCodeAt(i), pos: i, count: end - i });
    return end;
  }

  /**
   * Matches the closing run at `i` against open runs, 2 or 3 characters at a
   * time, until fewer than 2 closers are left or no run of its kind is open;
   * the leftover closers are literal. The run is measured once, so a long run
   * costs time linear in its length.
   */
  private closeRun(i: number, openChar: number): number {
    const end = this.runEnd(i);
    let at = i;
    while (end - at >= 2 && this.open[openChar] > 0) {
      this.dropAbove(openChar);
      const piece = this.top();
      const matched = Math.min(end - at, piece.count, openChar === OPEN_BRACE ? 3 : 2);
      piece.count -= matched;
      this.ends[piece.pos + piece.count] = at + matched;
      if (piece.count < 2) this.pop();
      at += matched;
    }
    return end;
  }

  /** Steps over a closed comment or an extension tag at `i`, recording its end. */
  private opaque(i: number): number {
    const end = this.src.startsWith("<!--", i) ? this.commentEnd(i) : this.extensionTagEnd(i);
    if (end < 0) return i + 1;
    this.ends[i] = end;
    return end;
  }

  private commentEnd(i: number): number {
    if (!this.commentsClose) return -1;
    const close = this.src.indexOf("-->", i + 4);
    if (close < 0) {
      this.commentsClose = false;
      return -1;
    }
    return close + 3;
  }

  /**
   * Drops the runs of the other kind opened since the nearest open run of
   * `openChar`: they stay unclosed. One is open (`open[openChar] > 0`).
   */
  private dropAbove(openChar: number): void {
    if (this.top().char === openChar) return;
    const nearest = Arr.findLastIndex(this.stack, (piece) => piece.char === openChar);
    const dropped = this.stack.splice(Option.getOrElse(nearest, () => -1) + 1);
    Arr.forEach(dropped, (piece) => this.open[piece.char]--);
  }

  private top(): Piece {
    return this.stack[this.stack.length - 1];
  }

  private push(piece: Piece): void {
    this.stack.push(piece);
    this.open[piece.char]++;
  }

  private pop(): void {
    const piece = this.stack.pop();
    if (piece) this.open[piece.char]--;
  }
}
