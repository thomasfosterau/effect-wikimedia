/**
 * The wikitext parser (website#1065): raw wikitext in, a typed {@link Document}
 * out. Fail-soft by construction — every construct either matches whole or
 * fails without consuming input, so its opening delimiter degrades to
 * {@link Text}. The parser therefore *never throws* and *always tiles* its
 * input (see the invariants in `./ast.ts`), which is what makes the
 * round-trip and fuzz guarantees hold.
 *
 * ## Design notes (the decisions website#1065 left open)
 *
 * - **Parser combinators (#168).** The grammar is written with
 *   `@thomasfosterau/effect-parse`: each construct (template, argument,
 *   wikilink, external link, autolink, comment, tag, entity, apostrophe run,
 *   heading, table) is a `Parser` over the source string, composed from
 *   literals, token sets, `alt`, `seq`, `repeat` and `dispatch`. Its cursor
 *   is the scanner: there is no pre-tokenization pass, so every byte is
 *   accounted for (essential for exact round-trip). The few steps that need
 *   per-parse state or move the cursor non-locally (the fragment loop, the
 *   table line scans) are `Parser.make` steps over the same cursor.
 * - **Per-parse state** lives in the `Session` service in the parse
 *   `State`'s context: the failed-open memo, the nesting depth and the
 *   table scans' bracket map. A bounded region (a heading title, a table
 *   cell) narrows `State.end`, so nested constructs cannot consume past it.
 * - **Brace disambiguation.** At a run of braces, a run of three or more is
 *   tried as an argument `{{{…}}}` first, then a template `{{…}}`; leftover
 *   braces fall through to text. This matches the common real cases; the
 *   round-trip guarantee holds for *any* disambiguation because the
 *   serializer is the exact inverse of whatever the parser chose.
 * - **Bold/italic.** Apostrophe runs become flat {@link Formatting} marker
 *   nodes carrying their literal apostrophes; the bold/italic *role* is
 *   resolved per line by `./quotes.ts` (MediaWiki's
 *   apostrophe-jungle algorithm). Marker nodes — rather than balanced
 *   open/close subtrees — keep round-trip trivial on the pathological input
 *   that apostrophes routinely produce.
 * - **HTML tags.** Extension tags (`nowiki`, `ref`, …) capture their body
 *   raw; presentational tags (`div`, `b`, …) are flat markers whose content
 *   is ordinary wikitext. See {@link Tag}.
 * - **Recursion is depth-bounded** ({@link MAX_DEPTH}) so adversarial deep
 *   nesting degrades to text instead of overflowing the stack.
 *
 * @copyright Thomas Foster
 * @module wikitext/parse
 */

import { Ascii, Input, Parser, Token } from "@thomasfosterau/effect-parse";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as HashSet from "effect/HashSet";
import * as Match from "effect/Match";
import * as MutableHashMap from "effect/MutableHashMap";
import * as MutableHashSet from "effect/MutableHashSet";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import {
  type Argument,
  type AutoLink,
  type Comment,
  type Document,
  EXTENSION_TAGS,
  type ExternalLink,
  type Formatting,
  type Heading,
  type HtmlEntity,
  type Node,
  type Span,
  type Param,
  type Table,
  type TableCaption,
  type TableCell,
  type TableRow,
  type Tag,
  type Template,
  type Text,
  type Wikilink,
} from "./ast.ts";
import { type BracketEnds, matchBrackets } from "./brackets.ts";
import { resolveQuotes } from "./quotes.ts";

/** Recursion ceiling; deeper nesting degrades to text (fail-soft, no throw). */
const MAX_DEPTH = 100;

const NEWLINE = 0x0a;
const PIPE = 0x7c;
const BANG = 0x21;
const SLASH = 0x2f;
const SEMICOLON = 0x3b;
const APOSTROPHE = 0x27;

/** The cursor every parser here reads: the source string. */
type State = Input.State<string>;

/** The per-parse state the grammar shares (see {@link Session}). */
interface SessionState {
  /**
   * Opens (template / argument / wikilink / external link / table) that
   * already failed, keyed by offset, region end and kind (see
   * `memoFailure`), so a later attempt at the same spot
   * returns at once. Without this, adversarial delimiter storms (`{{{{{{…`)
   * backtrack exponentially — argument-then-template at every position, each
   * recursing. The memo collapses the work to O(n²) worst case. The key
   * includes the region end, since the same spot can be scanned under a
   * narrowed heading-title or table-cell bound.
   */
  readonly failed: MutableHashSet.MutableHashSet<number>;
  /**
   * For each offset, a bit per kind (`1 << kind`) set once anything of that
   * kind failed there, under any region end: a check that rules out most
   * lookups in `failed` without hashing.
   */
  readonly failedKinds: Uint8Array;
  /** How many fragments enclose the cursor; constructs stop at {@link MAX_DEPTH}. */
  depth: number;
  /**
   * Where each bracketed construct in the source ends (`matchBrackets`),
   * built on the first table scan that needs it.
   */
  nestedEnds: BracketEnds | undefined;
  /** The last search for each closing delimiter (see {@link nextClose}), keyed by delimiter. */
  readonly closes: MutableHashMap.MutableHashMap<string, CloseSearch>;
  /**
   * Where a stopped fragment ran to the region end (see `fragment`): for
   * each {@link Stop} (by `id`), the region end plus one at each offset a
   * fragment with that stop started from and ran to that end without
   * meeting it, or `0`. Built for a stop when the first such fragment ends.
   */
  readonly doomed: Int32Array[];
  /**
   * Where each nested table a table's filler steps over ends (see
   * `nestedTableEnd`), keyed by its `{|` line's offset and the region end.
   */
  readonly tableEnds: MutableHashMap.MutableHashMap<number, number>;
}

/** A match of a closing delimiter in the source: where it starts, and its length. */
interface CloseMatch {
  readonly index: number;
  readonly length: number;
}

/** One {@link nextClose} search: the offset it ran from, and its first match (if any). */
interface CloseSearch {
  readonly from: number;
  readonly match: CloseMatch | undefined;
}

/** The per-parse state, provided to the grammar through the parse context. */
class Session extends Context.Service<Session, SessionState>()(
  "effect-wikimedia/WikitextSession",
) {}

/** A parser over wikitext source that reads the parse's {@link Session}. */
type WikiParser<A> = Parser.Parser<A, never, Session>;

const session = (state: State): SessionState =>
  // SAFETY: every `WikiParser` runs only on the cursor `parse` builds, whose
  // context is `Context.make(Session, …)`; the cursor's own type erases it.
  Context.get(state.context as Context.Context<Session>, Session);

const literal = Token.literal;
const pipe = literal("|");

// ── custom combinators ────────────────────────────────────────────────

/**
 * The kinds of open the failure memo distinguishes, and the `|`-separated
 * tails of templates and wikilinks (see {@link segmentsThenClose}).
 */
const Open = {
  Argument: 0,
  Template: 1,
  Wikilink: 2,
  ExternalLink: 3,
  Table: 4,
  TemplateTail: 5,
  WikilinkTail: 6,
} as const;
const OPEN_KINDS = 7;

type OpenKind = (typeof Open)[keyof typeof Open];

/** Whether `kind` already failed at `pos` under the current region end. */
function hasFailed(state: State, s: SessionState, pos: number, kind: OpenKind): boolean {
  return (
    (s.failedKinds[pos] & (1 << kind)) !== 0 &&
    MutableHashSet.has(s.failed, (pos * (state.input.length + 1) + state.end) * OPEN_KINDS + kind)
  );
}

/** Records that `kind` failed at `pos` under the current region end. */
function addFailed(state: State, s: SessionState, pos: number, kind: OpenKind): void {
  s.failedKinds[pos] |= 1 << kind;
  MutableHashSet.add(s.failed, (pos * (state.input.length + 1) + state.end) * OPEN_KINDS + kind);
}

/**
 * Fails at once where `self` already failed at this offset under this region
 * end (see {@link SessionState.failed}), and records each new failure.
 */
function memoFailure<A>(kind: OpenKind, self: WikiParser<A>): WikiParser<A> {
  return Parser.make((state) => {
    const s = session(state);
    const pos = state.pos;
    if (hasFailed(state, s, pos, kind)) return state.backtrack("Fail");
    const a = self.step(state);
    if (a === Input.Fail) addFailed(state, s, pos, kind);
    return a;
  });
}

/**
 * `segment`s each after a `|`, then `close`: the tail of a template (its
 * parameters, then `}}`) or of a wikilink (its segments, then `]]`). When
 * it fails, it fails from every `|` it passed, so those are remembered
 * (under `kind`, as in {@link memoFailure}) and a later tail that reaches
 * one fails at once.
 *
 * Openers that close only at the page end each nest the next, so they share
 * their tails: without this, a page of lines each opening a template, with
 * a `|` between them, would have every template up to {@link MAX_DEPTH}
 * deep parse each later line as one of its parameters (#179).
 */
function segmentsThenClose<A>(
  kind: OpenKind,
  segment: WikiParser<A>,
  close: string,
): WikiParser<A[]> {
  const closing = literal(close);
  return Parser.make((state) => {
    const s = session(state);
    const passed: number[] = [];
    const segments: A[] = [];
    for (;;) {
      if (hasFailed(state, s, state.pos, kind)) break;
      passed.push(state.pos);
      if (closing.step(state) !== Input.Fail) return segments;
      const at = state.pos;
      const next = pipe.step(state) === Input.Fail ? Input.Fail : segment.step(state);
      if (next === Input.Fail) {
        state.pos = at;
        break;
      }
      segments.push(next);
    }
    Arr.forEach(passed, (pos) => addFailed(state, s, pos, kind));
    return state.backtrack("Fail");
  });
}

/**
 * The first match of a closing delimiter at or after `from` anywhere in the
 * source (not only the current region), found by `search`, which must
 * return the leftmost match at or after the offset it is given. The last
 * search per `key` is remembered: its match is also the first one for any
 * later offset up to that match (or, with no match, any later offset at
 * all), so a run of unclosed openers (`<!--`, `<ref>`, `{|`) costs one scan
 * of the source rather than one per opener (#152, #159).
 */
function nextClose(
  state: State,
  key: string,
  from: number,
  search: (from: number) => CloseMatch | undefined,
): CloseMatch | undefined {
  const closes = session(state).closes;
  const last = Option.getOrUndefined(MutableHashMap.get(closes, key));
  if (
    last !== undefined &&
    last.from <= from &&
    (last.match === undefined || from <= last.match.index)
  ) {
    return last.match;
  }
  const match = search(from);
  MutableHashMap.set(closes, key, { from, match });
  return match;
}

/** {@link nextClose} for a fixed string. */
function nextLiteral(state: State, needle: string, from: number): CloseMatch | undefined {
  return nextClose(state, needle, from, (at) => {
    const index = state.input.indexOf(needle, at);
    return index < 0 ? undefined : { index, length: needle.length };
  });
}

/** Whether `match` lies wholly within the current region. */
const endsInRegion = (state: State, match: CloseMatch | undefined): match is CloseMatch =>
  match !== undefined && match.index + match.length <= state.end;

/**
 * Succeeds, consuming nothing, when `close` occurs in the rest of the
 * region, and fails otherwise. A construct that can only end at `close`
 * checks this first, so a run of unclosed openers fails each at once
 * instead of scanning the rest of the input each (#159).
 */
const canClose = (close: string): WikiParser<void> =>
  Parser.make((state) =>
    endsInRegion(state, nextLiteral(state, close, state.pos))
      ? undefined
      : state.backtrack("Verify"),
  );

/** Runs `self` one nesting level deeper (see {@link MAX_DEPTH}). */
function nested<A>(self: WikiParser<A>): WikiParser<A> {
  return Parser.make((state) => {
    const s = session(state);
    s.depth++;
    const a = self.step(state);
    s.depth--;
    return a;
  });
}

/**
 * Parses `[start, end)` alone with `fragment` (narrowing the region so
 * nothing nested can reach past `end`), then leaves the cursor at `end`.
 */
function fragmentWithin(
  state: State,
  start: number,
  end: number,
  fragment: WikiParser<Node[]>,
): Node[] {
  const savedEnd = state.end;
  state.pos = start;
  state.end = end;
  const nodes = fragment.step(state);
  state.end = savedEnd;
  state.pos = end;
  return nodes === Input.Fail ? [] : nodes;
}

const atLineStart = (state: State, pos: number): boolean =>
  pos === 0 || state.input.charCodeAt(pos - 1) === NEWLINE;

/** Succeeds, consuming nothing, at the start of a line. */
const lineStart: WikiParser<void> = Parser.make((state) =>
  atLineStart(state, state.pos) ? undefined : state.backtrack("Verify"),
);

// ── fragments ────────────────────────────────────────────────────────

/**
 * Characters that may start a construct or a stop delimiter. Text between
 * them is taken in one run; at one of them the constructs are tried first.
 */
const SPECIAL = "{[<&'=hH|]}";
const PLAIN_TEXT = Token.takeTill(SPECIAL, { min: 1 });

/**
 * A membership table for a set of ASCII characters, indexed by char code: a
 * lookup the fragment loop makes at every special character, so cheaper
 * than a `Set` (anything at or above 0x80 reads `undefined`, i.e. absent).
 */
function asciiTable(chars: Iterable<string>): Uint8Array {
  const table = new Uint8Array(0x80);
  Arr.forEach(Arr.fromIterable(chars), (c) => {
    table[c.charCodeAt(0)] = 1;
  });
  return table;
}

const SPECIAL_CODES = asciiTable(SPECIAL);

const text = (src: string, start: number, end: number): Text => ({
  _tag: "Text",
  span: { start, end },
  text: src.slice(start, end),
});

/**
 * The delimiters that end a fragment, such as `}}` and `|` inside a
 * template. `first` holds their first characters, so the fragment tries
 * `parser` only where one of them can start.
 */
interface Stop {
  /** Tells stops apart: an index into {@link SessionState.doomed}. */
  readonly id: number;
  readonly delimiters: readonly string[];
  readonly first: Uint8Array;
  readonly parser: WikiParser<unknown>;
}

let stops = 0;

const stopAt = (...delimiters: readonly string[]): Stop => ({
  id: stops++,
  delimiters,
  first: asciiTable(delimiters.map((d) => d[0])),
  parser: Parser.alt(...delimiters.map((d) => literal(d))),
});

/** Whether a {@link Stop} delimiter starts at the cursor (consuming nothing). */
function atStop(state: State, stop: Stop): boolean {
  if (stop.first[state.input.charCodeAt(state.pos)] !== 1) return false;
  const start = state.pos;
  const matched = stop.parser.step(state) !== Input.Fail;
  state.pos = start;
  return matched;
}

/**
 * Where the first `stop` delimiter at or after the cursor starts, when one
 * ends within the region; otherwise the region end. Every delimiter starts
 * with a {@link SPECIAL} character, so this is where a fragment that opens
 * no construct stops. The searches are {@link nextClose}'s, so a run of
 * such fragments over the same text scans it once (#179).
 */
function firstStop(state: State, stop: Stop): number {
  return Arr.reduce(stop.delimiters, state.end, (first, delimiter) => {
    const match = nextLiteral(state, delimiter, state.pos);
    return endsInRegion(state, match) ? Math.min(first, match.index) : first;
  });
}

/**
 * Records that a fragment with `stop` ran from `from` to the region end
 * without meeting it, so a later one with the same stop and region end
 * that reaches `from` jumps to that end (see `fragment`; #179).
 *
 * A fragment's walk from an offset depends only on that offset, its stop
 * and the region end, so the later walk would run to the end as well. Every
 * construct a stopped fragment sits in needs its closing delimiter after
 * the fragment, so a fragment that runs to the region end dooms it: the
 * nodes the jump skips are never used. Without this, a page of openers
 * closed only at its end (`{{` repeated) costs time quadratic in its length,
 * or nearly so: each opener nests the next, up to {@link MAX_DEPTH}, and
 * once the innermost has failed each enclosing fragment walks on over the
 * rest of the page, resuming one character past the opener that failed and
 * so reaching where that opener's own fragment started. Like the failure
 * memo (`memoFailure`), this ignores the nesting depth, which can change a
 * walk only once {@link MAX_DEPTH} cuts it short.
 */
function markDoomed(state: State, stop: Stop, from: number): void {
  const doomed = session(state).doomed;
  const marks = doomed[stop.id] ?? new Int32Array(state.input.length + 1);
  doomed[stop.id] = marks;
  marks[from] = state.end + 1;
}

/**
 * A run of nodes up to `stop` (left unconsumed), the region end, or the end
 * of input; never fails. `block` enables the line-level constructs
 * (headings, tables). Text between constructs is coalesced into one
 * {@link Text} node, and the run's apostrophe markers are resolved by
 * `resolveQuotes`.
 */
function fragment(stop: Stop | undefined, block: boolean): WikiParser<Node[]> {
  return Parser.make((state) => {
    const { construct, opens } = block ? blockConstructs : inlineConstructs;
    const src = state.input;
    // Constant for this run: every construct restores the region end
    // before it returns.
    const end = state.end;
    const nodes: Node[] = [];
    const from = state.pos;
    let textStart = from;
    if (session(state).depth >= MAX_DEPTH) {
      // Too deep to open a construct: the fragment is one text run up to its
      // stop. Found by search rather than by walking it, since every opener
      // tried one level up walks it again: a page of openers closed only at
      // its end would cost time quadratic in its length (#179).
      state.pos = stop === undefined ? end : firstStop(state, stop);
      pushText(nodes, src, textStart, state.pos);
      return nodes;
    }
    const doomed = session(state).doomed;
    // Whether an apostrophe run (a `Formatting` marker, the only construct
    // opening at `'`) was taken, so `resolveQuotes` has anything to do.
    let quotes = false;
    while (state.pos < end) {
      const start = state.pos;
      if (stop !== undefined && doomed[stop.id]?.[start] === end + 1) {
        // A fragment with this stop already ran from here to the region end.
        state.pos = end;
        break;
      }
      const c = src.charCodeAt(start);
      if (SPECIAL_CODES[c] !== 1) {
        PLAIN_TEXT.step(state);
        continue;
      }
      if (stop !== undefined && atStop(state, stop)) break;
      const node = opens[c] !== 1 ? Input.Fail : construct.step(state);
      if (node === Input.Fail) {
        // Not the start of a construct (or one that failed to close): the
        // character belongs to the surrounding text run.
        state.pos = start + 1;
        continue;
      }
      pushText(nodes, src, textStart, start);
      nodes.push(node);
      textStart = state.pos;
      quotes ||= c === APOSTROPHE;
    }
    if (stop !== undefined && state.pos >= end) markDoomed(state, stop, from);
    pushText(nodes, src, textStart, state.pos);
    return quotes ? resolveQuotes(nodes, src) : nodes;
  });
}

/** Appends the text run `src[from, to)` to `nodes`, unless it is empty. */
function pushText(nodes: Node[], src: string, from: number, to: number): void {
  if (to > from) nodes.push(text(src, from, to));
}

/** A fragment nested in a construct, one level deeper. */
const inner = (stop: Stop | undefined, block = false): WikiParser<Node[]> =>
  nested(fragment(stop, block));

const argumentName = inner(stopAt("}}}", "|"));
const argumentDefault = inner(stopAt("}}}"));
const templatePart = inner(stopAt("}}", "|"));
const paramName = inner(stopAt("}}", "|", "="));
const linkPart = inner(stopAt("]]", "|"));
const externalLabel = inner(stopAt("]"));
const headingTitle = inner(undefined);
const cellContent = inner(undefined, true);

// ── braces: templates and arguments ───────────────────────────────────

const argument: WikiParser<Argument> = memoFailure(
  Open.Argument,
  Parser.map(
    Parser.withSpan(
      Parser.seq(
        literal("{{{"),
        canClose("}}}"),
        argumentName,
        Parser.optional(Parser.preceded(pipe, argumentDefault)),
        literal("}}}"),
      ),
    ),
    ([[, , name, def], span]): Argument => ({ _tag: "Argument", span, name, default: def }),
  ),
);

const param: WikiParser<Param> = Parser.map(
  Parser.seq(paramName, Parser.optional(Parser.preceded(literal("="), templatePart))),
  ([first, value]): Param =>
    value === undefined ? { name: undefined, value: first } : { name: first, value },
);

const template: WikiParser<Template> = memoFailure(
  Open.Template,
  Parser.map(
    Parser.withSpan(
      Parser.seq(
        literal("{{"),
        canClose("}}"),
        templatePart,
        segmentsThenClose(Open.TemplateTail, param, "}}"),
      ),
    ),
    ([[, , name, params], span]): Template => ({ _tag: "Template", span, name, params }),
  ),
);

// ── tables ────────────────────────────────────────────────────────────
//
// A table is line-oriented: `{|` and its attribute line, then caption
// (`|+`), row (`|-`) and cell (`|` / `!`) marker lines up to `|}`. Each
// marker's attribute text runs to the end of its *logical* line, and a
// cell's content runs on across the non-marker lines that follow it. Cell
// and caption *content* is ordinary wikitext, parsed by a fragment bounded
// to the cell (see `fragmentWithin`), so nested constructs — including a
// nested table — parse normally.
//
// The scans that find a table's structure (where a line ends, the `||`/`!!`
// cell separators, a cell's attribute `|`) step over every nested construct
// whose `|`, `!` or line break belongs to it rather than to the table: a
// template, argument, wikilink, closed comment or extension tag (#132; see
// `findTopLevel`). MediaWiki gets the same effect, wikilinks aside, by
// building tables only after its preprocessor has expanded templates and
// hidden comments and extension tags. Line-start markers are therefore read
// per *logical* line, one whose breaks inside such constructs don't count;
// the filler scan also tracks `{|`/`|}` nesting so a nested table's own
// row/cell lines aren't mistaken for this table's structure.

/**
 * The index just past the nested construct opening at `at` whose `|`, `!`
 * and line breaks belong to it rather than to a table: a template or
 * argument, a wikilink, a closed comment, or an extension tag (body
 * included), as `matchBrackets` matched them. Otherwise `at + 1`, so an
 * opener that never closes is literal text, as MediaWiki's preprocessor
 * reads it. One that closes past the region end is literal too, so a nested
 * table's scan stays inside its cell even where the matcher and the
 * grammar disagree about a construct.
 */
function skipNested(state: State, at: number): number {
  const c = state.input.charCodeAt(at);
  if (c !== 0x7b && c !== 0x5b && c !== 0x3c) return at + 1; // only `{`, `[` and `<` open one
  const s = session(state);
  s.nestedEnds ??= matchBrackets(state.input, (i) => extensionTagEnd(state, i));
  const end = s.nestedEnds[at];
  return end > at && end <= state.end ? end : at + 1;
}

/**
 * The first index in `[from, to)` at which `test` holds, stepping over each
 * nested construct (see `skipNested`); `to` when there is none.
 */
function findTopLevel(
  state: State,
  from: number,
  to: number,
  test: (i: number) => boolean,
): number {
  let i = from;
  while (i < to) {
    if (test(i)) return i;
    i = skipNested(state, i);
  }
  return to;
}

/**
 * End of the logical line containing `pos`: the first `\n` outside a nested
 * construct (see `findTopLevel`), exclusive, or the region end. A
 * multi-line template in a cell is therefore part of the line that opens it.
 */
const tableLineEnd = (state: State, pos: number): number =>
  findTopLevel(state, pos, state.end, (i) => state.input.charCodeAt(i) === NEWLINE);

/** The rest of the logical line, and the newline that ends it. */
const logicalLine: WikiParser<void> = Parser.make((state) => {
  const end = tableLineEnd(state, state.pos);
  state.pos = end < state.end ? end + 1 : end;
});

const isTableMarker = (c: number): boolean => c === BANG || c === PIPE;

/**
 * From a line start, whole logical lines that are not one of this table's
 * own marker lines (`|}`, `|-`, `|+`, `!`, `|`), tracking `{|`/`|}` nesting
 * so a nested table's interior is skipped rather than mistaken for this
 * table's structure. Stops exactly at the next marker line, or the region end.
 */
const tableFiller: WikiParser<void> = Parser.make((state) => {
  const src = state.input;
  while (state.pos < state.end && !isTableMarker(src.charCodeAt(state.pos))) {
    if (src.startsWith("{|", state.pos)) state.pos = nestedTableEnd(state, state.pos);
    else logicalLine.step(state);
  }
});

/**
 * Where the nested table whose `{|` line starts at `at` ends: just past the
 * logical line of the `|}` that brings the `{|`/`|}` nesting back to where
 * it was at `at`, or the region end when none does. Each answer is
 * remembered per region end, with those for the tables nested inside it, so
 * a page of `{|` lines closed only at its end, or not at all, scans each
 * line once rather than once per enclosing `{|` (#179).
 */
function nestedTableEnd(state: State, at: number): number {
  const s = session(state);
  const key = (pos: number): number => pos * (state.input.length + 1) + state.end;
  const src = state.input;
  // The `{|` lines open since `at`, innermost last.
  const open: number[] = [];
  let pos = at;
  do {
    const line = pos;
    const end = src.startsWith("{|", line)
      ? MutableHashMap.get(s.tableEnds, key(line))
      : Option.none<number>();
    if (Option.isSome(end)) {
      pos = end.value;
    } else {
      if (src.startsWith("{|", line)) open.push(line);
      state.pos = line;
      logicalLine.step(state);
      pos = state.pos;
      const closed = src.startsWith("|}", line) ? open.pop() : undefined;
      if (closed !== undefined) MutableHashMap.set(s.tableEnds, key(closed), pos);
    }
  } while (pos < state.end && Arr.isReadonlyArrayNonEmpty(open));
  // The `{|` lines still open close only at the region end.
  Arr.forEach(open, (line) => MutableHashMap.set(s.tableEnds, key(line), state.end));
  return Option.getOrElse(MutableHashMap.get(s.tableEnds, key(at)), () => state.end);
}

/** A marker's attribute text: the rest of its logical line, then any filler. */
const markerLine: WikiParser<string> = Parser.taken(Parser.seq(logicalLine, tableFiller));

const trailingNewline = Parser.optional(literal("\n"));

/**
 * MediaWiki's single-pipe cell/caption attribute rule (`Parser::doTableStuff`):
 * the first `|` in `[from, to)` outside a nested construct (see
 * `findTopLevel`) splits attributes from content, *unless* a `[[` or a
 * `-{` comes before it (MediaWiki's guard, `/\[\[|-\{/`, against reading a
 * wikilink's or a LanguageConverter rule's surroundings as attributes; #158).
 */
interface CellSplit {
  /** The attribute text, or `undefined` when no attribute `|` splits the cell. */
  readonly attrs: string | undefined;
  /** Where the cell's content starts. */
  readonly contentStart: number;
}

function splitCellAttrs(state: State, from: number, to: number): CellSplit {
  const src = state.input;
  const at = findTopLevel(state, from, to, (i) => {
    const c = src.charCodeAt(i);
    const next = src.charCodeAt(i + 1);
    return c === PIPE || (c === 0x5b && next === 0x5b) || (c === 0x2d && next === 0x7b); // |, [[ or -{
  });
  if (at >= to || src.charCodeAt(at) !== PIPE) return { attrs: undefined, contentStart: from };
  return { attrs: src.slice(from, at), contentStart: at + 1 };
}

/** One `||`-separated piece of a cell or caption line (see `linePieces`). */
interface LinePiece {
  readonly span: Span;
  readonly marker: string;
  readonly attrs: string | undefined;
  readonly content: Node[];
}

/**
 * Splits the cell or caption line whose `markerLength`-character marker
 * starts at the cursor into pieces at each separator `isSep` finds outside
 * a nested construct (see `findTopLevel`), as MediaWiki's `handleTables`
 * explodes a line on `||`. Each piece is split into attributes and content
 * by the single-pipe rule; the last runs on through any following
 * non-marker lines. Leaves the cursor at the next marker line.
 *
 * Returns `None` when the last piece runs on to the region end: no
 * `|}` line follows, so the table cannot close, and its cells' content is
 * not parsed. Parsing it first would make a page of `{|` lines, each
 * opening a cell, cost time quadratic in its length, since each table's
 * cell would hold the rest of the page (#179).
 */
function linePieces(
  state: State,
  markerLength: number,
  isSep: (i: number) => boolean,
): Option.Option<LinePiece[]> {
  const lineEnd = tableLineEnd(state, state.pos);
  const pieces: LinePiece[] = [];
  let openStart = state.pos;
  let segStart = state.pos + markerLength;
  for (;;) {
    const sepIdx = findTopLevel(state, segStart, lineEnd, isSep);
    const hasMore = sepIdx < lineEnd;
    const { attrs, contentStart } = splitCellAttrs(state, segStart, sepIdx);
    let contentEnd = sepIdx;
    if (!hasMore) {
      state.pos = lineEnd;
      trailingNewline.step(state);
      tableFiller.step(state);
      contentEnd = state.pos;
      if (contentEnd >= state.end) return Option.none();
    }
    const content = fragmentWithin(state, contentStart, contentEnd, cellContent);
    const marker = state.input.slice(openStart, segStart);
    pieces.push({ span: { start: openStart, end: contentEnd }, marker, attrs, content });
    if (!hasMore) return Option.some(pieces);
    openStart = sepIdx;
    segStart = sepIdx + 2;
  }
}

/** Whether `||` starts at `i`. */
const isDoublePipe = (state: State, i: number): boolean =>
  state.input.charCodeAt(i) === PIPE && state.input.charCodeAt(i + 1) === PIPE;

/** Rewinds the cursor to `start` and fails, so the caller can try something else there. */
function backtrackTo(state: State, start: number): Input.Fail {
  state.pos = start;
  return state.backtrack("Verify");
}

/**
 * A `|+` caption line, split on `||` into one caption per piece, as
 * MediaWiki emits a `<caption>` per piece (#157).
 */
const tableCaptions: WikiParser<Omit<TableCaption, "row">[]> = Parser.make((state) => {
  const start = state.pos;
  if (literal("|+").step(state) === Input.Fail) return Input.Fail;
  state.pos = start;
  return Option.match(
    linePieces(state, 2, (i) => isDoublePipe(state, i)),
    {
      onNone: () => backtrackTo(state, start),
      onSome: (pieces) =>
        pieces.map(({ span, attrs, content }, i): Omit<TableCaption, "row"> => ({
          span,
          inline: i > 0,
          attrs,
          content,
        })),
    },
  );
});

/**
 * Every cell opened on a `!`/`|` marker line, the last one extended across
 * any following non-marker lines. A data line splits on `||`; a header line
 * on `!!` and `||` alike, since MediaWiki rewrites `!!` to `||` there before
 * splitting (#157). Leaves the cursor at the next marker line (or the
 * region end).
 */
const tableCells: WikiParser<TableCell[]> = Parser.make((state) => {
  const src = state.input;
  const first = src.charCodeAt(state.pos);
  if (state.pos >= state.end || !isTableMarker(first)) return state.backtrack("OneOf");
  const header = first === BANG;
  const isSep = (i: number): boolean =>
    isDoublePipe(state, i) ||
    (header && src.charCodeAt(i) === BANG && src.charCodeAt(i + 1) === BANG);
  const start = state.pos;
  return Option.match(linePieces(state, 1, isSep), {
    onNone: () => backtrackTo(state, start),
    onSome: (pieces) =>
      pieces.map(({ span, marker, attrs, content }, i): TableCell => ({
        span,
        header,
        inline: i > 0,
        // SAFETY: the first piece's marker is the line's `!` or `|`
        // (`isTableMarker`), every later one the `!!` or `||` `isSep` matched.
        marker: marker as TableCell["marker"],
        attrs,
        content,
      })),
  });
});

/** One item between a table's `{|` line and its `|}`. */
type TableItem =
  | { readonly _tag: "Row"; readonly start: number; readonly open: string }
  | { readonly _tag: "Captions"; readonly captions: Omit<TableCaption, "row">[] }
  | { readonly _tag: "Cells"; readonly cells: TableCell[] };

const tableItem: WikiParser<TableItem> = Parser.preceded(
  Parser.not(literal("|}")),
  Parser.alt(
    Parser.map(
      Parser.withSpan(Parser.preceded(literal("|-"), markerLine)),
      ([open, span]): TableItem => ({ _tag: "Row", start: span.start, open }),
    ),
    Parser.map(tableCaptions, (captions): TableItem => ({ _tag: "Captions", captions })),
    Parser.map(tableCells, (cells): TableItem => ({ _tag: "Cells", cells })),
  ),
);

/** A table's captions and rows (see {@link tableRows}). */
interface TableBody {
  readonly captions: TableCaption[];
  readonly rows: TableRow[];
}

/** {@link tableRows}' running state: the body so far and the row still open. */
interface TableBodyBuilder extends TableBody {
  row: { start: number; open: string | undefined; cells: TableCell[] } | undefined;
}

/** Closes the open row (if any) at `end`. */
function flushRow(body: TableBodyBuilder, end: number): void {
  const { row } = body;
  if (row) body.rows.push({ span: { start: row.start, end }, open: row.open, cells: row.cells });
  body.row = undefined;
}

/** Adds one item to the table body being built (see {@link tableRows}). */
const addTableItem: (item: TableItem) => (body: TableBodyBuilder) => void =
  Match.type<TableItem>().pipe(
    Match.tagsExhaustive({
      Row:
        ({ start, open }) =>
        (body: TableBodyBuilder) => {
          flushRow(body, start);
          body.row = { start, open, cells: [] };
        },
      Captions:
        ({ captions }) =>
        (body: TableBodyBuilder) => {
          // A caption line ends the row it interrupts (#131); its pieces
          // all precede the next row.
          flushRow(body, captions[0].span.start);
          const row = body.rows.length;
          body.captions.push(...captions.map((caption) => ({ ...caption, row })));
        },
      Cells:
        ({ cells }) =>
        (body: TableBodyBuilder) => {
          body.row ??= { start: cells[0].span.start, open: undefined, cells: [] };
          body.row.cells.push(...cells);
        },
    }),
  );

/**
 * Groups a table's items into captions and rows. Cells before any `|-`, or
 * after a caption, open an implicit row (`open` undefined); each row runs to
 * the next `|-`, the next caption or the closing `|}` at `closeStart`. A
 * caption ends the row it interrupts, as an HTML parser closes the row at
 * the `<caption>` MediaWiki emits there and opens a new one for the next
 * cell (#131); each caption records the index of the row it precedes.
 */
function tableRows(items: readonly TableItem[], closeStart: number): TableBody {
  const body: TableBodyBuilder = { captions: [], rows: [], row: undefined };
  Arr.forEach(items, (item) => addTableItem(item)(body));
  flushRow(body, closeStart);
  return { captions: body.captions, rows: body.rows };
}

/** `{|` at the start of a line, at block level, opens a table — see {@link Table}. */
const table: WikiParser<Table> = memoFailure(
  Open.Table,
  Parser.map(
    Parser.withSpan(
      Parser.seq(
        lineStart,
        literal("{|"),
        // A table closes only on a line starting `|}`.
        canClose("\n|}"),
        markerLine,
        Parser.repeat(tableItem),
        literal("|}"),
      ),
    ),
    ([[, , , open, items], span]): Table => ({
      _tag: "Table",
      span,
      open,
      ...tableRows(items, span.end - 2),
    }),
  ),
);

// ── brackets: wikilinks and external links ────────────────────────────

const wikilink: WikiParser<Wikilink> = memoFailure(
  Open.Wikilink,
  Parser.map(
    Parser.withSpan(
      Parser.seq(
        literal("[["),
        canClose("]]"),
        linkPart,
        segmentsThenClose(Open.WikilinkTail, linkPart, "]]"),
      ),
    ),
    ([[, , target, segments], span]): Wikilink => ({ _tag: "Wikilink", span, target, segments }),
  ),
);

/**
 * Recognised URL protocols for bracketed external links. Mirrors the common
 * subset of MediaWiki's `$wgUrlProtocols`. A `[` not followed by one of
 * these (then `:`), or by `//`, stays literal text.
 */
const PROTOCOLS = HashSet.make(
  "bitcoin",
  "ftp",
  "ftps",
  "geo",
  "git",
  "gopher",
  "http",
  "https",
  "irc",
  "ircs",
  "magnet",
  "mailto",
  "news",
  "nntp",
  "redis",
  "sftp",
  "sip",
  "sips",
  "sms",
  "ssh",
  "svn",
  "tel",
  "telnet",
  "urn",
  "worldwind",
  "xmpp",
);

const protocol = Parser.alt(
  Parser.terminated(
    Parser.filter(Ascii.alpha1, (name) => HashSet.has(PROTOCOLS, name.toLowerCase())),
    literal(":"),
  ),
  literal("//"),
);

const externalLink: WikiParser<ExternalLink> = memoFailure(
  Open.ExternalLink,
  Parser.map(
    Parser.withSpan(
      Parser.seq(
        literal("["),
        Parser.peek(protocol),
        // The URL ends at whitespace, a closing `]`, or an angle bracket.
        Token.takeTill(" \t\n\r]<>", { min: 1 }),
        Parser.optional(Parser.preceded(Parser.not(literal("]")), externalLabel)),
        literal("]"),
      ),
    ),
    ([[, , url, label], span]): ExternalLink => ({ _tag: "ExternalLink", span, url, label }),
  ),
);

// `[[` is only ever a wikilink; a single `[` may open an external link.
const bracketed: WikiParser<Wikilink | ExternalLink> = Parser.alt(
  wikilink,
  Parser.preceded(Parser.not(literal("[[")), externalLink),
);

// ── bare url autolinking ───────────────────────────────────────────────

/**
 * Common Unicode `\p{Zs}` space separators beyond ASCII space — folded into
 * the autolink URL-body stop set alongside MediaWiki's `EXT_LINK_URL_CLASS`
 * ASCII/control exclusions. Not the full Unicode `Zs` category (a handful of
 * rarely-used code points are omitted); a deliberate, narrow scope cut.
 */
const AUTOLINK_EXTRA_SPACES = String.fromCharCode(
  0x00a0,
  0x1680,
  0x2000,
  0x2001,
  0x2002,
  0x2003,
  0x2004,
  0x2005,
  0x2006,
  0x2007,
  0x2008,
  0x2009,
  0x200a,
  0x202f,
  0x205f,
  0x3000,
);

/**
 * Protocols recognised for bare (unbracketed) URL autolinking — see
 * {@link AutoLink}. Deliberately narrower than {@link PROTOCOLS}: only
 * `http`/`https`, matching the scope of website#1287's deferred autolinking
 * work. The body runs to one of MediaWiki's `EXT_LINK_URL_CLASS` stops.
 */
const autoLinkCandidate = Parser.seq(
  Parser.alt(Ascii.caseless("https://"), Ascii.caseless("http://")),
  Token.takeTill([Token.range("\u0000", " "), `\u007f[]<>"${AUTOLINK_EXTRA_SPACES}`], {
    min: 1,
  }),
);

/**
 * A trailing run of these characters is trimmed off an autolinked URL back
 * into the surrounding text — MediaWiki's `makeFreeExternalLink`. `)` joins
 * the set only when the URL contains no `(` at all (see {@link AutoLink}).
 */
const AUTOLINK_TRAIL = ",;.:!?)";
const AUTOLINK_TRAIL_IF_PAREN = ",;.:!?";

/**
 * Matches a truncated HTML-entity reference at the end of a string
 * (`&amp`, `&#39`, `&#x27`) — used to avoid splitting a trailing entity when
 * trimming autolink punctuation lands on its `;`.
 */
const ENTITY_TAIL_RE = /&(?:[a-z]+|#x[\da-f]+|#\d+)$/i;

/** The length of `body` left once trailing punctuation is trimmed off. */
function trimmedAutoLinkBody(body: string): number {
  const trail = body.includes("(") ? AUTOLINK_TRAIL_IF_PAREN : AUTOLINK_TRAIL;
  // Scans UTF-16 units (`split("")`), the units `end` counts in.
  let end = Option.match(
    Arr.findLastIndex(body.split(""), (unit) => !trail.includes(unit)),
    { onNone: () => 0, onSome: (last) => last + 1 },
  );
  // Don't split a trailing HTML-entity-looking reference by moving its `;`
  // into the trimmed trail.
  if (end < body.length && body.charCodeAt(end) === SEMICOLON) {
    if (ENTITY_TAIL_RE.test(body.slice(0, end))) end++;
  }
  return end;
}

const autoLink: WikiParser<AutoLink> = Parser.make((state) => {
  const start = state.pos;
  const candidate = autoLinkCandidate.step(state);
  if (candidate === Input.Fail) return Input.Fail;
  const [scheme, body] = candidate;
  const length = trimmedAutoLinkBody(body);
  // A lone protocol with nothing real left after trimming isn't a link.
  if (length === 0) return state.backtrack("Verify", [], start);
  state.pos = start + scheme.length + length;
  return { _tag: "AutoLink", span: { start, end: state.pos }, url: state.slice(start, state.pos) };
});

// ── angle brackets: comments and tags ─────────────────────────────────

/**
 * A comment's body and its `-->`, when the first `-->` after the cursor ends
 * within the region; fails otherwise. The search is {@link nextClose}'s, so
 * a run of unclosed `<!--` in table cells scans the rest of the source once
 * (#152).
 */
const commentBody: WikiParser<string> = Parser.make((state) => {
  const close = nextLiteral(state, "-->", state.pos);
  if (!endsInRegion(state, close)) return state.backtrack("TakeUntil");
  const body = state.slice(state.pos, close.index);
  state.pos = close.index + close.length;
  return body;
});

const comment: WikiParser<Comment> = Parser.map(
  Parser.withSpan(
    Parser.preceded(
      literal("<!--"),
      Parser.alt(
        Parser.map(commentBody, (body) => ({ body, closed: true })),
        // Unclosed within the current region: absorb the rest (MediaWiki).
        Parser.map(Token.rest, (body) => ({ body, closed: false })),
      ),
    ),
  ),
  ([{ body, closed }, span]): Comment => ({ _tag: "Comment", span, text: body, closed }),
);

const ALNUM = [Token.range("a", "z"), Token.range("A", "Z"), Token.range("0", "9")];

/** Tag-name characters: letters and digits. */
const tagName = Token.takeWhile(ALNUM, { min: 1 });

const quoted = (quote: string) =>
  Parser.delimited(literal(quote), Token.takeTill(quote), literal(quote));

/**
 * `<name …>` or `</name …>`, with its raw text. The attributes run to the
 * first `>` outside a quoted value; a `<` before it, or no `>` at all,
 * means this is no tag.
 */
const tagOpen = Parser.withTaken(
  Parser.seq(
    literal("<"),
    Parser.optional(literal("/")),
    tagName,
    Parser.repeat(Parser.alt(Token.takeTill(`"'<>`, { min: 1 }), quoted('"'), quoted("'"))),
    literal(">"),
  ),
);

const closeTags = MutableHashMap.empty<
  string,
  WikiParser<readonly [rawContent: string, closeRaw: string]>
>();

/**
 * An extension tag's raw body and its close tag (`</name>`, any case,
 * optional whitespace before the `>`), memoised per tag name. Fails when no
 * close tag ends within the region. The search is {@link nextClose}'s, so a
 * run of unclosed `<ref>` scans the rest of the source once (#152).
 */
function extensionBody(name: string): WikiParser<readonly [string, string]> {
  return Option.getOrElse(MutableHashMap.get(closeTags, name), () => {
    const parser = closeTagParser(name);
    MutableHashMap.set(closeTags, name, parser);
    return parser;
  });
}

function closeTagParser(name: string): WikiParser<readonly [string, string]> {
  const re = new RegExp(`</${name}\\s*>`, "ig");
  const search = (input: string, from: number): CloseMatch | undefined => {
    re.lastIndex = from;
    const m = re.exec(input);
    return m === null ? undefined : { index: m.index, length: m[0].length };
  };
  return Parser.make((state) => {
    const close = nextClose(state, `</${name}`, state.pos, (from) => search(state.input, from));
    if (!endsInRegion(state, close)) return state.backtrack("TakeUntil");
    const rawContent = state.slice(state.pos, close.index);
    state.pos = close.index + close.length;
    return [rawContent, state.slice(close.index, state.pos)] as const;
  });
}

const tag: WikiParser<Tag> = Parser.make((state) => {
  const start = state.pos;
  const open = tagOpen.step(state);
  if (open === Input.Fail) return Input.Fail;
  const [[, slash, rawName], raw] = open;
  const name = rawName.toLowerCase();
  const closing = slash !== undefined;
  const selfClosing = raw.charCodeAt(raw.length - 2) === SLASH;
  const marker = (): Tag => ({
    _tag: "Tag",
    span: { start, end: state.pos },
    name,
    closing,
    selfClosing,
    raw,
    rawContent: undefined,
    closeRaw: undefined,
  });
  if (closing || selfClosing || !EXTENSION_TAGS.has(name)) return marker();
  // Extension tag: capture the body raw up to a matching close tag.
  const afterOpen = state.pos;
  const body = extensionBody(name).step(state);
  if (body === Input.Fail) {
    // Open-only: leave the following content to ordinary parsing.
    state.pos = afterOpen;
    return marker();
  }
  const [rawContent, closeRaw] = body;
  return { ...marker(), rawContent, closeRaw };
});

/** The lower-cased tag name (see `tagName`) starting at `i`; `""` when there is none. */
function tagNameAt(src: string, i: number): string {
  TAG_NAME_AT.lastIndex = i;
  return (TAG_NAME_AT.exec(src)?.[0] ?? "").toLowerCase();
}

/** A run of tag-name characters (see `tagName`), matched in place. */
const TAG_NAME_AT = /[A-Za-z0-9]*/y;

/**
 * End of the extension tag opening at `at`, its body and close tag included
 * when it has them (see `tag`), or `-1` when no extension tag opens there.
 * A closing tag never counts: `tagNameAt` finds no name after its `</`.
 * Runs over the whole source, whatever the region end is now.
 */
function extensionTagEnd(state: State, at: number): number {
  if (!EXTENSION_TAGS.has(tagNameAt(state.input, at + 1))) return -1;
  const savedPos = state.pos;
  const savedEnd = state.end;
  state.pos = at;
  state.end = state.input.length;
  const end = tag.step(state) === Input.Fail ? -1 : state.pos;
  state.pos = savedPos;
  state.end = savedEnd;
  return end;
}

const angled: WikiParser<Comment | Tag> = Parser.alt(comment, tag);

// ── entities ──────────────────────────────────────────────────────────

/**
 * Named-entity characters, as MediaWiki's `Sanitizer::CHAR_REFS_REGEX` reads
 * them (`[A-Za-z0-9\x80-\xff]` over UTF-8 bytes): an ASCII letter or digit,
 * or any non-ASCII character. Every HTML5 name is ASCII, but MediaWiki's
 * aliases for `&rlm;` are spelt in Hebrew and in Arabic letters.
 */
const ENTITY_NAME = [...ALNUM, Token.range("\u0080", "\u{10ffff}")];

/** `&name;`, `&#123;` or `&#x7b;`. */
const entity: WikiParser<HtmlEntity> = Parser.map(
  Parser.withSpan(
    Parser.taken(
      Parser.seq(
        literal("&"),
        Parser.alt(
          Parser.preceded(
            literal("#"),
            Parser.alt(Parser.preceded(Token.oneOf("xX"), Ascii.hexDigit1), Ascii.digit1),
          ),
          Token.takeWhile(ENTITY_NAME, { min: 1 }),
        ),
        literal(";"),
      ),
    ),
  ),
  ([raw, span]): HtmlEntity => ({ _tag: "HtmlEntity", span, raw }),
);

// ── apostrophe formatting (roles resolved later, see quotes.ts) ────────

const formatting: WikiParser<Formatting> = Parser.map(
  Parser.withSpan(Token.takeWhile("'", { min: 2 })),
  ([marks, span]): Formatting => ({
    _tag: "Formatting",
    span,
    marks,
    mode: "italic",
    leadingLiterals: 0,
  }),
);

// ── headings (block level, whole line) ────────────────────────────────

const HEADING_LINE = /^(={1,6})([\s\S]*?)(={1,6})([ \t]*)$/;

const restOfLine = Token.takeTill("\n");

const heading: WikiParser<Heading> = Parser.preceded(
  lineStart,
  Parser.make((state) => {
    const start = state.pos;
    const line = restOfLine.step(state);
    const m = line === Input.Fail ? null : HEADING_LINE.exec(line);
    if (m === null) return state.backtrack("Verify", [], start);
    const [, left, inner, right, trailing] = m;
    const innerStart = start + left.length;
    // The title is parsed over its bounded region, so nested constructs
    // cannot reach past the closing equals run.
    const title = fragmentWithin(state, innerStart, innerStart + inner.length, headingTitle);
    state.pos = start + m[0].length;
    return {
      _tag: "Heading",
      span: { start, end: state.pos },
      level: Math.min(left.length, right.length),
      leftEquals: left,
      rightEquals: right,
      title,
      trailing,
    };
  }),
);

// ── construct dispatch ────────────────────────────────────────────────

/** The constructs a fragment may open, by their first character. */
interface Constructs {
  readonly construct: WikiParser<Node>;
  /** The characters `construct` has a case for (see {@link asciiTable}). */
  readonly opens: Uint8Array;
}

const nextChar = Parser.peek(Token.any);

const constructs = (cases: Readonly<Record<string, WikiParser<Node>>>): Constructs => ({
  construct: Parser.dispatch(nextChar, cases),
  opens: asciiTable(Record.keys(cases)),
});

/** The constructs that may open inside any fragment. */
const inlineCases = {
  "[": bracketed,
  "<": angled,
  "&": entity,
  "'": formatting,
  h: autoLink,
  H: autoLink,
};

const inlineConstructs = constructs({ ...inlineCases, "{": Parser.alt(argument, template) });

/** Block level adds the line-level constructs: tables and headings. */
const blockConstructs = constructs({
  ...inlineCases,
  "{": Parser.alt(table, argument, template),
  "=": heading,
});

const document = fragment(undefined, true);

/** Parses wikitext into a {@link Document}. Total and fail-soft. */
export function parse(source: string): Document {
  // The grammar runs on a cursor of its own rather than through
  // `Parser.parse`, which would first look for a compiled form of it: there
  // is none, since its `Parser.make` steps run interpreted.
  const state = new Input.State(source, {
    context: Context.make(Session, {
      failed: MutableHashSet.empty<number>(),
      failedKinds: new Uint8Array(source.length + 1),
      depth: 0,
      nestedEnds: undefined,
      closes: MutableHashMap.empty<string, CloseSearch>(),
      doomed: [],
      tableEnds: MutableHashMap.empty<number, number>(),
    }),
  });
  const children = document.step(state);
  return {
    _tag: "Document",
    span: { start: 0, end: source.length },
    // The top-level fragment reads to the end of input and never fails.
    children: children === Input.Fail ? [text(source, 0, source.length)] : children,
    source,
  };
}
