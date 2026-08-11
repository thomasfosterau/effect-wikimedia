/**
 * @copyright Thomas Foster
 *
 * The typed AST vocabulary for the {@link module:lib/wikitext} parser
 * (issue #1065). Wikitext in, this tree out — no network, no template
 * expansion, no HTML rendering.
 *
 * Two invariants hold for every freshly-parsed tree and are the bedrock of
 * the round-trip / splice-edit guarantees:
 *
 * 1. **Contiguous tiling.** The children of any fragment (a document, a
 *    template parameter value, a wikilink label, …) tile their parent's
 *    inner source range exactly — no gaps, no overlaps — so every byte of
 *    the input lands in exactly one node.
 * 2. **Span fidelity.** Every node carries a {@link Span} of UTF-16 source
 *    offsets (the same units `String.prototype.slice` uses), and
 *    `serialize(node)` of an *unmodified* node reproduces
 *    `source.slice(node.span.start, node.span.end)` byte-for-byte. Callers
 *    splice edits back into the original text using those offsets.
 *
 * The parser is **fail-soft**: malformed markup degrades to {@link Text}
 * (or an open-only tag / unclosed comment) rather than raising — wikitext
 * in the wild is never clean, and a parser that throws is useless on a
 * dump. See {@link module:lib/wikitext/parse}.
 *
 * @module lib/wikitext/ast
 */

/** A half-open source range in UTF-16 code-unit offsets: `[start, end)`. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** A parsed wikitext document: the source plus its top-level node tiling. */
export interface Document {
  readonly _tag: "Document";
  readonly span: Span;
  readonly children: readonly Node[];
  /** The exact source the tree was parsed from (for splice-edit callers). */
  readonly source: string;
}

/** Any AST node. A *fragment* is an ordered `readonly Node[]`. */
export type Node =
  | Text
  | Comment
  | HtmlEntity
  | Formatting
  | Heading
  | Template
  | Argument
  | Wikilink
  | ExternalLink
  | AutoLink
  | Tag
  | Table;

/** A plain text run. Captures its source slice verbatim. */
export interface Text {
  readonly _tag: "Text";
  readonly span: Span;
  readonly text: string;
}

/**
 * An HTML comment `<!-- … -->`. `closed` is `false` when the input ran out
 * before a `-->`, in which case the comment absorbs the rest of the input
 * (MediaWiki behaviour) and serializes without a closing marker.
 */
export interface Comment {
  readonly _tag: "Comment";
  readonly span: Span;
  /** The text between `<!--` and `-->` (or end of input). */
  readonly text: string;
  readonly closed: boolean;
}

/** An HTML entity reference: `&nbsp;`, `&#160;`, `&#x1F600;`. */
export interface HtmlEntity {
  readonly _tag: "HtmlEntity";
  readonly span: Span;
  /** The verbatim source, including the leading `&` and trailing `;`. */
  readonly raw: string;
}

/**
 * A run of two or more apostrophes — bold/italic markup. The literal
 * apostrophes are preserved verbatim in {@link marks} (so round-trip is
 * exact regardless of interpretation); {@link mode} is the semantic role
 * resolved per line by MediaWiki's apostrophe-jungle algorithm, and
 * {@link leadingLiterals} counts apostrophes MediaWiki treats as literal
 * text prefixing the markup (a run of four is `'` + `'''`).
 *
 * See {@link module:lib/wikitext/quotes}.
 */
export interface Formatting {
  readonly _tag: "Formatting";
  readonly span: Span;
  readonly marks: string;
  readonly mode: "italic" | "bold" | "bold-italic";
  readonly leadingLiterals: number;
}

/**
 * A section heading occupying a whole line: `== Title ==`. `leftEquals` /
 * `rightEquals` are the raw `=` runs (they may differ in length — MediaWiki
 * takes `level = min(left, right)` and leaves the surplus as literal `=`),
 * `title` is the inline fragment between them, and `trailing` is any
 * whitespace after the closing run up to (but not including) the newline.
 */
export interface Heading {
  readonly _tag: "Heading";
  readonly span: Span;
  readonly level: number;
  readonly leftEquals: string;
  readonly rightEquals: string;
  readonly title: readonly Node[];
  readonly trailing: string;
}

/**
 * A template invocation `{{name|param|key=value}}`. Magic words and parser
 * functions (`{{PAGENAME}}`, `{{#if:…}}`) parse as templates too — they are
 * represented structurally, never evaluated (an explicit non-goal). `name`
 * is the inline fragment up to the first top-level `|`; `params` follow.
 */
export interface Template {
  readonly _tag: "Template";
  readonly span: Span;
  readonly name: readonly Node[];
  readonly params: readonly Param[];
}

/**
 * A template argument `{{{name|default}}}` (triple-brace). `default` is the
 * fragment after the first top-level `|`, absent when there is none.
 */
export interface Argument {
  readonly _tag: "Argument";
  readonly span: Span;
  readonly name: readonly Node[];
  readonly default: readonly Node[] | undefined;
}

/**
 * One `|`-separated template parameter. A parameter is *named* when a
 * top-level `=` splits it (`name` present); otherwise it is positional
 * (`name` absent, the caller assigns the 1-based index). Whitespace lives
 * inside the `name` / `value` fragments — the `|` and `=` separators carry
 * none of their own — so serialization is `"|" + name + "=" + value`.
 */
export interface Param {
  readonly name: readonly Node[] | undefined;
  readonly value: readonly Node[];
}

/**
 * A wikilink `[[Target|label]]`. `segments` holds every `|`-separated piece
 * after the target verbatim (File/Category links carry several); the first
 * segment is the display label for an ordinary link.
 */
export interface Wikilink {
  readonly _tag: "Wikilink";
  readonly span: Span;
  readonly target: readonly Node[];
  readonly segments: readonly (readonly Node[])[];
}

/**
 * A bracketed external link `[https://example.org label]` (or bare
 * `[https://example.org]`). `label` includes the separating whitespace as
 * leading text so that serialization is exact; {@link labelText} on the
 * query surface trims it. Bare (unbracketed) URLs are intentionally not
 * recognised — they stay in {@link Text}.
 */
export interface ExternalLink {
  readonly _tag: "ExternalLink";
  readonly span: Span;
  readonly url: string;
  readonly label: readonly Node[] | undefined;
}

/**
 * A bare (unbracketed) `http://`/`https://` URL autolinked in running text —
 * MediaWiki's `doMagicLinks` "free link" recognition
 * (`Parser::makeFreeExternalLink`). `url` is the linked text verbatim
 * (protocol included); trailing punctuation trimmed off the end per the
 * semantics below is left in the surrounding text, not stored here.
 *
 * **Chosen semantics** (matching MediaWiki, narrowed to `http`/`https` —
 * this package's protocol scope; see {@link PROTOCOL_RE} for the fuller list
 * honoured by bracketed links):
 *
 * - The URL body is the maximal run of characters excluding ASCII
 *   whitespace/control, `[`, `]`, `<`, `>`, `"`, and the common Unicode space
 *   separators — MediaWiki's `EXT_LINK_URL_CLASS`.
 * - A trailing run of `,;.:!?` is trimmed back into the surrounding text.
 * - A trailing `)` is trimmed too, but *only* when the URL contains no `(`
 *   anywhere — MediaWiki checks for presence of `(`, not paren balance, so
 *   `(http://x/Foo_(bar))` keeps *both* trailing parens in the link while
 *   `(http://x)` does not.
 * - A trim that would land on a `;` backs off by one character when doing so
 *   would split an HTML-entity-looking reference (`&amp;`, `&#39;`,
 *   `&#x27;`) in two, so the entity stays whole.
 * - If trimming would remove everything after the protocol, there is no real
 *   URL — the whole thing (protocol included) is left as plain text.
 *
 * **Deliberately not implemented**: MediaWiki's separate `&lt;`/`&gt;`/`&nbsp;`
 * mid-URL truncation (working around HTML-tag-removal artifacts upstream of
 * its parser) — this parser never removes HTML tags, so those artifacts
 * cannot arise from wikitext source.
 */
export interface AutoLink {
  readonly _tag: "AutoLink";
  readonly span: Span;
  readonly url: string;
}

/**
 * An HTML-ish tag.
 *
 * Two shapes share this node:
 *
 * - **Extension tags** (`nowiki`, `ref`, `pre`, `math`, … — see
 *   {@link EXTENSION_TAGS}) own their content: the text between the open
 *   and close tags is *not* parsed as wikitext but kept raw in
 *   {@link rawContent}. When no matching close is found the tag is
 *   open-only (`closed: false`, `rawContent: undefined`).
 * - **Presentational tags** (`div`, `span`, `br`, `b`, … — anything else)
 *   are flat markers: a `<div>` and its `</div>` are two separate nodes and
 *   the content between them is parsed as ordinary wikitext. These always
 *   have `rawContent: undefined`.
 *
 * `raw` is the verbatim opening (or closing) tag text; it is the whole
 * serialization for a marker node.
 */
export interface Tag {
  readonly _tag: "Tag";
  readonly span: Span;
  readonly name: string;
  /** Whether the source wrote this as a closing tag `</name>`. */
  readonly closing: boolean;
  readonly selfClosing: boolean;
  /** Verbatim opening/closing tag text, e.g. `<ref name="a">`, `</div>`. */
  readonly raw: string;
  /** Raw inner text for an extension tag, else `undefined`. */
  readonly rawContent: string | undefined;
  /** Verbatim closing tag for an extension tag (`</ref>`), else `undefined`. */
  readonly closeRaw: string | undefined;
}

/**
 * A wikitable `{| … |}` (issue #1287's largest vocabulary addition). Modelled
 * as a block-level construct on the same footing as {@link Heading}: the
 * `{|` must open at the true start of a source line, and (like headings)
 * table recognition only applies where the fragment scanner runs with
 * `block: true` — i.e. not inside a template parameter, wikilink label, or
 * other inline fragment. A line-start marker (`{|`, `|}`, `|-`, `|+`, `!`,
 * `|`) is recognised only at column 0 of a physical line — MediaWiki
 * tolerates leading spaces before these; this parser does not, and such a
 * line is simply absorbed as ordinary content instead of being recognised as
 * a marker (a deliberate, documented simplification, not a defect).
 *
 * `open` is the verbatim text from `{|` up to the first real row/cell/caption
 * marker: normally just the attribute text plus its line terminator, but it
 * also absorbs any blank or stray filler lines before real content begins
 * (mirroring how {@link Tag.raw} keeps the whole opening tag verbatim rather
 * than splitting out "the attributes" as their own field). MediaWiki treats a
 * `|` written into this text as user error ("attribute loss"); this parser
 * does not special-case it — it is just more text in `open`.
 */
export interface Table {
  readonly _tag: "Table";
  readonly span: Span;
  readonly open: string;
  readonly captions: readonly TableCaption[];
  readonly rows: readonly TableRow[];
}

/**
 * A table caption `|+ … `. Zero or more may occur (MediaWiki only really
 * gives meaning to one; this vocabulary does not privilege a particular
 * occurrence and keeps every `|+` line encountered, so round-trip never
 * depends on picking "the real one").
 *
 * `attrs` / `content` follow the single-pipe rule shared with
 * {@link TableCell}: the first bare `|` on the caption's opening line splits
 * attributes from content, *unless* the text before it contains `[[` (a
 * wikilink's own pipe would otherwise be misread as the separator) — see
 * {@link TableCell.attrs}. `content` extends across any following lines that
 * aren't themselves a table marker, so a caption's text can span paragraphs.
 */
export interface TableCaption {
  readonly span: Span;
  readonly attrs: string | undefined;
  readonly content: readonly Node[];
}

/**
 * One table row. Rows are separated by `|-`; the table's very first row
 * needs no explicit marker (`open` is `undefined` for that implicit row —
 * distinct from an explicit `|-` with no attribute text, which is `""`).
 *
 * `open`, when present, is the verbatim text from just after `|-` through
 * the start of the row's first cell (or the next marker) — attribute text
 * plus its line terminator, and any filler lines, mirroring
 * {@link Table.open}.
 */
export interface TableRow {
  readonly span: Span;
  readonly open: string | undefined;
  readonly cells: readonly TableCell[];
}

/**
 * One table cell — a header (`!`) or data (`|`) cell.
 *
 * `inline` distinguishes a cell that continues its row's opening line via
 * `!!`/`||` from one that opens on its own line via a fresh `!`/`|` (both are
 * cells of the *same* row; only the marker differs, and round-trip needs to
 * know which was written). Mixing header and data cells via `!!`/`||` on one
 * line is not specially recognised: a header line is split only on `!!` and
 * a data line only on `||`, matching the documented common usage — a stray
 * `||` in a `!`-opened line is just literal text within that cell's content,
 * not a type change.
 *
 * `attrs` / `content`: MediaWiki's single-pipe rule (`Parser::doTableStuff`)
 * splits the cell's opening-line text at the first bare `|` into attributes
 * and content — *unless* the text before that `|` contains `[[`, in which
 * case the whole thing is content and `attrs` is `undefined`. This is the
 * documented guard against a wikilink's own pipe (`[[Foo|Bar]]`) being
 * misread as the attribute separator. `content` extends across any following
 * lines that aren't themselves a table marker (multi-line cell content).
 */
export interface TableCell {
  readonly span: Span;
  readonly header: boolean;
  readonly inline: boolean;
  readonly attrs: string | undefined;
  readonly content: readonly Node[];
}

/**
 * MediaWiki extension tags whose body is opaque to the wikitext grammar.
 * Their content is captured raw rather than parsed. This is core MediaWiki
 * plus the widely-deployed extensions; unknown tags fall through to the
 * presentational (flat-marker) path.
 */
export const EXTENSION_TAGS: ReadonlySet<string> = new Set([
  "nowiki",
  "pre",
  "ref",
  "references",
  "math",
  "chem",
  "ce",
  "syntaxhighlight",
  "source",
  "poem",
  "score",
  "hiero",
  "timeline",
  "gallery",
  "graph",
  "mapframe",
  "maplink",
  "templatestyles",
  "templatedata",
  "categorytree",
  "imagemap",
  "inputbox",
  "indicator",
  "section",
]);
