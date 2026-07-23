/**
 * @copyright Thomas Foster
 *
 * The **Wikidata** surface: a fully typed Wikidata item / claim model plus
 * the `wbgetentities` (batched entity fetch) and `wbsearchentities` (label
 * search) endpoints of the Wikibase Action API (`/w/api.php`).
 *
 * Where `packages/wikidata` decodes leniently and narrows only the handful
 * of fields reconciliation needs, this module exposes the honest thing: a
 * discriminated `DataValue` union covering every Wikibase datavalue kind
 * (`wikibase-entityid`, `time`, `globecoordinate`, `quantity`,
 * `monolingualtext`, `string`, `external-id`), branded `Q`/`P`/`L` ids,
 * per-language label / description / alias maps, sitelinks, and statements
 * with rank, qualifiers, and references.
 *
 * **Lenient at the wire, honest in the type.** The Schema layer is
 * deliberately `Unknown`-heavy (every field optional, values left `Unknown`
 * where their shape varies) so a partial, malformed, or *future* payload
 * decodes rather than throwing; the pure normalisers next to each schema
 * then build the typed model. A datavalue whose `type` this module does not
 * recognise — a datatype Wikibase adds after this code ships — degrades to a
 * typed {@link UnknownValue} member carrying the raw payload, **never** a
 * decode failure. The type model is the part that is allowed to be strict.
 *
 * Imports only {@link "./core"} — never `Action`, `Rest`, or `Commons` — so
 * a consumer that imports only `Wikidata` from the package barrel never
 * pulls those modules' code into a bundle.
 *
 * @module wikidata
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DEFAULT_RETRY_OPTIONS, InvalidRequest, type RetryOptions, WikimediaClient } from "./core";

// ── Branded entity ids (Q / P / L) ───────────────────────────────────────

/** A Wikidata **item** id — `Q` followed by digits (`Q42`). */
export const ItemId = Schema.String.pipe(Schema.brand("Wikidata/ItemId"));
export type ItemId = typeof ItemId.Type;

/** A Wikidata **property** id — `P` followed by digits (`P31`). */
export const PropertyId = Schema.String.pipe(Schema.brand("Wikidata/PropertyId"));
export type PropertyId = typeof PropertyId.Type;

/** A Wikidata **lexeme** id — `L` followed by digits (`L1`). */
export const LexemeId = Schema.String.pipe(Schema.brand("Wikidata/LexemeId"));
export type LexemeId = typeof LexemeId.Type;

/** Any of the branded entity ids this module surfaces. */
export type EntityId = ItemId | PropertyId | LexemeId;

/**
 * Validates a Wikidata **item** id (`Q` + digits) and upper-cases it.
 * Returns the branded id or `null`. The strict character class is the
 * injection guard: an id echoed from an untrusted response may be slotted
 * back into a request or persisted downstream, so it must be exclusively
 * `Q` plus digits — never a slash, dot, or path-escaping byte.
 */
export function parseItemId(raw: unknown): ItemId | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().toUpperCase();
  return /^Q[1-9]\d{0,18}$/.test(cleaned) ? (cleaned as ItemId) : null;
}

/** Validates a Wikidata **property** id (`P` + digits); returns the branded id or `null`. */
export function parsePropertyId(raw: unknown): PropertyId | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().toUpperCase();
  return /^P[1-9]\d{0,18}$/.test(cleaned) ? (cleaned as PropertyId) : null;
}

/** Validates a Wikidata **lexeme** id (`L` + digits); returns the branded id or `null`. */
export function parseLexemeId(raw: unknown): LexemeId | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().toUpperCase();
  return /^L[1-9]\d{0,18}$/.test(cleaned) ? (cleaned as LexemeId) : null;
}

/**
 * Validates any entity id, dispatching on the leading letter. Returns the
 * appropriate branded id, or `null` for anything that is not a plain
 * `Q`/`P`/`L` id (lexeme forms / senses like `L1-F1` are intentionally out
 * of scope and degrade to `null`).
 */
export function parseEntityId(raw: unknown): EntityId | null {
  if (typeof raw !== "string") return null;
  const head = raw.trim().charAt(0).toUpperCase();
  if (head === "Q") return parseItemId(raw);
  if (head === "P") return parsePropertyId(raw);
  if (head === "L") return parseLexemeId(raw);
  return null;
}

// ── Field bounds (defence in depth over untrusted response text) ─────────

/** Upper bound on any single free-text field copied from an untrusted response. */
const MAX_TEXT_FIELD_LENGTH = 4000;

/** Cap on how many aliases per language, sitelinks, or statements per property are kept. */
export const MAX_LIST_ENTRIES = 500;

/** The most ids `wbgetentities` accepts per request (Wikibase's documented limit). */
export const MAX_IDS_PER_REQUEST = 50;

/** Trims and length-clamps an untrusted free-text value; `null` for anything unusable. */
function sanitiseText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, MAX_TEXT_FIELD_LENGTH);
}

/** A finite number passed through untouched, or `null`. */
function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A short raw string (calendar / globe / unit IRI, amount), trimmed and bounded, or `null`. */
function toBoundedString(value: unknown, max = 2000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

// ── The datavalue union ──────────────────────────────────────────────────

/** A reference to another entity (`wikibase-entityid`) — an item, property, or lexeme. */
export interface WikibaseEntityIdValue {
  readonly _tag: "wikibase-entityid";
  /** The referenced entity's branded id. */
  readonly id: EntityId;
  /** The raw `entity-type` discriminator (`"item"`, `"property"`, `"lexeme"`, …). */
  readonly entityType: string | null;
}

/**
 * A point in time (`time`) with Wikibase's precision / calendar metadata.
 * `time` is the raw `±YYYY-MM-DDThh:mm:ssZ` string (leading `+` preserved);
 * `precision` is Wikibase's 0–14 precision code; `calendarModel` is the
 * calendar entity IRI (Gregorian `Q1985727`, Julian `Q1985786`).
 */
export interface TimeValue {
  readonly _tag: "time";
  readonly time: string;
  readonly precision: number | null;
  readonly calendarModel: string | null;
  readonly timezone: number | null;
  readonly before: number | null;
  readonly after: number | null;
}

/** A geographic coordinate (`globecoordinate`). `globe` is the globe entity IRI (Earth = `Q2`). */
export interface GlobeCoordinateValue {
  readonly _tag: "globecoordinate";
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly altitude: number | null;
  readonly precision: number | null;
  readonly globe: string | null;
}

/**
 * A dimensioned quantity (`quantity`). `amount` / `upperBound` / `lowerBound`
 * are kept as their raw signed decimal strings (Wikibase does not send them
 * as JSON numbers, to preserve precision); `unit` is the unit entity IRI, or
 * the literal `"1"` for a dimensionless quantity.
 */
export interface QuantityValue {
  readonly _tag: "quantity";
  readonly amount: string;
  readonly unit: string | null;
  readonly upperBound: string | null;
  readonly lowerBound: string | null;
}

/** A language-tagged text (`monolingualtext`). */
export interface MonolingualTextValue {
  readonly _tag: "monolingualtext";
  readonly text: string;
  readonly language: string | null;
}

/**
 * A plain string value (`string` datavalue whose property datatype is not
 * `external-id`) — e.g. a `commonsMedia` filename, a `url`, a bare `string`.
 * The property's datatype is carried on the enclosing {@link ValueSnak}.
 */
export interface StringValue {
  readonly _tag: "string";
  readonly value: string;
}

/**
 * An external-identifier value (`string` datavalue whose property datatype
 * is `external-id`) — a VIAF number, ORCID, ISNI, …. Split out from
 * {@link StringValue} because reconciliation keys `sameAs` links off exactly
 * these, and the split lets a consumer match on `_tag` without re-reading
 * the datatype.
 */
export interface ExternalIdValue {
  readonly _tag: "external-id";
  readonly value: string;
}

/**
 * A datavalue whose `type` this module does not recognise — the lenient
 * degrade. Carries the raw `type` string (when present) and the untouched
 * `value` payload so a caller can still inspect it, but the model makes no
 * structural promise about it. A future Wikibase datatype lands here rather
 * than failing the decode.
 */
export interface UnknownValue {
  readonly _tag: "unknown";
  readonly type: string | null;
  readonly value: unknown;
}

/** The full Wikibase snak datavalue union. */
export type DataValue =
  | WikibaseEntityIdValue
  | TimeValue
  | GlobeCoordinateValue
  | QuantityValue
  | MonolingualTextValue
  | StringValue
  | ExternalIdValue
  | UnknownValue;

// ── Snaks ────────────────────────────────────────────────────────────────

/** A snak asserting a concrete {@link DataValue} for its property. */
export interface ValueSnak {
  readonly _tag: "value";
  readonly property: PropertyId;
  /** The property's datatype (`"wikibase-item"`, `"external-id"`, `"time"`, …). */
  readonly datatype: string | null;
  readonly value: DataValue;
}

/** A snak asserting the property has *some* (unspecified) value. */
export interface SomeValueSnak {
  readonly _tag: "somevalue";
  readonly property: PropertyId;
  readonly datatype: string | null;
}

/** A snak asserting the property has *no* value. */
export interface NoValueSnak {
  readonly _tag: "novalue";
  readonly property: PropertyId;
  readonly datatype: string | null;
}

/** A single snak — the property + value assertion at the heart of every statement. */
export type Snak = ValueSnak | SomeValueSnak | NoValueSnak;

/** A statement's epistemic rank; `"preferred"` values win when a consumer wants "the" value. */
export type StatementRank = "preferred" | "normal" | "deprecated";

/** A reference block backing a statement — a set of snaks grouped by property. */
export interface Reference {
  readonly hash: string | null;
  readonly snaks: Readonly<Record<string, readonly Snak[]>>;
}

/** A single claim on an item: a main snak, its rank, and its qualifiers and references. */
export interface Statement {
  /** The statement GUID (`Q42$...`), when present. */
  readonly id: string | null;
  readonly rank: StatementRank;
  readonly mainsnak: Snak;
  /** Qualifier snaks, keyed by property id. */
  readonly qualifiers: Readonly<Record<string, readonly Snak[]>>;
  readonly references: readonly Reference[];
}

/** One sitelink — the wiki, the linked page title, and any badges. */
export interface Sitelink {
  readonly site: string;
  readonly title: string;
  readonly badges: readonly ItemId[];
}

/** A per-language string map (labels, descriptions), keyed by language code. */
export type LanguageMap = Readonly<Record<string, string>>;

/** The fully typed Wikidata entity. */
export interface WikidataItem {
  readonly id: EntityId;
  /** The entity kind (`"item"`, `"property"`, `"lexeme"`), as Wikibase reports it. */
  readonly type: string | null;
  readonly labels: LanguageMap;
  readonly descriptions: LanguageMap;
  readonly aliases: Readonly<Record<string, readonly string[]>>;
  readonly sitelinks: Readonly<Record<string, Sitelink>>;
  /** Statements keyed by property id (`"P31"`, `"P569"`, …). */
  readonly claims: Readonly<Record<string, readonly Statement[]>>;
}

// ── Lenient wire schemas (Unknown-heavy — never fail on shape drift) ─────

/** The `{ type, value }` datavalue envelope; `value` is left `Unknown` — its shape varies by `type`. */
const RawDataValue = Schema.Struct({
  type: Schema.optional(Schema.Unknown),
  value: Schema.optional(Schema.Unknown),
});
type RawDataValue = typeof RawDataValue.Type;

const RawSnak = Schema.Struct({
  snaktype: Schema.optional(Schema.Unknown),
  property: Schema.optional(Schema.Unknown),
  datatype: Schema.optional(Schema.Unknown),
  datavalue: Schema.optional(RawDataValue),
});
type RawSnak = typeof RawSnak.Type;

const RawSnakList = Schema.Record(Schema.String, Schema.Array(RawSnak));

const RawReference = Schema.Struct({
  hash: Schema.optional(Schema.Unknown),
  snaks: Schema.optional(RawSnakList),
});

const RawStatement = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
  rank: Schema.optional(Schema.Unknown),
  mainsnak: Schema.optional(RawSnak),
  qualifiers: Schema.optional(RawSnakList),
  references: Schema.optional(Schema.Array(RawReference)),
});
type RawStatement = typeof RawStatement.Type;

const RawTermValue = Schema.Struct({
  language: Schema.optional(Schema.Unknown),
  value: Schema.optional(Schema.Unknown),
});

const RawSitelink = Schema.Struct({
  site: Schema.optional(Schema.Unknown),
  title: Schema.optional(Schema.Unknown),
  badges: Schema.optional(Schema.Array(Schema.Unknown)),
});
type RawSitelink = typeof RawSitelink.Type;

const RawEntity = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
  type: Schema.optional(Schema.Unknown),
  // Wikibase flags a non-existent id as `{ id, missing: "" }` keyed under it.
  missing: Schema.optional(Schema.Unknown),
  labels: Schema.optional(Schema.Record(Schema.String, RawTermValue)),
  descriptions: Schema.optional(Schema.Record(Schema.String, RawTermValue)),
  aliases: Schema.optional(Schema.Record(Schema.String, Schema.Array(RawTermValue))),
  sitelinks: Schema.optional(Schema.Record(Schema.String, RawSitelink)),
  claims: Schema.optional(Schema.Record(Schema.String, Schema.Array(RawStatement))),
});
type RawEntity = typeof RawEntity.Type;

/** Lenient schema for the `wbgetentities` response envelope. */
export const WbGetEntitiesResponse = Schema.Struct({
  entities: Schema.optional(Schema.Record(Schema.String, RawEntity)),
});
export type WbGetEntitiesResponse = typeof WbGetEntitiesResponse.Type;

// ── Normalisers: lenient wire shape → honest typed model ─────────────────

/** Reads a `{ [x]: unknown }` field defensively. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Normalises a raw datavalue into the typed {@link DataValue} union.
 * `datatype` (the *property's* datatype, from the enclosing snak) is only
 * consulted to split a `string` datavalue into {@link ExternalIdValue} vs
 * {@link StringValue}. Any `type` this function doesn't recognise — or a
 * recognised `type` whose payload is unusable — degrades to
 * {@link UnknownValue}; this function never returns `null` and never throws.
 */
export function normaliseDataValue(raw: RawDataValue, datatype: string | null): DataValue {
  const type = typeof raw.type === "string" ? raw.type : null;
  const value = raw.value;
  const unknown: UnknownValue = { _tag: "unknown", type, value };
  switch (type) {
    case "wikibase-entityid": {
      const id = parseEntityId(field(value, "id"));
      if (id === null) return unknown;
      const entityType = sanitiseText(field(value, "entity-type"));
      return { _tag: "wikibase-entityid", id, entityType };
    }
    case "time": {
      const time = toBoundedString(field(value, "time"), 64);
      if (time === null) return unknown;
      return {
        _tag: "time",
        time,
        precision: toFiniteNumber(field(value, "precision")),
        calendarModel: toBoundedString(field(value, "calendarmodel")),
        timezone: toFiniteNumber(field(value, "timezone")),
        before: toFiniteNumber(field(value, "before")),
        after: toFiniteNumber(field(value, "after")),
      };
    }
    case "globecoordinate": {
      return {
        _tag: "globecoordinate",
        latitude: toFiniteNumber(field(value, "latitude")),
        longitude: toFiniteNumber(field(value, "longitude")),
        altitude: toFiniteNumber(field(value, "altitude")),
        precision: toFiniteNumber(field(value, "precision")),
        globe: toBoundedString(field(value, "globe")),
      };
    }
    case "quantity": {
      const amount = toBoundedString(field(value, "amount"), 64);
      if (amount === null) return unknown;
      return {
        _tag: "quantity",
        amount,
        unit: toBoundedString(field(value, "unit")),
        upperBound: toBoundedString(field(value, "upperBound"), 64),
        lowerBound: toBoundedString(field(value, "lowerBound"), 64),
      };
    }
    case "monolingualtext": {
      const text = sanitiseText(field(value, "text"));
      if (text === null) return unknown;
      return { _tag: "monolingualtext", text, language: sanitiseText(field(value, "language")) };
    }
    case "string": {
      const str = sanitiseText(value);
      if (str === null) return unknown;
      return datatype === "external-id"
        ? { _tag: "external-id", value: str }
        : { _tag: "string", value: str };
    }
    default:
      return unknown;
  }
}

/** Normalises one raw snak into the typed {@link Snak}; `null` when it carries no valid property. */
export function normaliseSnak(raw: RawSnak): Snak | null {
  const property = parsePropertyId(raw.property);
  if (property === null) return null;
  const datatype = sanitiseText(raw.datatype);
  const snaktype = raw.snaktype;
  if (snaktype === "novalue") return { _tag: "novalue", property, datatype };
  if (snaktype === "somevalue") return { _tag: "somevalue", property, datatype };
  // Otherwise it is a value snak. Wikibase always sends snaktype "value"
  // explicitly, but if a datavalue is somehow absent we fall back to
  // "somevalue" rather than inventing an empty value.
  if (raw.datavalue === undefined) return { _tag: "somevalue", property, datatype };
  return { _tag: "value", property, datatype, value: normaliseDataValue(raw.datavalue, datatype) };
}

/** Normalises a `{ property: snak[] }` block (qualifiers / reference snaks), dropping unusable snaks. */
function normaliseSnakList(
  raw: Readonly<Record<string, readonly RawSnak[]>> | undefined,
): Record<string, readonly Snak[]> {
  const out: Record<string, readonly Snak[]> = {};
  for (const [property, snaks] of Object.entries(raw ?? {})) {
    const validProperty = parsePropertyId(property);
    if (validProperty === null) continue;
    const list: Snak[] = [];
    for (const snak of snaks) {
      if (list.length >= MAX_LIST_ENTRIES) break;
      const normalised = normaliseSnak(snak);
      if (normalised !== null) list.push(normalised);
    }
    if (list.length > 0) out[validProperty] = list;
  }
  return out;
}

function normaliseRank(raw: unknown): StatementRank {
  return raw === "preferred" || raw === "deprecated" ? raw : "normal";
}

/** Normalises one raw statement; `null` when its main snak carries no valid property. */
export function normaliseStatement(raw: RawStatement): Statement | null {
  if (raw.mainsnak === undefined) return null;
  const mainsnak = normaliseSnak(raw.mainsnak);
  if (mainsnak === null) return null;
  const references: Reference[] = [];
  for (const reference of raw.references ?? []) {
    if (references.length >= MAX_LIST_ENTRIES) break;
    references.push({
      hash: sanitiseText(reference.hash),
      snaks: normaliseSnakList(reference.snaks),
    });
  }
  return {
    id: sanitiseText(raw.id),
    rank: normaliseRank(raw.rank),
    mainsnak,
    qualifiers: normaliseSnakList(raw.qualifiers),
    references,
  };
}

/** Normalises a `{ lang: { value } }` term map into a flat `lang → value` map. */
function normaliseTermMap(
  raw: Readonly<Record<string, { readonly value?: unknown }>> | undefined,
): LanguageMap {
  const out: Record<string, string> = {};
  for (const [language, term] of Object.entries(raw ?? {})) {
    const value = sanitiseText(term?.value);
    if (value !== null) out[language] = value;
  }
  return out;
}

function normaliseAliases(
  raw: Readonly<Record<string, readonly { readonly value?: unknown }[]>> | undefined,
): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const [language, terms] of Object.entries(raw ?? {})) {
    const values: string[] = [];
    for (const term of terms) {
      if (values.length >= MAX_LIST_ENTRIES) break;
      const value = sanitiseText(term?.value);
      if (value !== null) values.push(value);
    }
    if (values.length > 0) out[language] = values;
  }
  return out;
}

function normaliseSitelinks(
  raw: Readonly<Record<string, RawSitelink>> | undefined,
): Record<string, Sitelink> {
  const out: Record<string, Sitelink> = {};
  for (const [site, link] of Object.entries(raw ?? {})) {
    const title = sanitiseText(link.title);
    if (title === null) continue;
    const badges: ItemId[] = [];
    for (const badge of link.badges ?? []) {
      const id = parseItemId(badge);
      if (id !== null) badges.push(id);
    }
    out[site] = { site: sanitiseText(link.site) ?? site, title, badges };
  }
  return out;
}

/**
 * Normalises one raw entity into a typed {@link WikidataItem}; `null` when
 * the entity carries no valid id or Wikibase flagged it `missing` (the item
 * does not exist upstream).
 */
export function normaliseItem(raw: RawEntity): WikidataItem | null {
  if (raw.missing !== undefined) return null;
  const id = parseEntityId(raw.id);
  if (id === null) return null;
  const claims: Record<string, readonly Statement[]> = {};
  for (const [property, statements] of Object.entries(raw.claims ?? {})) {
    const validProperty = parsePropertyId(property);
    if (validProperty === null) continue;
    const list: Statement[] = [];
    for (const statement of statements) {
      if (list.length >= MAX_LIST_ENTRIES) break;
      const normalised = normaliseStatement(statement);
      if (normalised !== null) list.push(normalised);
    }
    claims[validProperty] = list;
  }
  return {
    id,
    type: sanitiseText(raw.type),
    labels: normaliseTermMap(raw.labels),
    descriptions: normaliseTermMap(raw.descriptions),
    aliases: normaliseAliases(raw.aliases),
    sitelinks: normaliseSitelinks(raw.sitelinks),
    claims,
  };
}

/**
 * Normalises a whole `wbgetentities` response into typed items keyed by
 * their id. Entities Wikibase flagged `missing`, or that carry no valid id,
 * are omitted — a caller reads "present" as "key exists". Pure and total: a
 * hostile or unexpected payload yields fewer items, never a throw.
 */
export function normaliseEntities(response: WbGetEntitiesResponse): Record<string, WikidataItem> {
  const out: Record<string, WikidataItem> = {};
  for (const raw of Object.values(response.entities ?? {})) {
    const item = normaliseItem(raw);
    if (item !== null) out[item.id] = item;
  }
  return out;
}

// ── wbgetentities (batched, 50-id chunking) ──────────────────────────────

/** Splits `ids` into chunks of at most {@link MAX_IDS_PER_REQUEST}. */
function chunk<A>(ids: readonly A[], size: number): readonly (readonly A[])[] {
  const out: A[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** Options for {@link getEntities}. */
export interface GetEntitiesOptions {
  /** Languages to request labels / descriptions / aliases in. Defaults to all. */
  readonly languages?: readonly string[];
  /**
   * Which entity facets to fetch (`props` parameter). Defaults to
   * `["labels", "descriptions", "aliases", "claims", "sitelinks"]` — the
   * full item. Narrow it to cut response size when you only need some.
   */
  readonly props?: readonly string[];
}

const DEFAULT_PROPS = ["labels", "descriptions", "aliases", "claims", "sitelinks"] as const;

/**
 * Fetches typed Wikidata entities by id via `wbgetentities`, transparently
 * chunking the request at {@link MAX_IDS_PER_REQUEST} ids per call and
 * merging the chunks into one `id → item` record. Ids are validated
 * (`Q`/`P`/`L`) before any request — a malformed id fails
 * {@link InvalidRequest} rather than reaching the wire — and re-validated on
 * the way out, so a hostile echoed id can never key the result. `host` is
 * typically `"www.wikidata.org"`. Entities absent upstream are simply not in
 * the returned record.
 */
export const getEntities = Effect.fn("Wikidata.getEntities")(function* (
  host: string,
  ids: readonly string[],
  options?: GetEntitiesOptions,
  retry?: RetryOptions,
) {
  const validated: EntityId[] = [];
  for (const id of ids) {
    const parsed = parseEntityId(id);
    if (parsed === null) return yield* new InvalidRequest({ kind: "entityId", value: String(id) });
    validated.push(parsed);
  }
  const client = yield* WikimediaClient;
  const props = (options?.props ?? DEFAULT_PROPS).join("|");
  const merged: Record<string, WikidataItem> = {};
  for (const group of chunk(validated, MAX_IDS_PER_REQUEST)) {
    const params: Record<string, string> = {
      action: "wbgetentities",
      ids: group.join("|"),
      props,
      format: "json",
    };
    if (options?.languages !== undefined && options.languages.length > 0) {
      params.languages = options.languages.join("|");
    }
    const response = yield* client.getJson(
      { host, path: "/w/api.php", params },
      WbGetEntitiesResponse,
      retry ?? DEFAULT_RETRY_OPTIONS,
    );
    Object.assign(merged, normaliseEntities(response));
  }
  return merged;
});

// ── wbsearchentities (label search) ──────────────────────────────────────

/** Cap on how many search results a single call returns. */
export const MAX_SEARCH_RESULTS = 50;

const RawSearchHit = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
  label: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.Unknown),
  match: Schema.optional(
    Schema.Struct({
      type: Schema.optional(Schema.Unknown),
      language: Schema.optional(Schema.Unknown),
      text: Schema.optional(Schema.Unknown),
    }),
  ),
});

/** Lenient schema for the `wbsearchentities` response envelope. */
export const WbSearchResponse = Schema.Struct({
  search: Schema.optional(Schema.Array(RawSearchHit)),
});
export type WbSearchResponse = typeof WbSearchResponse.Type;

/** One `wbsearchentities` hit — the matched entity id plus its display label / description. */
export interface SearchHit {
  readonly id: EntityId;
  readonly label: string | null;
  readonly description: string | null;
  /** How the search matched — `"label"`, `"alias"`, `"description"`, … */
  readonly matchType: string | null;
  /** The matched text (a label or alias). */
  readonly matchText: string | null;
}

/** Normalises a `wbsearchentities` response, dropping hits whose id isn't a valid entity id. */
export function normaliseSearch(response: WbSearchResponse): readonly SearchHit[] {
  const out: SearchHit[] = [];
  for (const hit of response.search ?? []) {
    if (out.length >= MAX_SEARCH_RESULTS) break;
    const id = parseEntityId(hit.id);
    if (id === null) continue;
    out.push({
      id,
      label: sanitiseText(hit.label),
      description: sanitiseText(hit.description),
      matchType: sanitiseText(hit.match?.type),
      matchText: sanitiseText(hit.match?.text),
    });
  }
  return out;
}

/** Options for {@link searchEntities}. */
export interface SearchEntitiesOptions {
  /** Language to search / return labels in. Defaults to `"en"`. */
  readonly language?: string;
  /** Entity type to search — `"item"`, `"property"`, `"lexeme"`. Defaults to `"item"`. */
  readonly type?: string;
  /** Max results, bounded by {@link MAX_SEARCH_RESULTS}. Defaults to 10. */
  readonly limit?: number;
}

const LANGUAGE_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;
const SEARCH_TYPE_PATTERN = /^[a-z-]{1,20}$/;

/**
 * Searches Wikidata entities by label / alias via `wbsearchentities`.
 * The query is bounded and the language / type parameters are validated
 * against a strict pattern before the request is built (so neither can
 * smuggle an extra query clause); an empty upstream result is an empty
 * list, not an error.
 */
export const searchEntities = Effect.fn("Wikidata.searchEntities")(function* (
  host: string,
  query: string,
  options?: SearchEntitiesOptions,
  retry?: RetryOptions,
) {
  const cleanedQuery = sanitiseText(query);
  if (cleanedQuery === null) return yield* new InvalidRequest({ kind: "query", value: query });
  const language = options?.language ?? "en";
  if (!LANGUAGE_PATTERN.test(language)) {
    return yield* new InvalidRequest({ kind: "language", value: language });
  }
  const type = options?.type ?? "item";
  if (!SEARCH_TYPE_PATTERN.test(type)) {
    return yield* new InvalidRequest({ kind: "type", value: type });
  }
  const limit = Math.min(Math.max(options?.limit ?? 10, 1), MAX_SEARCH_RESULTS);
  const client = yield* WikimediaClient;
  const response = yield* client.getJson(
    {
      host,
      path: "/w/api.php",
      params: {
        action: "wbsearchentities",
        search: cleanedQuery.slice(0, 300),
        language,
        uselang: language,
        type,
        limit: String(limit),
        format: "json",
      },
    },
    WbSearchResponse,
    retry ?? DEFAULT_RETRY_OPTIONS,
  );
  return normaliseSearch(response);
});
