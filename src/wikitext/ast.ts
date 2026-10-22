/**
 * The typed AST vocabulary for the `Wikitext` parser
 * (website#1065). Wikitext in, this tree out — no network, no template
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
 * dump. See `./parse.ts`.
 *
 * @copyright Thomas Foster
 * @module wikitext/ast
 */

/** A half-open source range in UTF-16 code-unit offsets: `[start, end)`. */
export interface Span {
  /**
   * Offset of the first code unit, inclusive, counted from the start of
   * {@link Document.source} (not from the parent node).
   */
  readonly start: number;
  /**
   * Offset just past the last code unit (exclusive), so `end - start` is the
   * length in UTF-16 code units.
   */
  readonly end: number;
}

/** A parsed wikitext document: the source plus its top-level node tiling. */
export interface Document {
  /** Tells a document apart from a node array (a {@link Fragment} is either). */
  readonly _tag: "Document";
  /** The whole source: always `{ start: 0, end: source.length }`. */
  readonly span: Span;
  /**
   * The top-level nodes, in source order, tiling the whole source; empty
   * only for empty input.
   */
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
  /** Discriminates this node in the {@link Node} union. */
  readonly _tag: "Text";
  /**
   * The node's source range; {@link serialize} ignores it, so after an edit
   * it still points at the original text.
   */
  readonly span: Span;
  /** The source slice verbatim; never empty, and it may span lines. */
  readonly text: string;
}

/**
 * An HTML comment `<!-- … -->`. `closed` is `false` when no `-->` followed,
 * in which case the comment absorbs the rest of the region being parsed (the
 * input, a heading's title before its closing `=` run, or a table cell or
 * caption) and serializes without a closing marker. MediaWiki always runs an
 * unclosed comment to the end of the input.
 */
export interface Comment {
  /** Discriminates this node in the {@link Node} union. */
  readonly _tag: "Comment";
  /**
   * The node's source range, `<!--` and any `-->` included; {@link serialize}
   * ignores it, so after an edit it still points at the original text.
   */
  readonly span: Span;
  /**
   * The text between `<!--` and `-->` verbatim; for an unclosed comment,
   * everything after `<!--` to the end of the region being parsed (the
   * input, a heading's title, or a table cell or caption).
   */
  readonly text: string;
  /**
   * Whether a `-->` ended the comment. `false` when none followed before the
   * end of the region being parsed (the input, a heading's title before its
   * closing `=` run, or a table cell or caption), which the comment then runs
   * to. MediaWiki always runs it to the end of the input.
   */
  readonly closed: boolean;
}

/**
 * An HTML entity reference: `&nbsp;`, `&#160;`, `&#x1F600;`. A named
 * reference's name is any run of ASCII letters, digits and non-ASCII
 * characters, as MediaWiki reads it, whether or not it names a known entity.
 */
export interface HtmlEntity {
  /** Discriminates this node in the {@link Node} union. */
  readonly _tag: "HtmlEntity";
  /**
   * The node's source range; {@link serialize} ignores it, so after an edit
   * it still points at the original text.
   */
  readonly span: Span;
  /**
   * The verbatim source, including the leading `&` and trailing `;`. The
   * parser never decodes it; {@link stripToText} decodes the references
   * MediaWiki renders as a character.
   */
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
 * See `./quotes.ts`.
 */
export interface Formatting {
  /** Discriminates this node in the {@link Node} union. */
  readonly _tag: "Formatting";
  /**
   * The node's source range; {@link serialize} ignores it, so after an edit
   * it still points at the original text.
   */
  readonly span: Span;
  /**
   * The whole apostrophe run verbatim (two or more `'`), literal ones
   * included; it is all the node serializes to.
   */
  readonly marks: string;
  /**
   * What the run toggles once its literal apostrophes are set aside: `''`
   * italic, `'''` bold, `'''''` both. Resolved per source line within the
   * fragment, as MediaWiki's `doQuotes` does: when a line has an odd
   * number of bold runs and an odd number of italic runs (`'''''` counting
   * as one of each), one `'''` is read as `'` + `''`, preferring one after a
   * single-letter word, then one after a longer word or at the line start,
   * then one after a space.
   */
  readonly mode: "italic" | "bold" | "bold-italic";
  /**
   * How many leading apostrophes of {@link marks} are literal text rather
   * than markup; `marks.length - leadingLiterals` is 2, 3 or 5, matching
   * {@link mode}.
   */
  readonly leadingLiterals: number;
}

/**
 * A section heading occupying a whole line: `== Title ==`. `leftEquals` /
 * `rightEquals` are the raw `=` runs (they may differ in length — MediaWiki
 * takes `level = min(left, right)` and leaves the surplus as literal `=`),
 * `title` is the inline fragment between them, and `trailing` is any
 * spaces or tabs after the closing run up to (but not including) the newline.
 */
export interface Heading {
  /** Discriminates this node in the {@link Node} union. */
  readonly _tag: "Heading";
  /**
   * The heading line's source range, newline excluded; {@link serialize}
   * ignores it, so after an edit it still points at the original text.
   */
  readonly span: Span;
  /** The section level, 1 to 6: the length of the shorter `=` run. */
  readonly level: number;
  /**
   * The opening `=` run verbatim, 1 to 6 `=`. Any beyond {@link level} are
   * title text to MediaWiki but stay here, not in {@link title}.
   */
  readonly leftEquals: string;
  /**
   * The closing `=` run verbatim, 1 to 6 `=`. Any beyond {@link level} are
   * title text to MediaWiki but stay here, not in {@link title}.
   */
  readonly rightEquals: string;
  /**
   * The inline fragment between the `=` runs, surrounding spaces included;
   * empty for a line such as `====`. Headings and tables are not recognised
   * inside it.
   */
  readonly title: readonly Node[];
  /** The spaces and tabs after the closing run; `""` when there are none. */
  readonly trailing: string;
}

/**
 * A template invocation `{{name|param|key=value}}`. Magic words and parser
 * functions (`{{PAGENAME}}`, `{{#if:…}}`) parse as templates too — they are
 * represented structurally, never evaluated (an explicit non-goal). `name`
 * is the inline fragment up to the first top-level `|`; `params` follow.
 */
export interface Template {
  /** Discriminates this node in the {@link Node} union. */
  readonly _tag: "Template";
  /**
   * The node's source range, `{{` through `}}`. {@link serialize}
   * ignores it, so after an edit it still points at the original text.
   */
  readonly span: Span;
  /**
   * The fragment between `{{` and the first top-level `|` or `}}`, verbatim:
   * whitespace and comments included, and for a parser function the text
   * after its colon too (`#if:x`). {@link templateName} reads it as text.
   */
  readonly name: readonly Node[];
  /**
   * The parameters, one per top-level `|`, in source order; empty when
   * there is no `|`.
   */
  readonly params: readonly Param[];
}

/**
 * A template argument `{{{name|default}}}` (triple-brace). `default` is the
 * fragment after the first top-level `|`, absent when there is none.
 */
export interface Argument {
  /** Discriminates this node in the {@link Node} union. */
  readonly _tag: "Argument";
  /**
   * The node's source range, `{{{` through `}}}`. {@link serialize}
   * ignores it, so after an edit it still points at the original text.
   */
  readonly span: Span;
  /** The fragment between `{{{` and the first top-level `|` or `}}}`, verbatim. */
  readonly name: readonly Node[];
  /**
   * The fragment after the first top-level `|`, up to `}}}`; `undefined`
   * when there is no `|`, and empty for `{{{x|}}}`. A later `|` stays in it
   * as text, where MediaWiki would drop everything after it.
   */
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
  /**
   * The fragment before the first top-level `=`, whitespace included;
   * `undefined` for a positional parameter. {@link paramName} reads it as
   * trimmed text.
   */
  readonly name: readonly Node[] | undefined;
  /**
   * The fragment after the first top-level `=` (the whole parameter when
   * positional), up to
   * the next top-level `|` or `}}`; any later `=` is part of it. Whitespace is
   * kept: MediaWiki trims it from named values only, while
   * {@link paramValue} trims every value.
   */
  readonly value: readonly Node[];
}

/**
 * A wikilink `[[Target|label]]`. `segments` holds every `|`-separated piece
 * after the target verbatim (File/Category links carry several); for an
 * ordinary link they make up the display label.
 */
export interface Wikilink {
  /** Discriminates this node in the {@link Node} union. */
  readonly _tag: "Wikilink";
  /**
   * The node's source range, `[[` through `]]`. {@link serialize}
   * ignores it, so after an edit it still points at the original text.
   */
  readonly span: Span;
  /**
   * The fragment between `[[` and the first top-level `|` or `]]`, verbatim
   * and not normalised: a leading `:`, the namespace prefix, any `#section`
   * and surrounding whitespace are all kept.
   */
  readonly target: readonly Node[];
  /**
   * The fragments after each top-level `|`, in order; empty when there is
   * no `|`, and one empty fragment for the pipe trick `[[A|]]` (MediaWiki
   * expands the pipe trick on save). For an ordinary link MediaWiki shows them
   * rejoined with `|` as the label; for a
   * `File:` link they are image options, usually ending with the caption.
   */
  readonly segments: readonly (readonly Node[])[];
}

/**
 * A bracketed external link `[https://example.org label]` (or bare
 * `[https://example.org]`). `label` includes the separating whitespace as
 * leading text so that serialization is exact; {@link stripToText} on the
 * query surface trims it. Bare (unbracketed) URLs are intentionally not
 * recognised — they stay in {@link Text}.
 */
export interface ExternalLink {
  /** Discriminates this node in the {@link Node} union. */
  readonly _tag: "ExternalLink";
  /**
   * The node's source range, `[` through `]`. {@link serialize}
   * ignores it, so after an edit it still points at the original text.
   */
  readonly span: Span;
  /**
   * The URL verbatim, protocol (or a protocol-relative `//`) included:
   * everything after `[` up to the first space, tab, line break, `]`, `<`
   * or `>`.
   */
  readonly url: string;
  /**
   * Everything after the URL up to the closing `]`, separating whitespace
   * included; `undefined` when `]` follows the URL directly.
   */
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
 * this package's protocol scope; see the parser's `PROTOCOL_RE` for the fuller list
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
  /** Discriminates this node in the {@link Node} union. */
  readonly _tag: "AutoLink";
  /**
   * The node's source range; {@link serialize} ignores it, so after an edit
   * it still points at the original text.
   */
  readonly span: Span;
  /**
   * The linked URL verbatim, `http://` or `https://` included in whatever
   * letter case the source used, after the trailing-punctuation trim.
   */
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
 *   open-only (`rawContent` and `closeRaw` are `undefined`).
 * - **Presentational tags** (`div`, `span`, `br`, `b`, … — anything else)
 *   are flat markers: a `<div>` and its `</div>` are two separate nodes and
 *   the content between them is parsed as ordinary wikitext. These always
 *   have `rawContent: undefined`.
 *
 * `raw` is the verbatim opening (or closing) tag text; it is the whole
 * serialization for a marker node.
 */
export interface Tag {
  /** Discriminates this node in the {@link Node} union. */
  readonly _tag: "Tag";
  /**
   * The node's source range: the tag alone for a marker, or open tag through
   * close tag for an extension tag with a body. {@link serialize} ignores it,
   * so after an edit it still points at the original text.
   */
  readonly span: Span;
  /**
   * The tag name in lower case (ASCII letters and digits), whatever case the
   * source used; {@link raw} keeps the original spelling.
   */
  readonly name: string;
  /** Whether the source wrote this as a closing tag `</name>`. */
  readonly closing: boolean;
  /**
   * Whether the tag text ends in `/>`, as in `<br/>` or `<ref name="a" />`.
   * A self-closing extension tag has no body, so it is a marker.
   */
  readonly selfClosing: boolean;
  /** Verbatim opening/closing tag text, e.g. `<ref name="a">`, `</div>`. */
  readonly raw: string;
  /**
   * An extension tag's body verbatim, unparsed (`""` when empty), ending at
   * the first matching close tag since extension tags don't nest.
   * `undefined` for every marker, including a self-closing or unclosed
   * extension tag.
   */
  readonly rawContent: string | undefined;
  /** Verbatim closing tag for an extension tag (`</ref>`), else `undefined`. */
  readonly closeRaw: string | undefined;
}

/**
 * A wikitable `{| … |}` (website#1287's largest vocabulary addition). Modelled
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
 * A line break inside a template, argument, wikilink, closed comment or
 * extension tag doesn't start a new table line, and a `|`, `||` or `!!` inside one
 * doesn't split a cell, so a multi-line `{{Infobox …}}` or a
 * `<ref>{{cite web|…}}</ref>` stays whole in its cell. MediaWiki gets this
 * by building tables after expanding templates and setting comments and
 * extension tags aside; it does not protect wikilinks, which this parser
 * does. A bracket that never closes is ordinary text, as in MediaWiki, so a
 * stray `{{` hides nothing; so is an unclosed `<!--` (MediaWiki would hide
 * the rest of the page). A construct that spans a `|}` line carries the table
 * past it, and when no later `|}` follows there is no table: MediaWiki does
 * the same for a template or an extension tag, but not for a wikilink.
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
  /** Discriminates this node in the {@link Node} union. */
  readonly _tag: "Table";
  /**
   * The node's source range, `{|` through `|}`. {@link serialize}
   * ignores it, so after an edit it still points at the original text.
   */
  readonly span: Span;
  /**
   * The verbatim text after `{|` up to the first caption, row or cell marker
   * line: the attributes, their line break and any filler lines.
   */
  readonly open: string;
  /**
   * Every `|+` caption, in source order; empty when there is none.
   * {@link serialize} writes them all before the rows, so a caption written
   * after a row or cell marker does not round-trip.
   */
  readonly captions: readonly TableCaption[];
  /**
   * The rows in source order, the first possibly implicit (no `|-`); empty
   * when the table has neither a `|-` nor a cell.
   */
  readonly rows: readonly TableRow[];
}

/**
 * A table caption `|+ … `. Zero or more may occur (MediaWiki only really
 * gives meaning to one; this vocabulary does not privilege a particular
 * occurrence and keeps every `|+` line encountered, so round-trip never
 * depends on picking "the real one"; see {@link Table.captions}).
 *
 * `attrs` / `content` follow the single-pipe rule shared with
 * {@link TableCell}: the first `|` on the caption's opening line, outside any
 * template, argument, wikilink, comment or extension tag, splits attributes
 * from content, *unless* a `[[` outside those comes before it — see
 * {@link TableCell.attrs}. `content` extends across any following lines that
 * aren't themselves a table marker, so a caption's text can span paragraphs.
 */
export interface TableCaption {
  /**
   * The caption's source range, from `|+` to the start of the next marker
   * line; {@link serialize} ignores it.
   */
  readonly span: Span;
  /**
   * The text between `|+` and the first `|` on its line outside a template,
   * argument, wikilink, comment or extension tag, verbatim and untrimmed;
   * `undefined` when there is no such `|` or a `[[` outside those comes
   * before it. In `|+ {{flag|France}} results` there is none, so the
   * template is content.
   */
  readonly attrs: string | undefined;
  /**
   * The caption as wikitext, after the `|+` or the attribute `|`, up to the
   * next table marker line; line breaks included.
   */
  readonly content: readonly Node[];
}

/**
 * One table row. Rows are separated by `|-`; the table's very first row
 * needs no explicit marker (`open` is `undefined` for that implicit row —
 * distinct from an explicit `|-` with no attribute text, which is its line
 * break, `"\n"`).
 *
 * `open`, when present, is the verbatim text from just after `|-` through
 * the start of the row's first cell (or the next marker) — attribute text
 * plus its line terminator, and any filler lines, mirroring
 * {@link Table.open}.
 */
export interface TableRow {
  /**
   * The row's source range, from its `|-` (or, for the implicit first row,
   * its first cell marker) to the next `|-` or the closing `|}`;
   * {@link serialize} ignores it.
   */
  readonly span: Span;
  /**
   * The verbatim text after `|-`: attributes, line break and any filler
   * lines. `undefined` for the implicit first row.
   */
  readonly open: string | undefined;
  /**
   * The row's cells in source order, header and data cells mixed; empty for
   * a `|-` with no cell after it.
   */
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
 * `attrs` / `content`: MediaWiki's single-pipe rule (`Parser::handleTables`)
 * splits the cell's opening-line text at the first `|` into attributes and
 * content. A `|` inside a template, argument, wikilink, comment or extension
 * tag doesn't count (see {@link Table}), so `| {{flag|France}}` is all
 * content. Nor is there a split when a `[[` outside those comes before the
 * `|`: the whole thing is content and `attrs` is `undefined` (MediaWiki's
 * guard against reading the text around a wikilink as attributes, which it
 * also applies to `-{`; this parser does not).
 * `content` extends across any following lines that aren't themselves a
 * table marker (multi-line cell content).
 */
export interface TableCell {
  /**
   * The cell's source range, from its marker (`!`, `|`, `!!` or `||`) to the
   * end of its content; {@link serialize} ignores it.
   */
  readonly span: Span;
  /** Whether this is a header cell (`!` or `!!`) rather than a data cell (`|` or `||`). */
  readonly header: boolean;
  /**
   * Whether the cell opened with `!!` or `||` on the line of the cell before
   * it, rather than with `!` or `|` at the start of a line.
   */
  readonly inline: boolean;
  /**
   * The text between the marker and the first `|` in the cell's part of its
   * opening line outside a template, argument, wikilink, comment or
   * extension tag, verbatim and untrimmed; `undefined` when there is no such
   * `|` or a `[[` outside those comes before it. For
   * `| style="x" | {{flag|France}}` it is `' style="x" '`; for
   * `| {{flag|France}}` it is `undefined`.
   */
  readonly attrs: string | undefined;
  /**
   * The cell as wikitext, after the marker or the attribute `|`. It ends at
   * the next `!!`/`||` on the line outside a template, argument, wikilink,
   * comment or extension tag; the line's last cell runs on through any
   * following non-marker lines, line breaks included.
   */
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
