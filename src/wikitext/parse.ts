/**
 * @copyright Thomas Foster
 *
 * The wikitext parser (issue #1065): raw wikitext in, a typed {@link Document}
 * out. Fail-soft by construction — every helper either consumes a
 * well-formed construct or leaves the cursor untouched so its opening
 * delimiter degrades to {@link Text}. The parser therefore *never throws*
 * and *always tiles* its input (see the invariants in
 * {@link module:lib/wikitext/ast}), which is what makes the round-trip and
 * fuzz guarantees hold.
 *
 * ## Design notes (the decisions the issue left open)
 *
 * - **Tokenizer granularity.** There is no discrete pre-tokenization pass:
 *   the scanner *is* the tokenizer, reading the source character by
 *   character with a single mutable cursor and recursing on structural
 *   delimiters. This keeps every byte accounted for (essential for exact
 *   round-trip) and avoids a second representation to keep in sync.
 * - **Brace disambiguation.** At a run of braces, a run of three or more is
 *   tried as an argument `{{{…}}}` first, then a template `{{…}}`; leftover
 *   braces fall through to text. This matches the common real cases; the
 *   round-trip guarantee holds for *any* disambiguation because the
 *   serializer is the exact inverse of whatever the parser chose.
 * - **Bold/italic.** Apostrophe runs become flat {@link Formatting} marker
 *   nodes carrying their literal apostrophes; the bold/italic *role* is
 *   resolved per line by {@link module:lib/wikitext/quotes} (MediaWiki's
 *   apostrophe-jungle algorithm). Marker nodes — rather than balanced
 *   open/close subtrees — keep round-trip trivial on the pathological input
 *   that apostrophes routinely produce.
 * - **HTML tags.** Extension tags (`nowiki`, `ref`, …) capture their body
 *   raw; presentational tags (`div`, `b`, …) are flat markers whose content
 *   is ordinary wikitext. See {@link Tag}.
 * - **Recursion is depth-bounded** ({@link MAX_DEPTH}) so adversarial deep
 *   nesting degrades to text instead of overflowing the stack.
 *
 * @module lib/wikitext/parse
 */

import {
  type Argument,
  type Comment,
  type Document,
  EXTENSION_TAGS,
  type ExternalLink,
  type Formatting,
  type Heading,
  type HtmlEntity,
  type Node,
  type Param,
  type Span,
  type Tag,
  type Template,
  type Text,
  type Wikilink,
} from "./ast.ts";
import { resolveQuotes } from "./quotes.ts";

/** Recursion ceiling; deeper nesting degrades to text (fail-soft, no throw). */
const MAX_DEPTH = 100;

/**
 * Recognised URL protocols for bracketed external links. Mirrors the common
 * subset of MediaWiki's `$wgUrlProtocols`. A `[` not followed by one of
 * these stays literal text.
 */
const PROTOCOL_RE =
  /^(?:(?:https?|ftps?|sftp|ssh|svn|git|gopher|ircs?|news|nntp|redis|tel|telnet|urn|worldwind|xmpp|magnet|mailto|bitcoin|geo|sips?|sms):|\/\/)/i;

/** Which top-level delimiters terminate the current fragment scan. */
interface Stop {
  readonly templateEnd?: boolean; // `}}`
  readonly argEnd?: boolean; // `}}}`
  readonly linkEnd?: boolean; // `]]`
  readonly extLinkEnd?: boolean; // `]`
  readonly pipe?: boolean; // `|`
  readonly equals?: boolean; // `=` (first, param name split)
}

/** Parses wikitext into a {@link Document}. Total and fail-soft. */
export function parse(source: string): Document {
  const parser = new Parser(source);
  const children = parser.parseFragment({}, 0, true);
  return {
    _tag: "Document",
    span: { start: 0, end: source.length },
    children,
    source,
  };
}

class Parser {
  private readonly src: string;
  private pos = 0;
  /**
   * The current scan boundary — the source length normally, temporarily
   * narrowed while parsing a bounded sub-region (a heading title) so nested
   * constructs cannot consume past it and break the tiling invariant.
   */
  private limit: number;
  /** Compiled close-tag matchers, memoised per extension-tag name. */
  private readonly closeTagRe = new Map<string, RegExp>();
  /**
   * Positions where a recursive open (template / argument / wikilink /
   * external link) already failed, so a later attempt at the same spot
   * returns immediately. Without this, adversarial delimiter storms
   * (`{{{{{{…`) backtrack exponentially — argument-then-template at every
   * position, each recursing. The memo collapses the work to O(n²) worst
   * case. Keyed by `(start, limit, kind)` since the same spot can be scanned
   * under a narrowed heading-title limit.
   */
  private readonly failed = new Set<number>();

  constructor(src: string) {
    this.src = src;
    this.limit = src.length;
  }

  private failKey(start: number, kind: number): number {
    return (start * (this.src.length + 1) + this.limit) * 4 + kind;
  }

  // ── fragment scanner ────────────────────────────────────────────────

  /**
   * Scans nodes until a top-level {@link Stop} delimiter (left unconsumed),
   * the current {@link limit}, or end of input. `block` enables heading
   * recognition (document level only); `depth` bounds recursion.
   */
  // reason: the scanner's central char-dispatch loop; CRAP is estimate-inflated because the audit runs without unit coverage — this is exercised by the parse/roundtrip suites.
  // fallow-ignore-next-line complexity
  parseFragment(stop: Stop, depth: number, block: boolean): Node[] {
    const nodes: Node[] = [];
    let textStart = this.pos;
    const flush = (end: number) => {
      if (end > textStart) nodes.push(this.text(textStart, end));
    };

    while (this.pos < this.limit) {
      if (this.atStop(stop)) break;
      const start = this.pos;
      let node: Node | null = null;

      if (depth < MAX_DEPTH) {
        switch (this.src.charCodeAt(this.pos)) {
          case 0x7b: // {
            node = this.tryBrace(depth);
            break;
          case 0x5b: // [
            node = this.tryBracket(depth);
            break;
          case 0x3c: // <
            node = this.tryAngle(depth);
            break;
          case 0x26: // &
            node = this.tryEntity();
            break;
          case 0x27: // '
            node = this.tryFormatting();
            break;
          case 0x3d: // =
            if (block && this.atLineStart(start)) node = this.tryHeading(depth);
            break;
          default:
            break;
        }
      }

      if (node) {
        flush(start);
        nodes.push(node);
        textStart = this.pos;
      } else {
        // Not the start of a construct (or one that failed to close): the
        // character belongs to the surrounding text run.
        this.pos++;
      }
    }

    flush(this.pos);
    return resolveQuotes(nodes, this.src);
  }

  private atLineStart(pos: number): boolean {
    return pos === 0 || this.src.charCodeAt(pos - 1) === 0x0a; // \n
  }

  // reason: delimiter-stop dispatch over a fixed char set; CRAP is estimate-inflated because the audit runs without unit coverage — covered by the parse/roundtrip suites.
  // fallow-ignore-next-line complexity
  private atStop(stop: Stop): boolean {
    switch (this.src.charCodeAt(this.pos)) {
      case 0x7c: // |
        return stop.pipe === true;
      case 0x3d: // =
        return stop.equals === true;
      case 0x5d: // ]
        if (stop.extLinkEnd) return true;
        return stop.linkEnd === true && this.src.charCodeAt(this.pos + 1) === 0x5d;
      case 0x7d: // }
        if (stop.argEnd && this.runOf(0x7d) >= 3) return true;
        return stop.templateEnd === true && this.src.charCodeAt(this.pos + 1) === 0x7d;
      default:
        return false;
    }
  }

  /** Length of the run of `code` starting at the cursor (within `limit`). */
  private runOf(code: number): number {
    let i = this.pos;
    while (i < this.limit && this.src.charCodeAt(i) === code) i++;
    return i - this.pos;
  }

  // ── braces: templates and arguments ─────────────────────────────────

  private tryBrace(depth: number): Node | null {
    const run = this.runOf(0x7b); // {
    if (run >= 3) {
      const arg = this.tryArgument(depth);
      if (arg) return arg;
    }
    if (run >= 2) return this.tryTemplate(depth);
    return null;
  }

  private tryArgument(depth: number): Argument | null {
    const start = this.pos;
    const key = this.failKey(start, 0);
    if (this.failed.has(key)) return null;
    this.pos += 3;
    const name = this.parseFragment({ argEnd: true, pipe: true }, depth + 1, false);
    let def: Node[] | undefined;
    if (this.src.charCodeAt(this.pos) === 0x7c) {
      this.pos++;
      def = this.parseFragment({ argEnd: true }, depth + 1, false);
    }
    if (this.runOf(0x7d) >= 3) {
      this.pos += 3;
      return { _tag: "Argument", span: this.span(start), name, default: def };
    }
    this.pos = start;
    this.failed.add(key);
    return null;
  }

  private tryTemplate(depth: number): Template | null {
    const start = this.pos;
    const key = this.failKey(start, 1);
    if (this.failed.has(key)) return null;
    this.pos += 2;
    const name = this.parseFragment({ templateEnd: true, pipe: true }, depth + 1, false);
    const params: Param[] = [];
    while (this.src.charCodeAt(this.pos) === 0x7c) {
      this.pos++;
      params.push(this.parseParam(depth));
    }
    if (this.atTemplateEnd()) {
      this.pos += 2;
      return { _tag: "Template", span: this.span(start), name, params };
    }
    this.pos = start;
    this.failed.add(key);
    return null;
  }

  private atTemplateEnd(): boolean {
    return (
      this.pos + 1 < this.limit &&
      this.src.charCodeAt(this.pos) === 0x7d &&
      this.src.charCodeAt(this.pos + 1) === 0x7d
    );
  }

  private parseParam(depth: number): Param {
    const first = this.parseFragment(
      { templateEnd: true, pipe: true, equals: true },
      depth + 1,
      false,
    );
    if (this.src.charCodeAt(this.pos) === 0x3d) {
      this.pos++; // =
      const value = this.parseFragment({ templateEnd: true, pipe: true }, depth + 1, false);
      return { name: first, value };
    }
    return { name: undefined, value: first };
  }

  // ── brackets: wikilinks and external links ──────────────────────────

  private tryBracket(depth: number): Node | null {
    if (this.src.charCodeAt(this.pos + 1) === 0x5b) return this.tryWikilink(depth);
    return this.tryExternalLink(depth);
  }

  private tryWikilink(depth: number): Wikilink | null {
    const start = this.pos;
    const key = this.failKey(start, 2);
    if (this.failed.has(key)) return null;
    this.pos += 2;
    const target = this.parseFragment({ linkEnd: true, pipe: true }, depth + 1, false);
    const segments: Node[][] = [];
    while (this.src.charCodeAt(this.pos) === 0x7c) {
      this.pos++;
      segments.push(this.parseFragment({ linkEnd: true, pipe: true }, depth + 1, false));
    }
    if (
      this.pos + 1 < this.limit &&
      this.src.charCodeAt(this.pos) === 0x5d &&
      this.src.charCodeAt(this.pos + 1) === 0x5d
    ) {
      this.pos += 2;
      return { _tag: "Wikilink", span: this.span(start), target, segments };
    }
    this.pos = start;
    this.failed.add(key);
    return null;
  }

  // reason: URL scan plus fail-soft cursor reset; CRAP is estimate-inflated because the audit runs without unit coverage — covered by parse.test.ts.
  // fallow-ignore-next-line complexity
  private tryExternalLink(depth: number): ExternalLink | null {
    const start = this.pos;
    const key = this.failKey(start, 3);
    if (this.failed.has(key)) return null;
    const urlStart = start + 1;
    if (!PROTOCOL_RE.test(this.src.slice(urlStart, Math.min(urlStart + 10, this.limit)))) {
      return null;
    }
    let i = urlStart;
    while (i < this.limit) {
      const c = this.src.charCodeAt(i);
      // URL body ends at whitespace, a closing `]`, or an angle bracket.
      if (
        c === 0x20 ||
        c === 0x09 ||
        c === 0x0a ||
        c === 0x0d ||
        c === 0x5d ||
        c === 0x3c ||
        c === 0x3e
      ) {
        break;
      }
      i++;
    }
    if (i === urlStart) return null;
    const url = this.src.slice(urlStart, i);
    this.pos = i;
    let label: Node[] | undefined;
    if (this.src.charCodeAt(this.pos) !== 0x5d) {
      label = this.parseFragment({ extLinkEnd: true }, depth + 1, false);
    }
    if (this.src.charCodeAt(this.pos) === 0x5d) {
      this.pos++;
      return { _tag: "ExternalLink", span: this.span(start), url, label };
    }
    this.pos = start;
    this.failed.add(key);
    return null;
  }

  // ── angle brackets: comments and tags ───────────────────────────────

  private tryAngle(depth: number): Node | null {
    if (this.src.startsWith("<!--", this.pos)) return this.parseComment();
    return this.tryTag(depth);
  }

  private parseComment(): Comment {
    const start = this.pos;
    const idx = this.src.indexOf("-->", start + 4);
    if (idx === -1 || idx + 3 > this.limit) {
      // Unclosed within the current region: absorb the rest (MediaWiki).
      const text = this.src.slice(start + 4, this.limit);
      this.pos = this.limit;
      return { _tag: "Comment", span: this.span(start), text, closed: false };
    }
    const text = this.src.slice(start + 4, idx);
    this.pos = idx + 3;
    return { _tag: "Comment", span: this.span(start), text, closed: true };
  }

  // reason: tag name / attribute / extension-body scan with several fail-soft exits; CRAP is estimate-inflated because the audit runs without unit coverage — covered by parse.test.ts.
  // fallow-ignore-next-line complexity
  private tryTag(_depth: number): Tag | null {
    const start = this.pos;
    let i = start + 1;
    let closing = false;
    if (this.src.charCodeAt(i) === 0x2f) {
      closing = true; // /
      i++;
    }
    const nameStart = i;
    while (i < this.limit && isNameChar(this.src.charCodeAt(i))) i++;
    if (i === nameStart) return null; // no tag name → `<` is text
    const name = this.src.slice(nameStart, i).toLowerCase();

    // Scan to the closing `>`, respecting quoted attribute values.
    let quote = 0;
    while (i < this.limit) {
      const c = this.src.charCodeAt(i);
      if (quote) {
        if (c === quote) quote = 0;
      } else if (c === 0x22 || c === 0x27) {
        quote = c; // " or '
      } else if (c === 0x3e) {
        break; // >
      } else if (c === 0x3c) {
        return null; // nested `<` before `>` → malformed, `<` is text
      }
      i++;
    }
    if (i >= this.limit) return null; // no `>` → `<` is text
    const selfClosing = this.src.charCodeAt(i - 1) === 0x2f;
    const raw = this.src.slice(start, i + 1);
    this.pos = i + 1;

    if (closing || selfClosing || !EXTENSION_TAGS.has(name)) {
      return this.markerTag(start, name, closing, selfClosing, raw);
    }

    // Extension tag: capture the body raw up to a matching close tag.
    const close = this.findCloseTag(name, this.pos);
    if (!close) {
      // Open-only: leave the following content to ordinary parsing.
      return this.markerTag(start, name, false, false, raw);
    }
    const rawContent = this.src.slice(this.pos, close.start);
    const closeRaw = this.src.slice(close.start, close.end);
    this.pos = close.end;
    return {
      _tag: "Tag",
      span: this.span(start),
      name,
      closing: false,
      selfClosing: false,
      raw,
      rawContent,
      closeRaw,
    };
  }

  private markerTag(
    start: number,
    name: string,
    closing: boolean,
    selfClosing: boolean,
    raw: string,
  ): Tag {
    return {
      _tag: "Tag",
      span: this.span(start),
      name,
      closing,
      selfClosing,
      raw,
      rawContent: undefined,
      closeRaw: undefined,
    };
  }

  private findCloseTag(name: string, from: number): { start: number; end: number } | null {
    let re = this.closeTagRe.get(name);
    if (!re) {
      re = new RegExp(`</${escapeRegExp(name)}\\s*>`, "ig");
      this.closeTagRe.set(name, re);
    }
    re.lastIndex = from;
    const m = re.exec(this.src);
    if (!m || m.index + m[0].length > this.limit) return null;
    return { start: m.index, end: m.index + m[0].length };
  }

  // ── entities ────────────────────────────────────────────────────────

  // reason: named / decimal / hex entity scan; CRAP is estimate-inflated because the audit runs without unit coverage — covered by parse.test.ts.
  // fallow-ignore-next-line complexity
  private tryEntity(): HtmlEntity | null {
    const start = this.pos;
    let i = start + 1;
    if (this.src.charCodeAt(i) === 0x23) {
      i++; // #
      const c = this.src.charCodeAt(i);
      if (c === 0x78 || c === 0x58) {
        i++; // x / X
        const hexStart = i;
        while (i < this.limit && isHexDigit(this.src.charCodeAt(i))) i++;
        if (i === hexStart) return null;
      } else {
        const digStart = i;
        while (i < this.limit && isDigit(this.src.charCodeAt(i))) i++;
        if (i === digStart) return null;
      }
    } else {
      const nameStart = i;
      while (i < this.limit && isAlnum(this.src.charCodeAt(i))) i++;
      if (i === nameStart) return null;
    }
    if (this.src.charCodeAt(i) !== 0x3b) return null; // ;
    i++;
    this.pos = i;
    return { _tag: "HtmlEntity", span: this.span(start), raw: this.src.slice(start, i) };
  }

  // ── apostrophe formatting (roles resolved later, see quotes.ts) ──────

  private tryFormatting(): Formatting | null {
    const run = this.runOf(0x27); // '
    if (run < 2) return null;
    const start = this.pos;
    this.pos += run;
    return {
      _tag: "Formatting",
      span: this.span(start),
      marks: this.src.slice(start, start + run),
      mode: "italic",
      leadingLiterals: 0,
    };
  }

  // ── headings (block level, whole line) ──────────────────────────────

  private tryHeading(depth: number): Heading | null {
    const start = this.pos;
    let lineEnd = this.src.indexOf("\n", start);
    if (lineEnd === -1) lineEnd = this.limit;
    const line = this.src.slice(start, lineEnd);
    const m = /^(={1,6})([\s\S]*?)(={1,6})([ \t]*)$/.exec(line);
    if (!m) return null;
    const [, left, inner, right, trailing] = m;
    const innerStart = start + left.length;
    // Parse the title over its bounded region: narrow `limit` so nested
    // constructs cannot reach past the closing equals run, then restore.
    const savedLimit = this.limit;
    this.pos = innerStart;
    this.limit = innerStart + inner.length;
    const title = this.parseFragment({}, depth + 1, false);
    this.limit = savedLimit;
    this.pos = lineEnd;
    return {
      _tag: "Heading",
      span: this.span(start),
      level: Math.min(left.length, right.length),
      leftEquals: left,
      rightEquals: right,
      title,
      trailing,
    };
  }

  // ── node helpers ────────────────────────────────────────────────────

  private text(start: number, end: number): Text {
    return { _tag: "Text", span: { start, end }, text: this.src.slice(start, end) };
  }

  private span(start: number): Span {
    return { start, end: this.pos };
  }
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function isHexDigit(c: number): boolean {
  return isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}

function isAlpha(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

function isAlnum(c: number): boolean {
  return isAlpha(c) || isDigit(c);
}

/** Tag-name characters: a letter, then letters/digits. */
function isNameChar(c: number): boolean {
  return isAlnum(c);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
