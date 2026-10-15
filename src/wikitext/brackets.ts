/**
 * Bracket matching for the wikitable scans (#132): one linear pass over the
 * source that records where each template `{{…}}`, argument `{{{…}}}`,
 * wikilink `[[…]]`, closed comment and extension tag ends, so a table's
 * line, cell-separator and attribute scans can step over each one whole.
 *
 * Openers go on a stack, as in MediaWiki's preprocessor, so each character
 * is visited once. The recursive descent in `./parse.ts` instead rescans the
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

const OPEN_BRACE = 0x7b; // {
const CLOSE_BRACE = 0x7d; // }
const OPEN_BRACKET = 0x5b; // [
const CLOSE_BRACKET = 0x5d; // ]
const LESS_THAN = 0x3c; // <

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
 * Where each bracketed construct in `src` ends: a map from the index of its
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
export function matchBrackets(
  src: string,
  extensionTagEnd: (at: number) => number,
): ReadonlyMap<number, number> {
  return new BracketMatcher(src, extensionTagEnd).run();
}

class BracketMatcher {
  private readonly ends = new Map<number, number>();
  private readonly stack: Piece[] = [];
  /** How many pieces of each kind are on `stack`, keyed by opening character. */
  private readonly open: Record<number, number> = { [OPEN_BRACE]: 0, [OPEN_BRACKET]: 0 };
  /** False once a search for `-->` has failed: no later comment closes either. */
  private commentsClose = true;

  private readonly src: string;
  private readonly extensionTagEnd: (at: number) => number;

  constructor(src: string, extensionTagEnd: (at: number) => number) {
    this.src = src;
    this.extensionTagEnd = extensionTagEnd;
  }

  run(): ReadonlyMap<number, number> {
    let i = 0;
    while (i < this.src.length) i = this.step(i);
    return this.ends;
  }

  /** Handles the character at `i`; returns where to continue. */
  private step(i: number): number {
    switch (this.src.charCodeAt(i)) {
      case OPEN_BRACE:
      case OPEN_BRACKET:
        return this.openRun(i);
      case CLOSE_BRACE:
        return this.closeRun(i, OPEN_BRACE);
      case CLOSE_BRACKET:
        return this.closeRun(i, OPEN_BRACKET);
      case LESS_THAN:
        return this.opaque(i);
      default:
        return i + 1;
    }
  }

  /** End of the run of the character at `i`. */
  private runEnd(i: number): number {
    const c = this.src.charCodeAt(i);
    let j = i + 1;
    while (j < this.src.length && this.src.charCodeAt(j) === c) j++;
    return j;
  }

  private openRun(i: number): number {
    const end = this.runEnd(i);
    if (end - i >= 2) this.push({ char: this.src.charCodeAt(i), pos: i, count: end - i });
    return end;
  }

  private closeRun(i: number, openChar: number): number {
    const end = this.runEnd(i);
    if (end - i < 2 || this.open[openChar] === 0) return end; // literal
    // Runs of the other kind opened since the nearest run of this kind stay unclosed.
    while (this.top().char !== openChar) this.pop();
    const piece = this.top();
    const matched = Math.min(end - i, piece.count, openChar === OPEN_BRACE ? 3 : 2);
    piece.count -= matched;
    this.ends.set(piece.pos + piece.count, i + matched);
    if (piece.count < 2) this.pop();
    return i + matched; // any closers left over are a new run
  }

  /** Steps over a closed comment or an extension tag at `i`, recording its end. */
  private opaque(i: number): number {
    const end = this.src.startsWith("<!--", i) ? this.commentEnd(i) : this.extensionTagEnd(i);
    if (end < 0) return i + 1;
    this.ends.set(i, end);
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
