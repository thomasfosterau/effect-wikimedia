/**
 * The **Wikidata** surface: a fully typed Wikidata item / claim model plus
 * the `wbgetentities` (batched entity fetch) and `wbsearchentities` (label
 * search) endpoints of the Wikibase Action API (`/w/api.php`).
 *
 * Requests are anonymous: `Core` sends every `/w/api.php` request with
 * `origin=*`, so a browser page on another origin can read the response,
 * and MediaWiki then ignores any session cookies or `Authorization` header
 * (see {@link Core.WikimediaRequest}).
 *
 * Rather than narrowing only the handful of fields reconciliation needs,
 * this module exposes the honest thing: a
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
 * Imports only {@link Core} — never `Action`, `Rest`, or `Commons` — so
 * a consumer that imports only `Wikidata` from the package barrel never
 * pulls those modules' code into a bundle.
 *
 * @copyright Thomas Foster
 * @module
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  DEFAULT_RETRY_OPTIONS,
  InvalidRequest,
  type RetryOptions,
  WikimediaClient,
} from "./core.ts";

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

/**
 * Cap on how many entries of each list built from a response are kept: aliases
 * per language, sitelinks per entity, badges per sitelink, statements per
 * property, references per statement, and snaks per property in a qualifier or
 * reference block. Each list keeps its first usable entries, in Wikibase's
 * order; an entry that is dropped as unusable does not count towards the cap.
 */
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
  /** Discriminates this value in the {@link DataValue} union: Wikibase's datavalue `type`. */
  readonly _tag: "wikibase-entityid";
  /**
   * The referenced entity's branded id, upper-cased. A value whose `id` is
   * not a plain `Q`/`P`/`L` id (a lexeme form or sense such as `L1-F1`, an
   * entity schema such as `E10`, or a legacy value with only a `numeric-id`)
   * degrades to {@link UnknownValue} instead.
   */
  readonly id: EntityId;
  /**
   * The raw `entity-type` discriminator (`"item"`, `"property"`, `"lexeme"`,
   * …), trimmed; `null` when Wikibase sent none. It is not checked against
   * {@link WikibaseEntityIdValue.id}'s prefix.
   */
  readonly entityType: string | null;
}

/**
 * A point in time (`time`) with Wikibase's precision / calendar metadata.
 * `time` is the raw `±YYYY-MM-DDThh:mm:ssZ` string (leading `+` preserved);
 * `precision` is Wikibase's 0–14 precision code; `calendarModel` is the
 * calendar entity IRI (Gregorian `Q1985727`, Julian `Q1985786`).
 */
export interface TimeValue {
  /** Discriminates this value in the {@link DataValue} union: Wikibase's datavalue `type`. */
  readonly _tag: "time";
  /**
   * The timestamp as Wikibase sent it, trimmed and cut at 64 characters: a
   * signed year, then `-MM-DDThh:mm:ssZ`, such as `+1952-03-11T00:00:00Z`.
   * It is not parsed or validated. The year may run past four digits, and
   * the fields finer than {@link TimeValue.precision} are usually zero, so
   * a year-only date reads `+1952-00-00T00:00:00Z`. A value with no usable
   * `time` degrades to {@link UnknownValue}.
   */
  readonly time: string;
  /**
   * Wikibase's precision code, saying how much of {@link TimeValue.time} is
   * meaningful: `9` year, `10` month, `11` day, `12` hour, `13` minute, `14`
   * second; `8` decade, `7` century, `6` millennium, and `5` down to `0` for
   * 10⁴ to 10⁹ years. `null` when absent or not a finite number; it is not
   * range-checked.
   */
  readonly precision: number | null;
  /**
   * The calendar model's entity IRI, such as
   * `http://www.wikidata.org/entity/Q1985727` (proleptic Gregorian) or
   * `…/Q1985786` (proleptic Julian), saying which calendar
   * {@link TimeValue.time} is written in. `null` when absent; the IRI is not
   * validated.
   */
  readonly calendarModel: string | null;
  /**
   * The time zone offset from UTC, in minutes. Wikibase does not use it yet
   * and normally sends `0`; `null` when absent or not a finite number.
   */
  readonly timezone: number | null;
  /**
   * How far the true time may lie before {@link TimeValue.time}, in units
   * of {@link TimeValue.precision}. Wikibase does not use it yet and
   * normally sends `0`; `null` when absent or not a finite number.
   */
  readonly before: number | null;
  /**
   * How far the true time may lie after {@link TimeValue.time}, in units
   * of {@link TimeValue.precision}. Wikibase does not use it yet and
   * normally sends `0`; `null` when absent or not a finite number.
   */
  readonly after: number | null;
}

/**
 * A geographic coordinate (`globecoordinate`). `globe` is the globe entity
 * IRI (Earth = `Q2`). Every field may be `null`, so a `globecoordinate`
 * datavalue never degrades to {@link UnknownValue}.
 */
export interface GlobeCoordinateValue {
  /** Discriminates this value in the {@link DataValue} union: Wikibase's datavalue `type`. */
  readonly _tag: "globecoordinate";
  /** The latitude in decimal degrees, north positive; `null` when absent or not a finite number. */
  readonly latitude: number | null;
  /** The longitude in decimal degrees, east positive; `null` when absent or not a finite number. */
  readonly longitude: number | null;
  /**
   * The altitude, which Wikibase has never used and sends as `null`; `null`
   * also when it is not a finite number.
   */
  readonly altitude: number | null;
  /**
   * How precise the coordinate is, in degrees (`0.0002777…` is one
   * arcsecond). `null` when Wikibase sent none, as on some older
   * statements, or it is not a finite number.
   */
  readonly precision: number | null;
  /**
   * The entity IRI of the body the coordinate is on, such as
   * `http://www.wikidata.org/entity/Q2` (Earth) or `…/Q405` (the Moon).
   * `null` when absent; the IRI is not validated.
   */
  readonly globe: string | null;
}

/**
 * A dimensioned quantity (`quantity`). `amount` / `upperBound` / `lowerBound`
 * are kept as their raw signed decimal strings (Wikibase does not send them
 * as JSON numbers, to preserve precision); `unit` is the unit entity IRI, or
 * the literal `"1"` for a dimensionless quantity.
 */
export interface QuantityValue {
  /** Discriminates this value in the {@link DataValue} union: Wikibase's datavalue `type`. */
  readonly _tag: "quantity";
  /**
   * The amount as Wikibase's signed decimal string (`"+1.5"`, `"-273.15"`),
   * trimmed and cut at 64 characters; parse it yourself if a JavaScript
   * number's precision is enough. A value with no usable `amount` degrades
   * to {@link UnknownValue}.
   */
  readonly amount: string;
  /**
   * The unit's entity IRI, such as `http://www.wikidata.org/entity/Q11573`
   * (metre), or `"1"` for a dimensionless count. `null` when absent; the IRI
   * is not validated.
   */
  readonly unit: string | null;
  /**
   * The upper bound of the amount's uncertainty, as a signed decimal string in
   * the same unit; `null` when the statement gives no bounds.
   */
  readonly upperBound: string | null;
  /**
   * The lower bound of the amount's uncertainty, as a signed decimal string in
   * the same unit; `null` when the statement gives no bounds.
   */
  readonly lowerBound: string | null;
}

/** A language-tagged text (`monolingualtext`). */
export interface MonolingualTextValue {
  /** Discriminates this value in the {@link DataValue} union: Wikibase's datavalue `type`. */
  readonly _tag: "monolingualtext";
  /**
   * The text, trimmed and cut at 4,000 UTF-16 code units; never empty. A
   * value with no usable `text` degrades to {@link UnknownValue}.
   */
  readonly text: string;
  /**
   * The text's language code as Wikibase sent it (`"en"`, `"pt-br"`), trimmed;
   * `null` when absent. It is not validated.
   */
  readonly language: string | null;
}

/**
 * A plain string value (`string` datavalue whose property datatype is not
 * `external-id`) — e.g. a `commonsMedia` filename, a `url`, a bare `string`.
 * The property's datatype is carried on the enclosing {@link ValueSnak}.
 */
export interface StringValue {
  /** Discriminates this value in the {@link DataValue} union: Wikibase's datavalue `type`. */
  readonly _tag: "string";
  /**
   * The string, trimmed and cut at 4,000 UTF-16 code units; never empty. A
   * `string` datavalue that is empty or not a string degrades to
   * {@link UnknownValue}.
   */
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
  /**
   * Discriminates this value in the {@link DataValue} union. It names the
   * property's datatype: the datavalue's own `type` is `string`.
   */
  readonly _tag: "external-id";
  /**
   * The identifier as the external database spells it, trimmed and cut at
   * 4,000 UTF-16 code units; never empty. It is not checked against the
   * property's format constraint.
   */
  readonly value: string;
}

/**
 * A datavalue whose `type` this module does not recognise, or whose
 * payload is unusable for a `type` it does — the lenient degrade. Carries
 * the raw `type` string (when present) and the untouched `value` payload so
 * a caller can still inspect it, but the model makes no structural promise
 * about it. A future Wikibase datatype lands here rather
 * than failing the decode.
 */
export interface UnknownValue {
  /**
   * Discriminates this value in the {@link DataValue} union; `"unknown"` is
   * this module's own tag, not a Wikibase `type`.
   */
  readonly _tag: "unknown";
  /**
   * The datavalue's raw `type` string, untrimmed (`"time"` for a time value
   * whose payload was unusable, or a type this module does not know); `null`
   * when `type` was absent or not a string.
   */
  readonly type: string | null;
  /**
   * The datavalue's `value` payload exactly as decoded from the response:
   * not trimmed, bounded or checked, and `undefined` when absent. Treat it
   * as untrusted input.
   */
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
  /** Discriminates this snak in the {@link Snak} union: Wikibase's `snaktype`. */
  readonly _tag: "value";
  /** The property the snak is about, validated and upper-cased. */
  readonly property: PropertyId;
  /**
   * The property's datatype (`"wikibase-item"`, `"external-id"`, `"time"`,
   * …), trimmed; `null` when the snak carried none. It is what splits a
   * `string` datavalue into {@link ExternalIdValue} or {@link StringValue}.
   */
  readonly datatype: string | null;
  /**
   * The asserted value; an unrecognised or unusable datavalue is an
   * {@link UnknownValue}, never absent.
   */
  readonly value: DataValue;
}

/**
 * A snak asserting the property has *some* (unspecified) value: Wikibase's
 * "unknown value", such as a date of death known to have happened but not
 * when. A snak that arrives without a `datavalue` and is not marked
 * `novalue` also becomes one, rather than an invented empty value.
 */
export interface SomeValueSnak {
  /** Discriminates this snak in the {@link Snak} union: Wikibase's `snaktype`. */
  readonly _tag: "somevalue";
  /** The property the snak is about, validated and upper-cased. */
  readonly property: PropertyId;
  /**
   * The property's datatype (`"wikibase-item"`, `"time"`, …), trimmed;
   * `null` when the snak carried none.
   */
  readonly datatype: string | null;
}

/**
 * A snak asserting the property has *no* value, such as Elizabeth I's
 * spouse (`P26`). It is a positive claim, unlike a missing statement, which
 * says nothing.
 */
export interface NoValueSnak {
  /** Discriminates this snak in the {@link Snak} union: Wikibase's `snaktype`. */
  readonly _tag: "novalue";
  /** The property the snak is about, validated and upper-cased. */
  readonly property: PropertyId;
  /**
   * The property's datatype (`"wikibase-item"`, `"time"`, …), trimmed;
   * `null` when the snak carried none.
   */
  readonly datatype: string | null;
}

/** A single snak — the property + value assertion at the heart of every statement. */
export type Snak = ValueSnak | SomeValueSnak | NoValueSnak;

/**
 * A statement's epistemic rank; `"preferred"` values win when a consumer
 * wants "the" value. Wikibase's "best" statements for a property are the
 * preferred ones, or the normal ones when none is preferred; a
 * `"deprecated"` statement is recorded but known to be wrong (an erroneous
 * or disproven claim; an outdated but once-true value stays `"normal"`).
 */
export type StatementRank = "preferred" | "normal" | "deprecated";

/** A reference block backing a statement — a set of snaks grouped by property. */
export interface Reference {
  /**
   * Wikibase's hash of the reference's snaks, which identifies it within the
   * statement (and is shared by identical references); `null` when absent.
   */
  readonly hash: string | null;
  /**
   * The reference's snaks keyed by property id (`"P248"` stated in, `"P854"`
   * reference URL, …), in Wikibase's order. Unusable snaks and invalid
   * property keys are dropped, a property with no snak left is omitted, and
   * each list keeps at most {@link MAX_LIST_ENTRIES}.
   */
  readonly snaks: Readonly<Record<string, readonly Snak[]>>;
}

/** A single claim on an item: a main snak, its rank, and its qualifiers and references. */
export interface Statement {
  /** The statement GUID (`Q42$...`), trimmed; `null` when absent. */
  readonly id: string | null;
  /** The statement's rank; a missing or unrecognised rank reads as `"normal"`. */
  readonly rank: StatementRank;
  /** The statement's main assertion: the property and its value, some value or no value. */
  readonly mainsnak: Snak;
  /**
   * Qualifier snaks (`"P580"` start time, `"P582"` end time, …), keyed by
   * property id; they refine the main snak. Normalised as
   * {@link Reference.snaks} is, so empty when the statement has none.
   */
  readonly qualifiers: Readonly<Record<string, readonly Snak[]>>;
  /**
   * The references backing the statement, in Wikibase's order and at most
   * {@link MAX_LIST_ENTRIES}; empty for an unsourced statement.
   */
  readonly references: readonly Reference[];
}

/** One sitelink — the wiki, the linked page title, and any badges. */
export interface Sitelink {
  /**
   * The wiki's global site id (`"enwiki"`, `"frwikisource"`, `"commonswiki"`),
   * trimmed; the sitelink's key in {@link WikidataItem.sitelinks} when the
   * entry carries no `site` of its own.
   */
  readonly site: string;
  /**
   * The linked page's title as Wikibase stores it, with spaces rather than
   * underscores and any namespace prefix (`"Douglas Adams"`), trimmed and
   * cut at 4,000 UTF-16 code units. A sitelink without one is dropped.
   */
  readonly title: string;
  /**
   * The badge items awarded to the page (`Q17437796` featured article,
   * `Q17437798` good article, …), in Wikibase's order and at most
   * {@link MAX_LIST_ENTRIES}; entries that are not item ids are dropped, and
   * the list is empty when there are none.
   */
  readonly badges: readonly ItemId[];
}

/** A per-language string map (labels, descriptions), keyed by language code. */
export type LanguageMap = Readonly<Record<string, string>>;

/** The fully typed Wikidata entity. */
export interface WikidataItem {
  /**
   * The entity's id, validated and upper-cased; the key it is filed under by
   * {@link getEntities}.
   */
  readonly id: EntityId;
  /**
   * The entity kind (`"item"`, `"property"`, `"lexeme"`), as Wikibase
   * reports it; `null` when absent.
   */
  readonly type: string | null;
  /**
   * The label in each language, keyed by language code (`"en"`, `"de"`).
   * From {@link getEntities}, only the requested languages are present
   * (it asks for no language fallback). Empty terms are dropped, and the
   * map is empty when labels were not fetched.
   */
  readonly labels: LanguageMap;
  /**
   * The short description in each language, keyed by language code, with
   * the same rules as {@link WikidataItem.labels}.
   */
  readonly descriptions: LanguageMap;
  /**
   * The aliases (other names) in each language, keyed by language code, in
   * Wikibase's order and at most {@link MAX_LIST_ENTRIES} per language.
   * Empty aliases are dropped, a language with none left is omitted, and it
   * is empty when aliases were not fetched.
   */
  readonly aliases: Readonly<Record<string, readonly string[]>>;
  /**
   * The pages linked to the entity on other Wikimedia wikis, keyed by
   * global site id (`"enwiki"`), in Wikibase's order and at most
   * {@link MAX_LIST_ENTRIES}. A sitelink without a title is dropped, and the
   * map is empty when sitelinks were not fetched.
   */
  readonly sitelinks: Readonly<Record<string, Sitelink>>;
  /**
   * Statements keyed by property id (`"P31"`, `"P569"`, …), in Wikibase's
   * order and at most {@link MAX_LIST_ENTRIES} per property. Invalid
   * property keys and unusable statements are dropped, but a property whose
   * statements were all dropped keeps an empty list. Empty when claims were
   * not fetched.
   */
  readonly claims: Readonly<Record<string, readonly Statement[]>>;
}

// ── Lenient wire schemas (Unknown-heavy — never fail on shape drift) ─────

/** The `{ type, value }` datavalue envelope; `value` is left `Unknown` — its shape varies by `type`. */
const RawDataValue = Schema.Struct({
  /** The datavalue kind (`"time"`, `"quantity"`, …), which picks the {@link DataValue} member. */
  type: Schema.optional(Schema.Unknown),
  /** The payload, whose shape depends on `type`; kept whole on an {@link UnknownValue}. */
  value: Schema.optional(Schema.Unknown),
});
type RawDataValue = typeof RawDataValue.Type;

const RawSnak = Schema.Struct({
  /** `"value"`, `"somevalue"` or `"novalue"`: which {@link Snak} member the snak becomes. */
  snaktype: Schema.optional(Schema.Unknown),
  /** The property id the snak is about (`"P31"`); a snak without a valid one is dropped. */
  property: Schema.optional(Schema.Unknown),
  /** The property's datatype (`"external-id"`, `"time"`, …). */
  datatype: Schema.optional(Schema.Unknown),
  /** The value of a `"value"` snak; absent on `"somevalue"` and `"novalue"` snaks. */
  datavalue: Schema.optional(RawDataValue),
});
type RawSnak = typeof RawSnak.Type;

const RawSnakList = Schema.Record(Schema.String, Schema.Array(RawSnak));

const RawReference = Schema.Struct({
  /** Wikibase's hash of the reference's snaks. */
  hash: Schema.optional(Schema.Unknown),
  /** The reference's snaks keyed by property id. */
  snaks: Schema.optional(RawSnakList),
});

const RawStatement = Schema.Struct({
  /** The statement GUID (`"Q42$…"`). */
  id: Schema.optional(Schema.Unknown),
  /** `"preferred"`, `"normal"` or `"deprecated"`; anything else reads as `"normal"`. */
  rank: Schema.optional(Schema.Unknown),
  /** The main assertion; a statement without a usable one is dropped. */
  mainsnak: Schema.optional(RawSnak),
  /** Qualifier snaks keyed by property id. */
  qualifiers: Schema.optional(RawSnakList),
  /** The references backing the statement. */
  references: Schema.optional(Schema.Array(RawReference)),
});
type RawStatement = typeof RawStatement.Type;

const RawTermValue = Schema.Struct({
  /**
   * The term's language code, which normally repeats its key in the
   * enclosing map; with language fallback it names the language the term
   * came from.
   */
  language: Schema.optional(Schema.Unknown),
  /** The term itself: a label, a description or one alias. */
  value: Schema.optional(Schema.Unknown),
});

const RawSitelink = Schema.Struct({
  /** The wiki's global site id (`"enwiki"`), which repeats its key in `sitelinks`. */
  site: Schema.optional(Schema.Unknown),
  /** The linked page's title; a sitelink without one is dropped. */
  title: Schema.optional(Schema.Unknown),
  /** The badge item ids awarded to the page. */
  badges: Schema.optional(Schema.Array(Schema.Unknown)),
});
type RawSitelink = typeof RawSitelink.Type;

const RawEntity = Schema.Struct({
  /** The entity id (`"Q42"`); an entity without a valid one is dropped. */
  id: Schema.optional(Schema.Unknown),
  /** The entity kind (`"item"`, `"property"`, `"lexeme"`). */
  type: Schema.optional(Schema.Unknown),
  /**
   * Present (as `""`) when the requested id does not exist: Wikibase answers
   * `{ id, missing: "" }`, keyed under the id. Such an entity is dropped.
   */
  missing: Schema.optional(Schema.Unknown),
  /** The labels, keyed by language code. */
  labels: Schema.optional(Schema.Record(Schema.String, RawTermValue)),
  /** The descriptions, keyed by language code. */
  descriptions: Schema.optional(Schema.Record(Schema.String, RawTermValue)),
  /** The aliases, keyed by language code. */
  aliases: Schema.optional(Schema.Record(Schema.String, Schema.Array(RawTermValue))),
  /** The sitelinks, keyed by global site id. */
  sitelinks: Schema.optional(Schema.Record(Schema.String, RawSitelink)),
  /** The statements, keyed by property id. */
  claims: Schema.optional(Schema.Record(Schema.String, Schema.Array(RawStatement))),
});
type RawEntity = typeof RawEntity.Type;

/**
 * Lenient schema for the `wbgetentities` response envelope: the decode step
 * {@link getEntities} runs before {@link normaliseEntities}. Every field is
 * optional and every leaf `Unknown`, so a partial, extended or
 * future-shaped response decodes, but a container of the wrong kind (an
 * `entities` that is not an object, a statement list that is not an array,
 * `null` where an object is expected) fails the decode, which
 * {@link getEntities} reports as a `RequestFailed`. Read the typed
 * {@link WikidataItem}s that {@link normaliseEntities} builds from it, not
 * these fields.
 */
export const WbGetEntitiesResponse = Schema.Struct({
  /**
   * The entities, keyed by id; a requested id that does not exist still has
   * an entry, flagged `missing`.
   */
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

/** Keeps the first {@link MAX_LIST_ENTRIES} badges that are valid item ids. */
function normaliseBadges(raw: readonly unknown[] | undefined): ItemId[] {
  const badges: ItemId[] = [];
  for (const badge of raw ?? []) {
    if (badges.length >= MAX_LIST_ENTRIES) break;
    const id = parseItemId(badge);
    if (id !== null) badges.push(id);
  }
  return badges;
}

/** Keeps the first {@link MAX_LIST_ENTRIES} sitelinks that carry a title. */
function normaliseSitelinks(
  raw: Readonly<Record<string, RawSitelink>> | undefined,
): Record<string, Sitelink> {
  const out: Record<string, Sitelink> = {};
  let kept = 0;
  for (const [site, link] of Object.entries(raw ?? {})) {
    if (kept >= MAX_LIST_ENTRIES) break;
    const title = sanitiseText(link.title);
    if (title === null) continue;
    out[site] = {
      site: sanitiseText(link.site) ?? site,
      title,
      badges: normaliseBadges(link.badges),
    };
    kept++;
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
 * Decodes one already-`JSON.parse`d entity object — an `wbgetentities`
 * entity, or a single line from a Wikidata JSON **dump** — into the typed
 * {@link WikidataItem} model. Returns `null` when the value is not an object,
 * carries no valid id, or Wikibase flagged it `missing`. Pure, total, and
 * lenient: a partial / malformed / future-shaped object yields `null` (or a
 * best-effort item), never a throw. This is the entry point the
 * {@link Dumps} entity-dump pipeline runs each dump line through.
 */
export function decodeEntity(raw: unknown): WikidataItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  return normaliseItem(raw as RawEntity);
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
  /** The matched entity's id (`"Q42"`); a hit without a valid one is dropped. */
  id: Schema.optional(Schema.Unknown),
  /** The entity's label in the display language. */
  label: Schema.optional(Schema.Unknown),
  /** The entity's description in the display language. */
  description: Schema.optional(Schema.Unknown),
  /** Which term the query matched. */
  match: Schema.optional(
    Schema.Struct({
      /** The kind of term matched (`"label"`, `"alias"`, …). */
      type: Schema.optional(Schema.Unknown),
      /** The matched term's language code. */
      language: Schema.optional(Schema.Unknown),
      /** The matched term's text. */
      text: Schema.optional(Schema.Unknown),
    }),
  ),
});

/**
 * Lenient schema for the `wbsearchentities` response envelope: the decode
 * step {@link searchEntities} runs before {@link normaliseSearch}. Every
 * field is optional and every leaf `Unknown`, so a partial, extended or
 * future-shaped response decodes, but a container of the wrong kind (a
 * `search` that is not an array, a `null` hit) fails the decode, which
 * {@link searchEntities} reports as a `RequestFailed`. Read the typed
 * {@link SearchHit}s that {@link normaliseSearch} builds from it, not these
 * fields.
 */
export const WbSearchResponse = Schema.Struct({
  /** The hits, in Wikibase's relevance order. */
  search: Schema.optional(Schema.Array(RawSearchHit)),
});
export type WbSearchResponse = typeof WbSearchResponse.Type;

/** One `wbsearchentities` hit — the matched entity id plus its display label / description. */
export interface SearchHit {
  /** The matched entity's id, validated and upper-cased. */
  readonly id: EntityId;
  /**
   * The entity's label in the search language, trimmed and cut at 4,000
   * UTF-16 code units; `null` when the entity has none to show.
   */
  readonly label: string | null;
  /**
   * The entity's short description in the search language, trimmed and cut
   * at 4,000 UTF-16 code units; `null` when it has none.
   */
  readonly description: string | null;
  /**
   * How the search matched, as Wikibase reports it (such as `"label"` or
   * `"alias"`); `null` when Wikibase did not say.
   */
  readonly matchType: string | null;
  /**
   * The matched text (a label or alias), which may differ from
   * {@link SearchHit.label} when an alias or another language matched;
   * `null` when Wikibase did not say.
   */
  readonly matchText: string | null;
}

/**
 * Normalises a `wbsearchentities` response, dropping hits whose id isn't a
 * valid entity id and keeping at most {@link MAX_SEARCH_RESULTS}.
 */
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
