/**
 * **XML pages dump** pipeline — streaming decode of the MediaWiki XML export
 * format (`pages-articles`, `pages-meta-history`, and the daily
 * `add/changes` incrementals, which share the identical schema) into a
 * constant-memory {@link Stream} of typed page/revision records, **without
 * materialising a document**.
 *
 * ## Why a scoped scanner, not an XML library
 *
 * The decode is a minimal, internal SAX-style scanner scoped to exactly this
 * schema — not a general XML parser and not a new dependency. Three reasons:
 *
 * 1. **No effect-native streaming XML exists**, and the package's
 *    lean-dependency posture rules out pulling a heavy general parser
 *    (`sax`, `saxes`, `node-expat`) for one fixed grammar.
 * 2. **The grammar is tiny and closed** — `<mediawiki>` → `<page>` →
 *    `<revision>` with a handful of leaf fields. A general parser's
 *    namespace / DTD / CDATA machinery is dead weight here.
 * 3. **A full-history page is unbounded** (thousands of revisions, gigabytes)
 *    so the pipeline must emit *per revision* and never hold a whole page —
 *    which a DOM-building parser cannot promise.
 *
 * The scanner leans on two guarantees of the MediaWiki export format: (1)
 * **all element text is entity-escaped** (`&lt;`, `&gt;`, `&amp;`, …), so a
 * literal `<` always opens a tag and there is no CDATA; and (2) **no `>`
 * appears inside an attribute value** (the exporter emits only simple
 * `name="value"` attributes — `bytes`, `sha1`, `xml:space`, `key`, …), so the
 * first `>` after a `<` always closes that tag. Together these make a
 * chunk-boundary-safe angle-bracket scan sufficient and correct.
 *
 * Malformed input degrades **per record**: a revision missing its required
 * `<id>`, a revision left unclosed before the next `<revision>` or `</page>`,
 * a captured field breaching {@link MAX_TEXT_LENGTH}, or a truncated final
 * page all yield a typed {@link PageRevisionError} element — never a stream
 * failure.
 *
 * **Memory is bounded even against adversarial input.** A real revision's
 * `<text>` is capped by MediaWiki's `$wgMaxArticleSize` (≈2 MB), but a
 * hostile / corrupt dump could present an unbounded `<text>`. The tokenizer
 * carry is bounded (trailing text is emitted, not carried — see
 * {@link tokenizeXml}) and the assembler caps captured text at
 * {@link MAX_TEXT_LENGTH} (16,777,216 UTF-16 code units of the still-escaped
 * text), degrading the revision on breach — so the pipeline stays
 * constant-memory rather than OOMing.
 *
 * **Only the main slot is read.** Export schema 0.11 writes a revision's
 * main slot (`<model>`, `<format>`, `<text>`) directly under `<revision>`
 * and each other slot (Commons' `mediainfo`, …) in its own `<content>`
 * element; everything inside a `<content>` is skipped, its text not even
 * buffered.
 *
 * Runtime-agnostic: imports only `effect`. The byte source / decompression
 * stages (`fromFile`, `fromHttpRange`, `decompressWith`) live in the
 * Node-only `dumps/sources` module.
 *
 * @copyright Thomas Foster
 * @module dumps/xml
 */

import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";

// ── Typed record model ───────────────────────────────────────────────────

/**
 * An absent-able text field of a record: `Option<string>` in the decoded
 * record, `string | null` on the wire, so a record survives
 * `structuredClone` and JSON (a worker's `postMessage`, a persisted row).
 */
const OptionalText = Schema.OptionFromNullOr(Schema.String);

/** An absent-able integer field of a record, encoded as for `OptionalText`. */
const OptionalInt = Schema.OptionFromNullOr(Schema.Int);

/** The page a revision belongs to. */
export const PageRef = Schema.Struct({
  /**
   * The page's `<title>`, entity-decoded, trimmed and cut to 4,096 UTF-16
   * code units; `None` when absent or blank. MediaWiki's exporter writes the
   * namespace-prefixed title with spaces, such as `Category:Writers`.
   */
  title: OptionalText,
  /**
   * Namespace number (`0` = main, `14` = category, …), from `<ns>`. `None` when
   * absent, above `Number.MAX_SAFE_INTEGER`, or not a non-negative decimal
   * integer: surrounding whitespace and leading zeros are accepted (up to 18
   * digits in all), but a sign, a fraction or an exponent gives `None`, not a
   * rounded value.
   */
  ns: OptionalInt,
  /** The page id, from the page's own `<id>`; `None` under the same rules as `PageRef.ns`. */
  id: OptionalInt,
  /**
   * The redirect target when the page is a redirect: the `title` attribute
   * of the page's `<redirect title="…" />`, entity-decoded, trimmed and cut
   * to 4,096 UTF-16 code units, as MediaWiki's exporter writes it (the
   * namespace-prefixed title with spaces and without any `#section`). `None`
   * when the page has no `<redirect>`, or one whose `title` is absent or
   * blank, as in export schemas before 0.5, which wrote a bare
   * `<redirect />`. A `<redirect>` inside a `<revision>` is ignored.
   * {@link skipRedirects} drops the records of pages where it is set.
   */
  redirect: OptionalText,
});
/** {@link PageRef}'s decoded type. */
export type PageRef = typeof PageRef.Type;

/** Who made a revision. A suppressed / anonymous edit leaves fields `None`. */
export const Contributor = Schema.Struct({
  /**
   * The `<username>`, entity-decoded, trimmed and cut to 4,096 UTF-16 code
   * units; `None` when absent or blank, as for an anonymous (IP) edit or a
   * suppressed contributor.
   */
  username: OptionalText,
  /**
   * The user id, from the contributor's `<id>`; `None` when absent, under
   * the same rules as `PageRef.ns`. MediaWiki writes `0` for a username
   * with no user id behind it, and that stays `0`.
   */
  id: OptionalInt,
  /**
   * Set instead of `username` for an anonymous (IP) edit: the `<ip>`, which
   * MediaWiki writes in place of `<username>` and `<id>`. Entity-decoded,
   * trimmed and cut like `username`, and not validated as an address; `None`
   * when absent.
   */
  ip: OptionalText,
});
/** {@link Contributor}'s decoded type. */
export type Contributor = typeof Contributor.Type;

/** One revision's metadata and content (usually wikitext). */
export const Revision = Schema.Struct({
  /**
   * The revision id, from the revision's `<id>`. Always present: a revision
   * whose `<id>` is absent or fails the rules of `PageRef.ns` becomes a
   * {@link PageRevisionError} instead.
   */
  id: Schema.Int,
  /**
   * The previous revision's id, from `<parentid>`; `None` when absent or
   * invalid (rules as for `PageRef.ns`). MediaWiki omits `<parentid>`
   * when a revision has no parent, as for a page's first revision.
   */
  parentId: OptionalInt,
  /**
   * The `<timestamp>`, entity-decoded, trimmed and cut to 4,096 UTF-16 code
   * units but not parsed or validated; `None` when absent or blank. MediaWiki
   * writes ISO 8601 UTC, such as `2001-01-21T02:12:21Z`.
   */
  timestamp: OptionalText,
  /**
   * The `<contributor>`, or `None` when the revision has none. A suppressed
   * contributor (`<contributor deleted="deleted" />`) still gives a
   * {@link Contributor}, with every field `None`.
   */
  contributor: Schema.OptionFromNullOr(Contributor),
  /**
   * The edit summary, from `<comment>`: entity-decoded, trimmed and cut to
   * 4,096 UTF-16 code units. `None` when absent, blank or suppressed
   * (`<comment deleted="deleted" />`); MediaWiki omits an empty summary.
   */
  comment: OptionalText,
  /**
   * The content model id, from `<model>` (`wikitext`, `css`, `json`, …),
   * entity-decoded, trimmed and cut to 4,096 UTF-16 code units; `None` when
   * absent or blank. It is the main slot's: a slot other than the main one
   * (export schema 0.11 puts each in a `<content>` element) is skipped.
   */
  model: OptionalText,
  /**
   * The serialization format, from `<format>` (`text/x-wiki`, …),
   * entity-decoded, trimmed and cut like `model`; `None` when absent or blank.
   * The main slot's, as for `model`.
   */
  format: OptionalText,
  /**
   * The revision's content, from `<text>`: entity-decoded, but neither
   * trimmed nor cut. It is wikitext when `model` is `wikitext`, and then
   * composes with the `Wikitext` parser downstream. `None` when `<text>` is
   * absent or empty, as in a stub dump or for suppressed text
   * (`<text bytes="…" sha1="…" deleted="deleted" />`).
   *
   * A revision whose `<text>` (or any other captured field) runs past
   * 16,777,216 UTF-16 code units, counted before entity decoding (not
   * bytes: UTF-8 takes up to 3 bytes per code unit), becomes a
   * {@link PageRevisionError} instead. It is the main slot's text: export
   * schema 0.11 puts each other slot in a `<content>` element, which is
   * skipped, so its text neither replaces this nor counts towards the cap.
   */
  text: OptionalText,
  /**
   * The `<sha1>`, entity-decoded, trimmed and cut to 4,096 UTF-16 code units,
   * not validated; `None` when absent or empty, as MediaWiki writes it for a
   * revision whose text is suppressed. Export schema 0.11 defines it as one
   * hash over the content of all the revision's slots.
   */
  sha1: OptionalText,
  /** `true` when the revision has a `<minor>` element (MediaWiki writes `<minor/>`), else `false`. */
  isMinor: Schema.Boolean,
});
/** {@link Revision}'s decoded type. */
export type Revision = typeof Revision.Type;

/** A successfully decoded page/revision pair. */
export const PageRevisionHit = Schema.TaggedStruct("revision", {
  /**
   * The enclosing `<page>`'s `title`, `ns`, `id` and `redirect` as read up
   * to this revision (MediaWiki writes them before the first `<revision>`), in a
   * fresh object per record. Every field is `None` for a revision outside
   * any `<page>`.
   */
  page: PageRef,
  /** The decoded revision. Its `id` is never `None`. */
  revision: Revision,
});
/** {@link PageRevisionHit}'s decoded type. */
export type PageRevisionHit = typeof PageRevisionHit.Type;

/**
 * A revision that could not be decoded — the lenient degrade, emitted as an
 * element: a missing or invalid `<id>` (also reported for a `</revision>`
 * with no revision open), a revision left unclosed before the next
 * `<revision>`, `<page>` or `</page>`, a captured field over the length cap,
 * or a stream that ends inside a revision. `detail` says which.
 */
export const PageRevisionError = Schema.TaggedStruct("error", {
  /** Always `"dumps/malformed-revision"`; `PageRevisionError.detail` says which case. */
  reason: Schema.Literal("dumps/malformed-revision"),
  /**
   * The page the revision belonged to, as read so far (see
   * `PageRevisionHit.page`). The reader always sets it.
   */
  page: PageRef,
  /**
   * A short English description for logs. It is currently one of
   * `"revision missing id"`, `"revision not closed before next revision"`,
   * `"revision not closed before end of page"`,
   * `"truncated revision at end of stream"` and
   * `"revision field exceeds the 16777216-code-unit cap"`, which counts
   * UTF-16 code units of the still-escaped text (see `Revision.text`).
   * `"revision missing id"` also covers a `</revision>` with no revision
   * open.
   */
  detail: Schema.String,
});
/** {@link PageRevisionError}'s decoded type. */
export type PageRevisionError = typeof PageRevisionError.Type;

/** One element of the XML page stream: a decoded revision, or a per-record error. */
export const PageRevisionRecord = Schema.Union([PageRevisionHit, PageRevisionError]);
/** {@link PageRevisionRecord}'s decoded type. */
export type PageRevisionRecord = typeof PageRevisionRecord.Type;

// ── Tokenizer (chunk-boundary-safe angle-bracket scan) ───────────────────

/** A structural open tag (`<page>`), close tag (`</page>`), or a text run. */
export type XmlToken =
  | {
      /** `"open"`: a start tag, or the first half of a self-closing one. */
      readonly t: "open";
      /** The element name from {@link tagName}: lower-cased, attributes dropped, any prefix kept. */
      readonly name: string;
      /**
       * The raw text after the element name (`title="A &amp; B"`), trimmed and
       * still entity-escaped, with a self-closing tag's `/` dropped. Absent
       * when the tag has no attributes.
       */
      readonly attributes?: string;
    }
  | {
      /** `"close"`: an end tag, or the second half of a self-closing one. */
      readonly t: "close";
      /** The element name from {@link tagName}, as for an open tag. */
      readonly name: string;
    }
  | {
      /** `"text"`: a run of character data outside any tag. */
      readonly t: "text";
      /**
       * The raw text, neither entity-decoded nor trimmed. One run of text can
       * arrive as several tokens, for example split at a chunk boundary.
       */
      readonly value: string;
    };

/** Extracts a lower-cased element name from a tag body (`revision xml:space="…"` → `revision`). */
export function tagName(body: string): string {
  const trimmed = body.trim();
  return trimmed.slice(0, nameEnd(trimmed)).toLowerCase();
}

/** Where a trimmed tag body's element name ends: its length when nothing follows the name. */
function nameEnd(trimmed: string): number {
  const end = trimmed.search(/[\s/>]/);
  return end === -1 ? trimmed.length : end;
}

/** The open token for a tag body, with its `attributes` when it has any. */
function openToken(body: string): XmlToken {
  const name = tagName(body);
  const trimmed = body.trim();
  const attributes = trimmed.slice(nameEnd(trimmed)).trim();
  return Str.isEmpty(attributes) ? { t: "open", name } : { t: "open", name, attributes };
}

/**
 * Classifies one complete `<…>` tag (angle brackets included) into zero or
 * more tokens: a comment / declaration / doctype yields none; a self-closing
 * `<minor/>` yields an open **and** a close so downstream logic need not
 * special-case it. Only the open token carries the tag's attributes.
 */
export function classifyTag(tag: string): readonly XmlToken[] {
  const inner = tag.slice(1, -1).trim();
  if (Str.isEmpty(inner) || inner.startsWith("!") || inner.startsWith("?")) return [];
  if (inner.startsWith("/")) return [{ t: "close", name: tagName(inner.slice(1)) }];
  if (inner.endsWith("/")) {
    const open = openToken(inner.slice(0, -1));
    return [open, { t: "close", name: tagName(inner.slice(0, -1)) }];
  }
  return [openToken(inner)];
}

/** What {@link tokenizeXml} returns: a buffer's complete tokens and its carry. */
export interface XmlTokenization {
  /** The complete tokens in the buffer, in order. */
  readonly tokens: readonly XmlToken[];
  /**
   * A trailing partial tag, from its `<`, to put in front of the next chunk;
   * `""` when the buffer doesn't end inside a tag.
   */
  readonly rest: string;
}

// One lexeme of a buffer holding no partial tag: a whole tag, from `<` to the
// first `>` after it (which may span a stray `<`), or a maximal run of text.
const XML_TOKEN_RE = /<[^>]*>|[^<]+/g;

/**
 * Scans a buffer into complete tokens plus the unconsumed tail (`rest`) to
 * carry into the next chunk. Only a trailing **partial tag** (`<rev`) is
 * carried — trailing text with no following `<` is emitted immediately (as a
 * text token) rather than carried, so the carry stays bounded by one tag's
 * length even inside a multi-megabyte `<text>` element. That is safe because
 * entity decoding happens later on the assembler's *concatenated* field buffer
 * (see {@link decodeXmlEntities} / {@link XmlPageReader}), so a text run split
 * across chunks — even mid-entity — decodes identically; and because escaped
 * entities never contain `<`, no tag boundary is ever missed. Pure; the
 * streaming state is just the `rest` string.
 */
export function tokenizeXml(buffer: string): XmlTokenization {
  // A partial tag is a `<` with no `>` after it; only the first such `<` (the
  // first after the last `>`) matters, and everything from it is carried.
  const partial = buffer.indexOf("<", buffer.lastIndexOf(">") + 1);
  const complete = partial === -1 ? buffer : buffer.slice(0, partial);
  const tokens = Arr.flatMap(
    Array.from(complete.matchAll(XML_TOKEN_RE)),
    ([lexeme]): readonly XmlToken[] =>
      lexeme.startsWith("<") ? classifyTag(lexeme) : [{ t: "text", value: lexeme }],
  );
  return { tokens, rest: partial === -1 ? "" : buffer.slice(partial) };
}

// ── Entity decoding ──────────────────────────────────────────────────────

// One entity: a whole hex reference, a whole decimal reference or one of the
// of XML's five predefined names (the MediaWiki exporter escapes with these
// alone, and XML defines no others without a DTD). XML spells the hex marker `x`; `X` is also accepted,
// as it always has been here. Any other name (`&nbsp;`, `&constructor;`)
// doesn't match, so it stays as written. No capture groups:
// `String.prototype.replace` passes an unmatched group as `undefined`, so the
// replacer reads the matched text instead.
// The predefined names, keyed by the whole reference, so a lookup needs no
// capture group and an unknown name (`&constructor;`) finds nothing.
const XML_NAMED_ENTITIES = HashMap.make(
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&amp;", "&"],
  ["&quot;", '"'],
  ["&apos;", "'"],
);

const XML_ENTITY_RE = /&(?:#[xX][0-9A-Fa-f]+|#[0-9]+|lt|gt|amp|quot|apos);/g;

/** Decodes one whole reference `XML_ENTITY_RE` matched; the reference itself when it names a forbidden code point. */
function decodeXmlEntity(match: string): string {
  const named = HashMap.get(XML_NAMED_ENTITIES, match);
  if (Option.isSome(named)) return named.value;
  const isHex = match.charAt(2) === "x" || match.charAt(2) === "X";
  const code = isHex ? Number.parseInt(match.slice(3, -1), 16) : Number(match.slice(2, -1));
  return isXmlChar(code) ? String.fromCodePoint(code) : match;
}

// XML 1.0's `Char` production: the code points a character reference may
// name in a well-formed document. NUL, the C0 controls other than tab, LF and
// CR, the surrogates, U+FFFE, U+FFFF and anything past U+10FFFF are excluded.
function isXmlChar(code: number): boolean {
  if (code < 0x20) return code === 0x09 || code === 0x0a || code === 0x0d;
  if (code <= 0xd7ff) return true;
  if (code < 0xe000) return false;
  if (code <= 0xfffd) return true;
  return code >= 0x10000 && code <= 0x10ffff;
}

/**
 * Decodes the XML entity references in a text run, as the
 * {@link XmlPageReader} does for each captured field: the five predefined
 * named entities (`&lt;`, `&gt;`, `&amp;`, `&quot;`, `&apos;`) and whole
 * decimal (`&#65;`) or hex (`&#x41;`) character references.
 *
 * Total: it never throws, and anything it can't decode stays as written. That
 * covers any other name (`&nbsp;`, `&constructor;`), a reference to a code
 * point XML 1.0's `Char` production forbids (NUL and the other C0 controls
 * except tab, LF and CR, a surrogate, U+FFFE, U+FFFF, or past U+10FFFF), and
 * a malformed reference such as `&#65a;` or `&#12.5;`. So a decoded reference
 * never makes the result malformed UTF-16.
 */
export function decodeXmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(XML_ENTITY_RE, decodeXmlEntity);
}

// ── Field bounds & parsing ───────────────────────────────────────────────

/** Upper bound on any single non-text field (title, timestamp, sha1, …). */
const MAX_FIELD_LENGTH = 4096;

/**
 * Upper bound on a captured element's text (the `<text>` wikitext, primarily),
 * in UTF-16 code units of the still-escaped text (`textBuf.length`, before
 * {@link decodeXmlEntities}), not bytes. A real dump revision is bounded by
 * MediaWiki's `$wgMaxArticleSize` (2 MiB of UTF-8 by default, so at most about
 * 2 million code units before escaping, and an escape such as `&amp;` adds at
 * most 5 code units per character), so this is generous headroom; a field
 * that breaches it is a
 * hostile / corrupt dump and degrades the revision to a
 * `dumps/malformed-revision` element rather than being buffered without limit
 * (the "degrade, not crash" posture). Bounding the assembler buffer here plus
 * the bounded tokenizer carry ({@link tokenizeXml}) keeps the pipeline's
 * memory constant even against an adversarial multi-gigabyte `<text>`.
 */
const MAX_TEXT_LENGTH = 16 * 1024 * 1024;

/** Parses a non-negative integer field; `None` for anything else. */
function toInt(value: string): Option.Option<number> {
  if (!/^\d{1,18}$/.test(value.trim())) return Option.none();
  const n = Number.parseInt(value.trim(), 10);
  return Number.isSafeInteger(n) ? Option.some(n) : Option.none();
}

/** Trims and length-bounds a short field; `None` when empty. */
function toField(value: string): Option.Option<string> {
  const trimmed = value.trim();
  if (Str.isEmpty(trimmed)) return Option.none();
  return Option.some(
    trimmed.length > MAX_FIELD_LENGTH ? trimmed.slice(0, MAX_FIELD_LENGTH) : trimmed,
  );
}

// A `title="…"` (or `title='…'`) attribute in a tag's raw attribute text.
const TITLE_ATTRIBUTE_RE = /(?:^|\s)title\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/** The decoded, bounded `title` attribute of a `<redirect>`; `None` when absent or blank. */
function redirectTitle(attributes?: string): Option.Option<string> {
  if (attributes === undefined) return Option.none();
  return Option.fromNullOr(TITLE_ATTRIBUTE_RE.exec(attributes)).pipe(
    Option.flatMap((match) => Option.fromUndefinedOr(match[1] ?? match[2])),
    Option.flatMap((raw) => toField(decodeXmlEntities(raw))),
  );
}

// ── Assembler: tokens → page/revision records ────────────────────────────

interface MutablePage {
  title: Option.Option<string>;
  ns: Option.Option<number>;
  id: Option.Option<number>;
  redirect: Option.Option<string>;
}

interface MutableRevision {
  id: Option.Option<number>;
  parentId: Option.Option<number>;
  timestamp: Option.Option<string>;
  comment: Option.Option<string>;
  model: Option.Option<string>;
  format: Option.Option<string>;
  text: Option.Option<string>;
  sha1: Option.Option<string>;
  minor: boolean;
  contributorUsername: Option.Option<string>;
  contributorId: Option.Option<number>;
  contributorIp: Option.Option<string>;
  hasContributor: boolean;
}

const freshPage = (): MutablePage => ({
  title: Option.none(),
  ns: Option.none(),
  id: Option.none(),
  redirect: Option.none(),
});

const freshRevision = (): MutableRevision => ({
  id: Option.none(),
  parentId: Option.none(),
  timestamp: Option.none(),
  comment: Option.none(),
  model: Option.none(),
  format: Option.none(),
  text: Option.none(),
  sha1: Option.none(),
  minor: false,
  contributorUsername: Option.none(),
  contributorId: Option.none(),
  contributorIp: Option.none(),
  hasContributor: false,
});

/** A leaf setter: stores one captured field's decoded text on its record. */
type Setter<T> = (record: T, value: string) => void;

/** Page-level leaf setters, keyed by element name. */
const PAGE_SETTERS = {
  title: (p, v) => (p.title = toField(v)),
  ns: (p, v) => (p.ns = toInt(v)),
  id: (p, v) => (p.id = toInt(v)),
} satisfies Readonly<Record<string, Setter<MutablePage>>>;

/** Revision-level leaf setters, keyed by element name. */
const REVISION_SETTERS = {
  id: (r, v) => (r.id = toInt(v)),
  parentid: (r, v) => (r.parentId = toInt(v)),
  timestamp: (r, v) => (r.timestamp = toField(v)),
  comment: (r, v) => (r.comment = toField(v)),
  model: (r, v) => (r.model = toField(v)),
  format: (r, v) => (r.format = toField(v)),
  text: (r, v) => (r.text = Str.isEmpty(v) ? Option.none() : Option.some(v)),
  sha1: (r, v) => (r.sha1 = toField(v)),
} satisfies Readonly<Record<string, Setter<MutableRevision>>>;

/** Contributor leaf setters, keyed by element name. */
const CONTRIBUTOR_SETTERS = {
  username: (r, v) => (r.contributorUsername = toField(v)),
  ip: (r, v) => (r.contributorIp = toField(v)),
  id: (r, v) => (r.contributorId = toInt(v)),
} satisfies Readonly<Record<string, Setter<MutableRevision>>>;

/**
 * Stores `value` on `record` with the setter `setters` holds for element
 * `name`; a no-op when it holds none. An own-property test, so an inherited
 * name (`constructor`, `toString`, …) finds nothing.
 */
function applySetter<T>(
  setters: Readonly<Record<string, Setter<T>>>,
  name: string,
  record: T,
  value: string,
): void {
  if (Object.hasOwn(setters, name)) setters[name]?.(record, value);
}

/** Whether element `name` captures a text child in some context. */
const isCaptured = (name: string): boolean =>
  Object.hasOwn(PAGE_SETTERS, name) ||
  Object.hasOwn(REVISION_SETTERS, name) ||
  Object.hasOwn(CONTRIBUTOR_SETTERS, name);

/**
 * The scanner + assembler as one stateful reader: `push` folds a text chunk
 * into zero or more {@link PageRevisionRecord}s; `end` flushes a truncated
 * trailing page. Used as the accumulator of a {@link Stream.mapAccum}, so its
 * mutation stays private to a single stream run.
 */
export class XmlPageReader {
  private carry = "";
  private page = freshPage();
  private rev: Option.Option<MutableRevision> = Option.none();
  private inContributor = false;
  /** Inside a `<content>` (a non-main slot), whose fields are skipped. */
  private inContent = false;
  private capturing: Option.Option<string> = Option.none();
  private textBuf = "";
  /** Set when a captured field breaches {@link MAX_TEXT_LENGTH}; degrades the revision. */
  private textOverLimit = false;

  /** Folds one text chunk into any records it completes. */
  push(chunk: string): readonly PageRevisionRecord[] {
    const { tokens, rest } = tokenizeXml(this.carry + chunk);
    this.carry = rest;
    const out: PageRevisionRecord[] = [];
    Arr.forEach(tokens, (token) => this.consume(token, out));
    return out;
  }

  /** Flushes at end of stream: a page still open mid-revision is a truncation error. */
  end(): readonly PageRevisionRecord[] {
    if (Option.isSome(this.rev)) {
      return [
        {
          _tag: "error",
          reason: "dumps/malformed-revision",
          page: this.snapshotPage(),
          detail: "truncated revision at end of stream",
        },
      ];
    }
    return [];
  }

  private consume(token: XmlToken, out: PageRevisionRecord[]): void {
    if (token.t === "text") {
      if (Option.isSome(this.capturing)) this.appendText(token.value);
      return;
    }
    if (token.t === "open") return this.onOpen(token.name, out, token.attributes);
    this.onClose(token.name, out);
  }

  /** Appends captured text, capping the buffer at {@link MAX_TEXT_LENGTH}. */
  private appendText(value: string): void {
    if (this.textBuf.length >= MAX_TEXT_LENGTH) {
      this.textOverLimit = true;
      return;
    }
    this.textBuf += value;
    if (this.textBuf.length > MAX_TEXT_LENGTH) {
      this.textBuf = this.textBuf.slice(0, MAX_TEXT_LENGTH);
      this.textOverLimit = true;
    }
  }

  private onOpen(name: string, out: PageRevisionRecord[], attributes?: string): void {
    if (name === "page") {
      // A new page while a revision is still open means the previous one was
      // never closed — emit it as malformed rather than dropping it silently.
      this.flushPendingRevision(out, "revision not closed before end of page");
      return this.startPage();
    }
    if (name === "revision") {
      this.flushPendingRevision(out, "revision not closed before next revision");
      return this.startRevision();
    }
    if (this.onRevisionMarker(name)) return;
    if (name === "redirect") {
      if (Option.isNone(this.rev)) this.page.redirect = redirectTitle(attributes);
      return;
    }
    if (isCaptured(name) && !this.inContent) {
      this.capturing = Option.some(name);
      this.textBuf = "";
    }
  }

  /**
   * Opens `<contributor>`, `<content>` or `<minor>`, which mean something only
   * inside a revision (and are ignored outside one); `false` for any other
   * element, which the caller then handles.
   */
  private onRevisionMarker(name: string): boolean {
    if (name !== "contributor" && name !== "content" && name !== "minor") return false;
    if (Option.isNone(this.rev)) return true;
    if (name === "contributor") {
      this.inContributor = true;
      this.rev.value.hasContributor = true;
    } else if (name === "content") {
      this.inContent = true;
    } else {
      this.rev.value.minor = true;
    }
    return true;
  }

  private onClose(name: string, out: PageRevisionRecord[]): void {
    if (Option.exists(this.capturing, (capturing) => capturing === name)) {
      this.store(name, this.textBuf);
      this.capturing = Option.none();
      this.textBuf = "";
      return;
    }
    if (name === "contributor") {
      this.inContributor = false;
      return;
    }
    if (name === "content") {
      this.inContent = false;
      return;
    }
    if (name === "revision") {
      out.push(this.finalizeRevision());
      this.rev = Option.none();
      return;
    }
    if (name === "page") {
      this.flushPendingRevision(out, "revision not closed before end of page");
      this.startPage();
    }
  }

  /**
   * Emits a `dumps/malformed-revision` for a revision that was opened but never
   * closed (a new `<revision>` or `</page>` arrived first), then clears it.
   * No-op when no revision is open, which is the normal case.
   */
  private flushPendingRevision(out: PageRevisionRecord[], detail: string): void {
    if (Option.isNone(this.rev)) return;
    out.push({
      _tag: "error",
      reason: "dumps/malformed-revision",
      page: this.snapshotPage(),
      detail,
    });
    this.rev = Option.none();
    this.inContributor = false;
    this.inContent = false;
    this.capturing = Option.none();
    this.textBuf = "";
    this.textOverLimit = false;
  }

  private store(name: string, raw: string): void {
    const value = decodeXmlEntities(raw);
    if (Option.isSome(this.rev)) {
      applySetter(
        this.inContributor ? CONTRIBUTOR_SETTERS : REVISION_SETTERS,
        name,
        this.rev.value,
        value,
      );
      return;
    }
    applySetter(PAGE_SETTERS, name, this.page, value);
  }

  private startPage(): void {
    this.page = freshPage();
    this.rev = Option.none();
    this.inContributor = false;
    this.inContent = false;
    this.capturing = Option.none();
    this.textBuf = "";
    this.textOverLimit = false;
  }

  private startRevision(): void {
    this.rev = Option.some(freshRevision());
    this.inContributor = false;
    this.inContent = false;
    this.capturing = Option.none();
    this.textBuf = "";
    this.textOverLimit = false;
  }

  private snapshotPage(): PageRef {
    const { title, ns, id, redirect } = this.page;
    return { title, ns, id, redirect };
  }

  private finalizeRevision(): PageRevisionRecord {
    const page = this.snapshotPage();
    const rev = this.rev;
    if (Option.isNone(rev) || Option.isNone(rev.value.id)) {
      return {
        _tag: "error",
        reason: "dumps/malformed-revision",
        page,
        detail: "revision missing id",
      };
    }
    if (this.textOverLimit) {
      return {
        _tag: "error",
        reason: "dumps/malformed-revision",
        page,
        detail: `revision field exceeds the ${MAX_TEXT_LENGTH}-code-unit cap`,
      };
    }
    return { _tag: "revision", page, revision: toRevision(rev.value, rev.value.id.value) };
  }
}

/** Projects the mutable accumulator into the immutable {@link Revision}, given its checked `id`. */
function toRevision(rev: MutableRevision, id: number): Revision {
  const contributor: Option.Option<Contributor> = rev.hasContributor
    ? Option.some({
        username: rev.contributorUsername,
        id: rev.contributorId,
        ip: rev.contributorIp,
      })
    : Option.none();
  return {
    id,
    parentId: rev.parentId,
    timestamp: rev.timestamp,
    contributor,
    comment: rev.comment,
    model: rev.model,
    format: rev.format,
    text: rev.text,
    sha1: rev.sha1,
    isMinor: rev.minor,
  };
}

// ── The pipelines ────────────────────────────────────────────────────────

/**
 * Turns a MediaWiki XML export byte stream into a stream of typed
 * {@link PageRevisionRecord}s — one per `<revision>`, so a full-history page
 * with thousands of revisions streams at constant memory. Decodes UTF-8 and
 * feeds text chunks through {@link XmlPageReader}; a truncated final page
 * flushes as a per-record error rather than failing the stream.
 */
export const pageRecords = <E, R>(
  bytes: Stream.Stream<Uint8Array, E, R>,
): Stream.Stream<PageRevisionRecord, E, R> =>
  bytes.pipe(
    Stream.decodeText(),
    Stream.mapAccum(
      (): XmlPageReader => new XmlPageReader(),
      (reader: XmlPageReader, chunk: string) => [reader, reader.push(chunk)] as const,
      {
        onHalt: (reader: XmlPageReader) => reader.end(),
      },
    ),
  );

/**
 * The daily **incremental** (`add/changes`) dump stream. Wikimedia's daily
 * incrementals are the same MediaWiki export XML — a `<mediawiki>` of the
 * pages that changed that day — so they decode through the identical
 * {@link pageRecords} scanner and expose the identical page/revision surface.
 * Exposed under its own name so intent reads clearly at the call site.
 */
export const incrementalRecords = <E, R>(
  bytes: Stream.Stream<Uint8Array, E, R>,
): Stream.Stream<PageRevisionRecord, E, R> => pageRecords(bytes);

/** Refines a {@link PageRevisionRecord} to a successful {@link PageRevisionHit}. */
const isRevisionHit = (record: PageRevisionRecord): record is PageRevisionHit =>
  P.isTagged(record, "revision");

/**
 * Projects a {@link PageRevisionRecord} stream down to just the successfully
 * decoded {@link PageRevisionHit}s, dropping the per-record error elements.
 */
export const onlyRevisions = <E, R>(
  records: Stream.Stream<PageRevisionRecord, E, R>,
): Stream.Stream<PageRevisionHit, E, R> => records.pipe(Stream.filter(isRevisionHit));

/**
 * Drops the records of redirect pages, those whose `PageRef.redirect`
 * is set, from a {@link PageRevisionRecord} stream: the usual "skip
 * redirects" dump filter, read from the export's `<redirect>` element rather
 * than from each revision's text. A per-record error on a redirect page is
 * dropped with it. Works before or after {@link onlyRevisions}, and never
 * fails.
 */
export const skipRedirects = <A extends PageRevisionRecord, E, R>(
  records: Stream.Stream<A, E, R>,
): Stream.Stream<A, E, R> =>
  records.pipe(Stream.filter((record) => Option.isNone(record.page.redirect)));
