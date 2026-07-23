/**
 * @copyright Thomas Foster
 *
 * **Entity JSON dump** pipeline — the core of the {@link "./index" | Dumps}
 * surface. A Wikidata entity dump (`.json.bz2` / `.json.gz`) is a single
 * top-level JSON array printed one entity per line:
 *
 * ```text
 * [
 * {"type":"item","id":"Q1",...},
 * {"type":"item","id":"Q2",...},
 * ...
 * {"type":"item","id":"Qn",...}
 * ]
 * ```
 *
 * The opening `[` and closing `]` sit on their own lines, and every entity
 * line except the last carries a trailing comma. This module turns that byte
 * stream into a constant-memory {@link Stream} of typed
 * {@link "../wikidata".WikidataItem} records: decode bytes → text → lines,
 * strip the array framing per line, `JSON.parse` and decode each entity
 * through W2's model. **Lenient by construction** — a line that fails to
 * parse or is not a valid entity becomes a typed {@link DumpLineError}
 * *element*, never a stream failure, so one corrupt line in a 100M-line dump
 * does not tear the pipeline down.
 *
 * Runtime-agnostic: this module imports only `effect` and the pure
 * {@link "../wikidata"} model (never its HTTP client). The byte source and
 * decompression stages live in {@link "./sources"} (Node-only); this module
 * operates on whatever `Stream<Uint8Array>` it is handed.
 *
 * @module dumps/entities
 */

import * as Stream from "effect/Stream";
import { decodeEntity, parsePropertyId, type WikidataItem } from "../wikidata";

// ── Record model ─────────────────────────────────────────────────────────

/** A successfully decoded dump line: the typed entity plus its 1-based line number. */
export interface EntityHit {
  readonly _tag: "entity";
  /** 1-based line number in the dump (the opening `[` is line 1). */
  readonly line: number;
  readonly item: WikidataItem;
}

/** Why a dump line failed to yield an entity. */
export type DumpLineErrorReason = "dumps/invalid-json" | "dumps/not-an-entity";

/**
 * A dump line that did not decode to an entity — the lenient degrade. The
 * pipeline emits this as an element and continues; it never fails the stream.
 * `raw` is the offending line, bounded so a hostile dump cannot blow memory.
 */
export interface DumpLineError {
  readonly _tag: "error";
  readonly line: number;
  readonly reason: DumpLineErrorReason;
  readonly raw: string;
}

/** One element of the entity-dump stream: a decoded entity, or a per-line error. */
export type EntityRecord = EntityHit | DumpLineError;

/** Upper bound on how much of an offending line is retained on a {@link DumpLineError}. */
const MAX_RAW_LENGTH = 500;

// ── Per-line framing + decode ────────────────────────────────────────────

/**
 * Strips the JSON-array framing from a single dump line: trims surrounding
 * whitespace and removes a single trailing comma. Returns the bare entity
 * JSON text, or `null` for a line that carries no entity — a blank line or
 * the array's opening `[` / closing `]` delimiter.
 */
export function stripFraming(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed === "[" || trimmed === "]") return null;
  const body = trimmed.endsWith(",") ? trimmed.slice(0, -1).trim() : trimmed;
  return body.length === 0 ? null : body;
}

/** Bounds an offending line for inclusion on a {@link DumpLineError}. */
function boundRaw(text: string): string {
  return text.length > MAX_RAW_LENGTH ? text.slice(0, MAX_RAW_LENGTH) : text;
}

/** Parses one bare entity-JSON body; `null` when it is not valid JSON. */
function parseJson(body: string): unknown | null {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/**
 * Decodes a single raw dump line into an {@link EntityRecord}, or `null` when
 * the line is pure array framing (`[`, `]`, blank) and carries no record.
 * Total and lenient: invalid JSON or a non-entity object yields a
 * {@link DumpLineError}, never a throw.
 */
export function decodeEntityLine(line: string, lineNumber: number): EntityRecord | null {
  const body = stripFraming(line);
  if (body === null) return null;
  const parsed = parseJson(body);
  if (parsed === null) {
    return { _tag: "error", line: lineNumber, reason: "dumps/invalid-json", raw: boundRaw(body) };
  }
  const item = decodeEntity(parsed);
  if (item === null) {
    return { _tag: "error", line: lineNumber, reason: "dumps/not-an-entity", raw: boundRaw(body) };
  }
  return { _tag: "entity", line: lineNumber, item };
}

// ── The pipeline ─────────────────────────────────────────────────────────

/**
 * Turns a raw dump byte stream into a stream of typed {@link EntityRecord}s.
 * Decodes UTF-8 → lines, tracks a 1-based line counter, and decodes each line
 * leniently. Constant memory: only one line is materialised at a time, and no
 * record is retained past the point a consumer pulls it. Framing lines
 * (`[` / `]`) are dropped; every other line yields exactly one record.
 */
export const entityRecords = <E, R>(
  bytes: Stream.Stream<Uint8Array, E, R>,
): Stream.Stream<EntityRecord, E, R> =>
  bytes.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.mapAccum(
      () => 0,
      (count, line) => {
        const lineNumber = count + 1;
        const record = decodeEntityLine(line, lineNumber);
        return [lineNumber, record === null ? [] : [record]];
      },
    ),
  );

/** Refines an {@link EntityRecord} to a successful {@link EntityHit}. */
const isHit = (record: EntityRecord): record is EntityHit => record._tag === "entity";

/**
 * Projects an {@link EntityRecord} stream down to just the successfully
 * decoded {@link "../wikidata".WikidataItem}s, dropping the per-line error
 * elements. Compose this after {@link entityRecords} when a consumer wants
 * only the good entities and is content to ignore corrupt lines.
 */
export const onlyEntities = <E, R>(
  records: Stream.Stream<EntityRecord, E, R>,
): Stream.Stream<WikidataItem, E, R> =>
  records.pipe(
    Stream.filter(isHit),
    Stream.map((r) => r.item),
  );

// ── Pure predicates (compose with Stream.filter) ─────────────────────────

/** Whether an item's entity kind matches `type` (`"item"`, `"property"`, `"lexeme"`). */
export function hasType(item: WikidataItem, type: string): boolean {
  return item.type === type;
}

/** Whether an item carries at least one statement for the given property (`"P569"`). */
export function hasClaim(item: WikidataItem, property: string): boolean {
  const validated = parsePropertyId(property);
  if (validated === null) return false;
  const statements = item.claims[validated];
  return statements !== undefined && statements.length > 0;
}

/** Whether an item has a sitelink to the given wiki (`"enwiki"`, `"commonswiki"`). */
export function hasSitelink(item: WikidataItem, site: string): boolean {
  return item.sitelinks[site] !== undefined;
}

// ── Stream combinators over decoded items ────────────────────────────────

/** Keeps only items of the given entity kind. */
export const byType =
  (type: string) =>
  <E, R>(items: Stream.Stream<WikidataItem, E, R>): Stream.Stream<WikidataItem, E, R> =>
    items.pipe(Stream.filter((item) => hasType(item, type)));

/** Keeps only items carrying at least one statement for the given property. */
export const withClaim =
  (property: string) =>
  <E, R>(items: Stream.Stream<WikidataItem, E, R>): Stream.Stream<WikidataItem, E, R> =>
    items.pipe(Stream.filter((item) => hasClaim(item, property)));

/** Keeps only items with a sitelink to the given wiki. */
export const withSitelink =
  (site: string) =>
  <E, R>(items: Stream.Stream<WikidataItem, E, R>): Stream.Stream<WikidataItem, E, R> =>
    items.pipe(Stream.filter((item) => hasSitelink(item, site)));
