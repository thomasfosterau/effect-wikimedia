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
 * {@link MAX_TEXT_LENGTH} (16 MB), degrading the revision on breach — so the
 * pipeline stays constant-memory rather than OOMing.
 *
 * Runtime-agnostic: imports only `effect`. The byte source / decompression
 * stages (`fromFile`, `fromHttpRange`, `decompressWith`) live in the
 * Node-only `dumps/sources` module.
 *
 * @copyright Thomas Foster
 * @module dumps/xml
 */

import * as Stream from "effect/Stream";

// ── Typed record model ───────────────────────────────────────────────────

/** The page a revision belongs to. */
export interface PageRef {
  readonly title: string | null;
  /** Namespace number (`0` = main, `14` = category, …). */
  readonly ns: number | null;
  readonly id: number | null;
}

/** Who made a revision. A suppressed / anonymous edit leaves fields `null`. */
export interface Contributor {
  readonly username: string | null;
  readonly id: number | null;
  /** Set instead of `username` for an anonymous (IP) edit. */
  readonly ip: string | null;
}

/** One revision's metadata and wikitext payload. */
export interface Revision {
  readonly id: number | null;
  readonly parentId: number | null;
  readonly timestamp: string | null;
  readonly contributor: Contributor | null;
  readonly comment: string | null;
  readonly model: string | null;
  readonly format: string | null;
  /** The revision's wikitext (entity-decoded). Composes with the `Wikitext` parser downstream. */
  readonly text: string | null;
  readonly sha1: string | null;
  readonly minor: boolean;
}

/** A successfully decoded page/revision pair. */
export interface PageRevisionHit {
  readonly _tag: "revision";
  readonly page: PageRef;
  readonly revision: Revision;
}

/**
 * A revision that could not be decoded (missing required `<id>`, or a
 * truncated trailing page) — the lenient degrade, emitted as an element.
 */
export interface PageRevisionError {
  readonly _tag: "error";
  readonly reason: "dumps/malformed-revision";
  readonly page: PageRef | null;
  readonly detail: string;
}

/** One element of the XML page stream: a decoded revision, or a per-record error. */
export type PageRevisionRecord = PageRevisionHit | PageRevisionError;

// ── Tokenizer (chunk-boundary-safe angle-bracket scan) ───────────────────

/** A structural open tag (`<page>`), close tag (`</page>`), or a text run. */
export type XmlToken =
  | { readonly t: "open"; readonly name: string }
  | { readonly t: "close"; readonly name: string }
  | { readonly t: "text"; readonly value: string };

/** Extracts a lower-cased element name from a tag body (`revision xml:space="…"` → `revision`). */
export function tagName(body: string): string {
  const trimmed = body.trim();
  const end = trimmed.search(/[\s/>]/);
  const raw = end === -1 ? trimmed : trimmed.slice(0, end);
  return raw.toLowerCase();
}

/**
 * Classifies one complete `<…>` tag (angle brackets included) into zero or
 * more tokens: a comment / declaration / doctype yields none; a self-closing
 * `<minor/>` yields an open **and** a close so downstream logic need not
 * special-case it.
 */
export function classifyTag(tag: string): readonly XmlToken[] {
  const inner = tag.slice(1, -1).trim();
  if (inner.length === 0 || inner.startsWith("!") || inner.startsWith("?")) return [];
  if (inner.startsWith("/")) return [{ t: "close", name: tagName(inner.slice(1)) }];
  if (inner.endsWith("/")) {
    const name = tagName(inner.slice(0, -1));
    return [
      { t: "open", name },
      { t: "close", name },
    ];
  }
  return [{ t: "open", name: tagName(inner) }];
}

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
export function tokenizeXml(buffer: string): {
  readonly tokens: readonly XmlToken[];
  readonly rest: string;
} {
  const tokens: XmlToken[] = [];
  let i = 0;
  while (i < buffer.length) {
    const lt = buffer.indexOf("<", i);
    if (lt === -1) {
      tokens.push({ t: "text", value: buffer.slice(i) }); // trailing text — emit, don't carry
      return { tokens, rest: "" };
    }
    if (lt > i) tokens.push({ t: "text", value: buffer.slice(i, lt) });
    const gt = buffer.indexOf(">", lt);
    if (gt === -1) return { tokens, rest: buffer.slice(lt) }; // partial tag — carry from '<'
    for (const token of classifyTag(buffer.slice(lt, gt + 1))) tokens.push(token);
    i = gt + 1;
  }
  return { tokens, rest: "" };
}

// ── Entity decoding ──────────────────────────────────────────────────────

// XML's five predefined entities, and nothing more: the MediaWiki exporter
// escapes with these alone, and XML defines no others without a DTD. A Map,
// not an object literal: a lookup on `{}` also finds the inherited
// `constructor`, `toString`, … (`&constructor;` is a well-formed entity).
const XML_NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["lt", "<"],
  ["gt", ">"],
  ["amp", "&"],
  ["quot", '"'],
  ["apos", "'"],
]);

// One entity: a whole hex reference (group 1), a whole decimal reference
// (group 2) or a name (group 3). XML spells the hex marker `x`; `X` is also
// accepted, as it always has been here.
const XML_ENTITY_RE = /&(?:#[xX]([0-9A-Fa-f]+)|#([0-9]+)|([A-Za-z][A-Za-z0-9]*));/g;

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
 * a malformed reference such as `&#65a;` or `&#12.5;`. So the result is always
 * well-formed UTF-16.
 */
export function decodeXmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    XML_ENTITY_RE,
    (match, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
      if (name !== undefined) return XML_NAMED_ENTITIES.get(name) ?? match;
      const code = hex === undefined ? Number(dec) : Number.parseInt(hex, 16);
      return isXmlChar(code) ? String.fromCodePoint(code) : match;
    },
  );
}

// ── Field bounds & parsing ───────────────────────────────────────────────

/** Upper bound on any single non-text field (title, timestamp, sha1, …). */
const MAX_FIELD_LENGTH = 4096;

/**
 * Upper bound on a captured element's text (the `<text>` wikitext, primarily).
 * A real dump revision is bounded by MediaWiki's `$wgMaxArticleSize` (≈2 MB by
 * default), so 16 MB is generous headroom; a field that breaches it is a
 * hostile / corrupt dump and degrades the revision to a
 * `dumps/malformed-revision` element rather than being buffered without limit
 * (the "degrade, not crash" posture). Bounding the assembler buffer here plus
 * the bounded tokenizer carry ({@link tokenizeXml}) keeps the pipeline's
 * memory constant even against an adversarial multi-gigabyte `<text>`.
 */
const MAX_TEXT_LENGTH = 16 * 1024 * 1024;

/** Parses a non-negative integer field; `null` for anything else. */
function toInt(value: string): number | null {
  if (!/^\d{1,18}$/.test(value.trim())) return null;
  const n = Number.parseInt(value.trim(), 10);
  return Number.isSafeInteger(n) ? n : null;
}

/** Trims and length-bounds a short field; `null` when empty. */
function toField(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_FIELD_LENGTH ? trimmed.slice(0, MAX_FIELD_LENGTH) : trimmed;
}

// ── Assembler: tokens → page/revision records ────────────────────────────

interface MutablePage {
  title: string | null;
  ns: number | null;
  id: number | null;
}

interface MutableRevision {
  id: number | null;
  parentId: number | null;
  timestamp: string | null;
  comment: string | null;
  model: string | null;
  format: string | null;
  text: string | null;
  sha1: string | null;
  minor: boolean;
  contributorUsername: string | null;
  contributorId: number | null;
  contributorIp: string | null;
  hasContributor: boolean;
}

const freshPage = (): MutablePage => ({ title: null, ns: null, id: null });

const freshRevision = (): MutableRevision => ({
  id: null,
  parentId: null,
  timestamp: null,
  comment: null,
  model: null,
  format: null,
  text: null,
  sha1: null,
  minor: false,
  contributorUsername: null,
  contributorId: null,
  contributorIp: null,
  hasContributor: false,
});

/** Page-level leaf setters, keyed by element name. */
const PAGE_SETTERS: Readonly<Record<string, (p: MutablePage, value: string) => void>> = {
  title: (p, v) => (p.title = toField(v)),
  ns: (p, v) => (p.ns = toInt(v)),
  id: (p, v) => (p.id = toInt(v)),
};

/** Revision-level leaf setters, keyed by element name. */
const REVISION_SETTERS: Readonly<Record<string, (r: MutableRevision, value: string) => void>> = {
  id: (r, v) => (r.id = toInt(v)),
  parentid: (r, v) => (r.parentId = toInt(v)),
  timestamp: (r, v) => (r.timestamp = toField(v)),
  comment: (r, v) => (r.comment = toField(v)),
  model: (r, v) => (r.model = toField(v)),
  format: (r, v) => (r.format = toField(v)),
  text: (r, v) => (r.text = v.length === 0 ? null : v),
  sha1: (r, v) => (r.sha1 = toField(v)),
};

/** Contributor leaf setters, keyed by element name. */
const CONTRIBUTOR_SETTERS: Readonly<Record<string, (r: MutableRevision, value: string) => void>> = {
  username: (r, v) => (r.contributorUsername = toField(v)),
  ip: (r, v) => (r.contributorIp = toField(v)),
  id: (r, v) => (r.contributorId = toInt(v)),
};

/** Element names that capture a text child in some context. */
const CAPTURED = new Set<string>([
  ...Object.keys(PAGE_SETTERS),
  ...Object.keys(REVISION_SETTERS),
  ...Object.keys(CONTRIBUTOR_SETTERS),
]);

/**
 * The scanner + assembler as one stateful reader: `push` folds a text chunk
 * into zero or more {@link PageRevisionRecord}s; `end` flushes a truncated
 * trailing page. Used as the accumulator of a {@link Stream.mapAccum}, so its
 * mutation stays private to a single stream run.
 */
export class XmlPageReader {
  private carry = "";
  private page = freshPage();
  private rev: MutableRevision | null = null;
  private inContributor = false;
  private capturing: string | null = null;
  private textBuf = "";
  /** Set when a captured field breaches {@link MAX_TEXT_LENGTH}; degrades the revision. */
  private textOverLimit = false;

  /** Folds one text chunk into any records it completes. */
  push(chunk: string): readonly PageRevisionRecord[] {
    const { tokens, rest } = tokenizeXml(this.carry + chunk);
    this.carry = rest;
    const out: PageRevisionRecord[] = [];
    for (const token of tokens) this.consume(token, out);
    return out;
  }

  /** Flushes at end of stream: a page still open mid-revision is a truncation error. */
  end(): readonly PageRevisionRecord[] {
    if (this.rev !== null) {
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
      if (this.capturing !== null) this.appendText(token.value);
      return;
    }
    if (token.t === "open") return this.onOpen(token.name, out);
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

  private onOpen(name: string, out: PageRevisionRecord[]): void {
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
    if (name === "contributor") {
      if (this.rev !== null) {
        this.inContributor = true;
        this.rev.hasContributor = true;
      }
      return;
    }
    if (name === "minor") {
      if (this.rev !== null) this.rev.minor = true;
      return;
    }
    if (CAPTURED.has(name)) {
      this.capturing = name;
      this.textBuf = "";
    }
  }

  private onClose(name: string, out: PageRevisionRecord[]): void {
    if (this.capturing === name) {
      this.store(name, this.textBuf);
      this.capturing = null;
      this.textBuf = "";
      return;
    }
    if (name === "contributor") {
      this.inContributor = false;
      return;
    }
    if (name === "revision") {
      out.push(this.finalizeRevision());
      this.rev = null;
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
    if (this.rev === null) return;
    out.push({
      _tag: "error",
      reason: "dumps/malformed-revision",
      page: this.snapshotPage(),
      detail,
    });
    this.rev = null;
    this.inContributor = false;
    this.capturing = null;
    this.textBuf = "";
    this.textOverLimit = false;
  }

  private store(name: string, raw: string): void {
    const value = decodeXmlEntities(raw);
    if (this.inContributor && this.rev !== null) {
      CONTRIBUTOR_SETTERS[name]?.(this.rev, value);
      return;
    }
    if (this.rev !== null) {
      REVISION_SETTERS[name]?.(this.rev, value);
      return;
    }
    PAGE_SETTERS[name]?.(this.page, value);
  }

  private startPage(): void {
    this.page = freshPage();
    this.rev = null;
    this.inContributor = false;
    this.capturing = null;
    this.textBuf = "";
    this.textOverLimit = false;
  }

  private startRevision(): void {
    this.rev = freshRevision();
    this.inContributor = false;
    this.capturing = null;
    this.textBuf = "";
    this.textOverLimit = false;
  }

  private snapshotPage(): PageRef {
    return { title: this.page.title, ns: this.page.ns, id: this.page.id };
  }

  private finalizeRevision(): PageRevisionRecord {
    const rev = this.rev;
    const page = this.snapshotPage();
    if (rev === null || rev.id === null) {
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
        detail: `revision field exceeds the ${MAX_TEXT_LENGTH}-byte cap`,
      };
    }
    return { _tag: "revision", page, revision: toRevision(rev) };
  }
}

/** Projects the mutable accumulator into the immutable {@link Revision}. */
function toRevision(rev: MutableRevision): Revision {
  const contributor: Contributor | null = rev.hasContributor
    ? { username: rev.contributorUsername, id: rev.contributorId, ip: rev.contributorIp }
    : null;
  return {
    id: rev.id,
    parentId: rev.parentId,
    timestamp: rev.timestamp,
    contributor,
    comment: rev.comment,
    model: rev.model,
    format: rev.format,
    text: rev.text,
    sha1: rev.sha1,
    minor: rev.minor,
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
  record._tag === "revision";

/**
 * Projects a {@link PageRevisionRecord} stream down to just the successfully
 * decoded {@link PageRevisionHit}s, dropping the per-record error elements.
 */
export const onlyRevisions = <E, R>(
  records: Stream.Stream<PageRevisionRecord, E, R>,
): Stream.Stream<PageRevisionHit, E, R> => records.pipe(Stream.filter(isRevisionHit));
