/**
 * **Multistream index** pipeline: reads the index Wikimedia publishes next to
 * a `pages-articles-multistream.xml.bz2` dump
 * (`pages-articles-multistream-index.txt.bz2`), so a caller can find the
 * bzip2 stream that holds a page and decode that stream on its own.
 *
 * ## The format
 *
 * The multistream dump is a concatenation of independent bzip2 streams: a
 * header stream at offset `0` (`<mediawiki>` and `<siteinfo>`), then streams
 * of up to 100 `<page>` elements each, then a trailer stream
 * (`</mediawiki>`). The index is one UTF-8 line per page,
 * `offset:pageId:title`:
 *
 * ```text
 * 616:10:AccessibleComputing
 * 616:12:Anarchism
 * 660945:1438:Category:Writers
 * ```
 *
 * `offset` is the byte offset, in the **compressed** `.xml.bz2`, of the
 * bzip2 stream that holds the page. Every page in one stream shares it, and
 * it ascends through the file. Neither the header nor the trailer stream is
 * listed. The title is everything after the second colon, since titles
 * contain colons; it is taken to be XML-escaped as in the dump (`AT&amp;T`)
 * and decoded, which is harmless if it is not, as a MediaWiki title cannot
 * contain a character reference.
 *
 * Each stream is complete bzip2 data, so the compressed bytes
 * `[start, end)` of one {@link MultistreamRange} decompress on their own
 * through any bzip2 decoder, and the decompressed text, a run of `<page>`
 * elements with no `<mediawiki>` around them, decodes through
 * {@link Dumps.pageRecords} unchanged.
 *
 * **Strict, unlike the dump pipelines.** A malformed line, or an offset that
 * goes backwards, fails the stream with a {@link MultistreamIndexError}: a
 * corrupt index makes every offset in it suspect, so there is no per-line
 * degrade.
 *
 * Runtime-agnostic: imports only `effect` and the XML module's entity
 * decoder. Reading the index file, and the bzip2 decoder it needs, are the
 * caller's (see {@link Dumps.fromFile} and {@link Dumps.Decompressor}).
 *
 * @copyright Thomas Foster
 * @module dumps/multistream
 */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import { decodeXmlEntities } from "./xml.ts";

// ── Record model & error ─────────────────────────────────────────────────

/** One decoded line of a multistream index: where one page's bzip2 stream starts. */
export interface MultistreamIndexEntry {
  /**
   * 1-based line number in the decompressed index text. Every line counts,
   * blank ones included; a `\n`, a `\r\n` or a lone `\r` each end one line.
   * From {@link decodeIndexLine} it is the `lineNumber` passed in.
   */
  readonly line: number;
  /**
   * The byte offset, in the compressed `.xml.bz2`, of the bzip2 stream that
   * holds the page: a non-negative safe integer. Pages in the same stream
   * share it.
   */
  readonly offset: number;
  /** The page id: a non-negative safe integer. */
  readonly pageId: number;
  /**
   * The page title, namespace prefix included (`Category:Writers`), with its
   * XML character references decoded as {@link Dumps.decodeXmlEntities} does
   * (`AT&amp;T` becomes `AT&T`). Never empty; not trimmed.
   */
  readonly title: string;
}

/**
 * A multistream index that can't be trusted: the failure
 * {@link multistreamIndexRecords} and {@link multistreamRanges} fail their
 * stream with. `reason` says which check failed and `line` where.
 */
export class MultistreamIndexError extends Schema.TaggedError<MultistreamIndexError>()(
  "MultistreamIndexError",
  {
    /**
     * Which check failed: `"dumps/malformed-index-line"` for a line that is
     * not `offset:pageId:title` with a decimal `offset` and `pageId` (digits
     * only, at most 18 each, and a safe integer) and a title that is not
     * empty; `"dumps/index-offset-decreased"` for an entry whose offset is
     * below the stream before it; `"dumps/index-offset-past-file-size"` for
     * an entry whose offset is at or past the `fileSize` given to
     * {@link multistreamRanges}.
     */
    reason: Schema.Literals([
      "dumps/malformed-index-line",
      "dumps/index-offset-decreased",
      "dumps/index-offset-past-file-size",
    ]),
    /** The 1-based number of the offending line, counted as for {@link MultistreamIndexEntry.line}. */
    line: Schema.Number,
    /**
     * A short account for logs rather than parsing. For a malformed line it
     * is the line itself, cut to its first 500 UTF-16 code units (the cut can
     * split a surrogate pair); for an offset it names the offsets compared.
     */
    detail: Schema.String,
  },
) {}

/**
 * One bzip2 stream of a multistream dump, as the index describes it: the
 * half-open byte range `[start, end)` of the compressed `.xml.bz2` to read
 * and decompress on its own, and which pages it holds.
 */
export interface MultistreamRange {
  /** The stream's byte offset in the compressed file: the shared `offset` of its entries. */
  readonly start: number;
  /**
   * The byte offset just past the stream, exclusive, and always above
   * `start`: the next range's `start`. On the last range it is the
   * `fileSize` given to {@link multistreamRanges}, or `null` without one,
   * meaning the end of the file. Either way the last range also takes in the
   * trailer stream (`</mediawiki>`), which decodes to no records.
   */
  readonly end: number | null;
  /** How many index entries share this stream: Wikimedia writes 100, the last stream fewer. */
  readonly pageCount: number;
  /** The `pageId` of the stream's first index entry. */
  readonly firstPageId: number;
  /** The `pageId` of the stream's last index entry. */
  readonly lastPageId: number;
}

/** Options for {@link multistreamRanges}. */
export interface MultistreamRangesOptions {
  /**
   * The size in bytes of the compressed `.xml.bz2`, which the index doesn't
   * record. Given, it closes the last range (`end: fileSize`), and an entry
   * whose offset is at or past it fails the stream with a
   * {@link MultistreamIndexError}. Omitted, the last range's `end` is `null`.
   */
  readonly fileSize?: number | undefined;
}

/** Upper bound on how much of an offending line is retained on a {@link MultistreamIndexError}. */
const MAX_RAW_LENGTH = 500;

// ── Per-line decode ──────────────────────────────────────────────────────

/** `offset:pageId:title`; the title (group 3) runs to the end of the line and may hold colons. */
const INDEX_LINE_RE = /^(\d{1,18}):(\d{1,18}):(.*)$/s;

/** Parses a decimal field already matched as 1–18 digits; `null` past `Number.MAX_SAFE_INTEGER`. */
function toSafeInt(digits: string): number | null {
  const n = Number.parseInt(digits, 10);
  return Number.isSafeInteger(n) ? n : null;
}

const malformed = (line: string, lineNumber: number): MultistreamIndexError =>
  new MultistreamIndexError({
    reason: "dumps/malformed-index-line",
    line: lineNumber,
    detail: line.length > MAX_RAW_LENGTH ? line.slice(0, MAX_RAW_LENGTH) : line,
  });

/**
 * Decodes one line of a multistream index: a success holding its
 * {@link MultistreamIndexEntry}, or holding `null` for a blank line (the
 * index ends in a newline, and a line of only whitespace carries nothing),
 * or a failure holding a `"dumps/malformed-index-line"`
 * {@link MultistreamIndexError} for a line that isn't `offset:pageId:title`.
 * Never throws. Splits on the first two colons only, so a title keeps its own
 * (`660945:1438:Category:Writers`), and decodes the title's XML character
 * references.
 */
export function decodeIndexLine(
  line: string,
  lineNumber: number,
): Result.Result<MultistreamIndexEntry | null, MultistreamIndexError> {
  if (Str.isEmpty(line.trim())) return Result.succeed(null);
  const match = INDEX_LINE_RE.exec(line);
  if (match === null) return Result.fail(malformed(line, lineNumber));
  const [, offsetDigits = "", pageIdDigits = "", rawTitle = ""] = match;
  const offset = toSafeInt(offsetDigits);
  const pageId = toSafeInt(pageIdDigits);
  const title = decodeXmlEntities(rawTitle);
  if (offset === null || pageId === null || Str.isEmpty(title)) {
    return Result.fail(malformed(line, lineNumber));
  }
  return Result.succeed({ line: lineNumber, offset, pageId, title });
}

// ── The index stream ─────────────────────────────────────────────────────

/**
 * Decodes one line, numbered `linesSoFar + 1`, failing on a malformed one.
 * Per element, not per chunk, so every entry before a malformed line is
 * emitted before the stream fails.
 */
const decodeNextLine = (
  linesSoFar: number,
  line: string,
): Effect.Effect<readonly [number, ReadonlyArray<MultistreamIndexEntry>], MultistreamIndexError> =>
  Effect.fromResult(decodeIndexLine(line, linesSoFar + 1)).pipe(
    Effect.map((entry) => [linesSoFar + 1, entry === null ? [] : [entry]]),
  );

/**
 * Turns the bytes of a decompressed multistream index into a stream of
 * {@link MultistreamIndexEntry}s, one per non-blank line, in file order.
 * Decodes UTF-8 and splits lines; a malformed line fails the stream with a
 * `"dumps/malformed-index-line"` {@link MultistreamIndexError}, after the
 * entries before it. Constant memory: one line at a time.
 *
 * The index is published bzip2-compressed, so put a bzip2
 * {@link Dumps.Decompressor} in front, as {@link Dumps.fromFile}'s
 * `decompressor` option or through {@link Dumps.decompressWith}.
 */
export const multistreamIndexRecords = <E, R>(
  bytes: Stream.Stream<Uint8Array, E, R>,
): Stream.Stream<MultistreamIndexEntry, E | MultistreamIndexError, R> =>
  bytes.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.mapAccumEffect(() => 0, decodeNextLine),
  );

// ── Grouping into ranges ─────────────────────────────────────────────────

/** The range being grouped: every field but its `end`, which the next group supplies. */
type OpenRange = Omit<MultistreamRange, "end">;

const openRange = (entry: MultistreamIndexEntry): OpenRange => ({
  start: entry.offset,
  pageCount: 1,
  firstPageId: entry.pageId,
  lastPageId: entry.pageId,
});

const closeRange = (range: OpenRange, end: number | null): MultistreamRange => ({ ...range, end });

/** The offset check for one entry: `null` when it passes. */
function offsetError(
  open: OpenRange | null,
  entry: MultistreamIndexEntry,
  fileSize: number | undefined,
): MultistreamIndexError | null {
  if (fileSize !== undefined && entry.offset >= fileSize) {
    return new MultistreamIndexError({
      reason: "dumps/index-offset-past-file-size",
      line: entry.line,
      detail: `offset ${entry.offset} is at or past the file size ${fileSize}`,
    });
  }
  if (open !== null && entry.offset < open.start) {
    return new MultistreamIndexError({
      reason: "dumps/index-offset-decreased",
      line: entry.line,
      detail: `offset ${entry.offset} is below the previous offset ${open.start}`,
    });
  }
  return null;
}

/**
 * Folds one entry into the open range, closing it when the entry starts the
 * next stream, and failing when its offset fails the check. Per element, so
 * every range closed before the offending entry is emitted first.
 */
const groupEntry =
  (fileSize: number | undefined) =>
  (
    open: OpenRange | null,
    entry: MultistreamIndexEntry,
  ): Effect.Effect<
    readonly [OpenRange, ReadonlyArray<MultistreamRange>],
    MultistreamIndexError
  > => {
    const error = offsetError(open, entry, fileSize);
    if (error !== null) return Effect.fail(error);
    if (open === null) return Effect.succeed([openRange(entry), []]);
    if (open.start === entry.offset) {
      return Effect.succeed([
        { ...open, pageCount: open.pageCount + 1, lastPageId: entry.pageId },
        [],
      ]);
    }
    return Effect.succeed([openRange(entry), [closeRange(open, entry.offset)]]);
  };

/**
 * Groups index entries into the dump's bzip2 streams: one
 * {@link MultistreamRange} per run of entries that share an `offset`, in
 * index order, each emitted once the next run starts (the last at the end of
 * the stream, its `end` the `fileSize` option or `null`). Use it after
 * {@link multistreamIndexRecords} in a `pipe`, as
 * `Dumps.multistreamRanges()` or `Dumps.multistreamRanges({ fileSize })`.
 *
 * Fails the stream with a {@link MultistreamIndexError} at an entry whose
 * offset is below the one before it (`"dumps/index-offset-decreased"`), so
 * every range emitted has `end` above `start`; or, given `fileSize`, at one
 * whose offset is at or past it (`"dumps/index-offset-past-file-size"`).
 * Constant memory: a range carries counts and its first and last page ids
 * rather than its entries, so even an index that puts every line on one
 * offset holds one range at a time; keep the entry stream for titles.
 *
 * To decode one range, read the compressed bytes `[start, end)` of the
 * `.xml.bz2` (to the end of the file when `end` is `null`), decompress them
 * with a fresh bzip2 decoder, and feed the result to
 * {@link Dumps.pageRecords}.
 */
export const multistreamRanges =
  (options?: MultistreamRangesOptions) =>
  <E, R>(
    entries: Stream.Stream<MultistreamIndexEntry, E, R>,
  ): Stream.Stream<MultistreamRange, E | MultistreamIndexError, R> => {
    const fileSize = options?.fileSize;
    return entries.pipe(
      Stream.mapAccumEffect((): OpenRange | null => null, groupEntry(fileSize), {
        onHalt: (open) => (open === null ? [] : [closeRange(open, fileSize ?? null)]),
      }),
    );
  };
