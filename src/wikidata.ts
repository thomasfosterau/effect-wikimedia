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

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  DEFAULT_RETRY_OPTIONS,
  InvalidRequest,
  type RetryOptions,
  WikimediaClient,
} from "./core.ts";

// ── Branded entity ids (Q / P / L) ───────────────────────────────────────

/** A Wikidata **item** id — `Q` followed by digits (`Q42`). */
export const ItemId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^Q[1-9]\d{0,18}$/)),
  Schema.brand("Wikidata/ItemId"),
);
export type ItemId = typeof ItemId.Type;

/** A Wikidata **property** id — `P` followed by digits (`P31`). */
export const PropertyId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^P[1-9]\d{0,18}$/)),
  Schema.brand("Wikidata/PropertyId"),
);
export type PropertyId = typeof PropertyId.Type;

/** A Wikidata **lexeme** id — `L` followed by digits (`L1`). */
export const LexemeId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^L[1-9]\d{0,18}$/)),
  Schema.brand("Wikidata/LexemeId"),
);
export type LexemeId = typeof LexemeId.Type;

/** Any of the branded entity ids this module surfaces. */
export type EntityId = ItemId | PropertyId | LexemeId;

/**
 * Validates a Wikidata **item** id (`Q` + digits) and upper-cases it.
 * Returns the branded id, or `None` for anything else. The strict character class is the
 * injection guard: an id echoed from an untrusted response may be slotted
 * back into a request or persisted downstream, so it must be exclusively
 * `Q` plus digits — never a slash, dot, or path-escaping byte.
 */
export function parseItemId(raw: string): Option.Option<ItemId> {
  return Schema.decodeOption(ItemId)(raw.trim().toUpperCase());
}

/** Validates a Wikidata **property** id (`P` + digits); returns the branded id or `None`. */
export function parsePropertyId(raw: string): Option.Option<PropertyId> {
  return Schema.decodeOption(PropertyId)(raw.trim().toUpperCase());
}

/** Validates a Wikidata **lexeme** id (`L` + digits); returns the branded id or `None`. */
export function parseLexemeId(raw: string): Option.Option<LexemeId> {
  return Schema.decodeOption(LexemeId)(raw.trim().toUpperCase());
}

/**
 * Validates any entity id, dispatching on the leading letter. Returns the
 * appropriate branded id, or `None` for anything that is not a plain
 * `Q`/`P`/`L` id (lexeme forms / senses like `L1-F1` are intentionally out
 * of scope and degrade to `None`).
 */
export function parseEntityId(raw: string): Option.Option<EntityId> {
  const head = raw.trim().charAt(0).toUpperCase();
  if (head === "Q") return parseItemId(raw);
  if (head === "P") return parsePropertyId(raw);
  if (head === "L") return parseLexemeId(raw);
  return Option.none();
}

// ── Field bounds (defence in depth over untrusted response text) ─────────

/** Upper bound on any single free-text field copied from an untrusted response. */
const MAX_TEXT_FIELD_LENGTH = 4000;

/**
 * Cap on how many entries of each list built from a response are kept: aliases
 * per language, badges per sitelink, statements per property, references per
 * statement, and snaks per property in a qualifier or reference block.
 * Sitelinks have their own, higher cap, {@link MAX_SITELINKS}. Each list keeps
 * its first usable entries, in Wikibase's order; an entry that is dropped as
 * unusable does not count towards the cap.
 */
export const MAX_LIST_ENTRIES = 500;

/**
 * Cap on how many sitelinks an entity keeps, counted and chosen as for
 * {@link MAX_LIST_ENTRIES}. Wikibase allows one sitelink per wiki, and
 * Wikimedia has fewer linkable wikis than this, so no real item is cut; the
 * cap only bounds a hostile or malformed response.
 */
export const MAX_SITELINKS = 2000;

/** The most ids `wbgetentities` accepts per request (Wikibase's documented limit). */
export const MAX_IDS_PER_REQUEST = 50;

/** Trims and length-clamps an untrusted free-text value; `None` for anything unusable. */
function sanitiseText(value?: Schema.Json): Option.Option<string> {
  return toBoundedString(value, MAX_TEXT_FIELD_LENGTH);
}

/** A finite number passed through untouched, or `None`. */
function toFiniteNumber(value?: Schema.Json): Option.Option<number> {
  return P.isNumber(value) && Number.isFinite(value) ? Option.some(value) : Option.none();
}

/** A short raw string (calendar / globe / unit IRI, amount), trimmed and bounded, or `None`. */
function toBoundedString(value?: Schema.Json, max = 2000): Option.Option<string> {
  if (!P.isString(value)) return Option.none();
  const trimmed = value.trim();
  return Str.isEmpty(trimmed) ? Option.none() : Option.some(trimmed.slice(0, max));
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
   * …), trimmed; `None` when Wikibase sent none. It is not checked against
   * {@link WikibaseEntityIdValue.id}'s prefix.
   */
  readonly entityType: Option.Option<string>;
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
   * 10⁴ to 10⁹ years. `None` when absent or not a finite number; it is not
   * range-checked.
   */
  readonly precision: Option.Option<number>;
  /**
   * The calendar model's entity IRI, such as
   * `http://www.wikidata.org/entity/Q1985727` (proleptic Gregorian) or
   * `…/Q1985786` (proleptic Julian), saying which calendar
   * {@link TimeValue.time} is written in. `None` when absent; the IRI is not
   * validated.
   */
  readonly calendarModel: Option.Option<string>;
  /**
   * The time zone offset from UTC, in minutes. Wikibase does not use it yet
   * and normally sends `0`; `None` when absent or not a finite number.
   */
  readonly timezone: Option.Option<number>;
  /**
   * How far the true time may lie before {@link TimeValue.time}, in units
   * of {@link TimeValue.precision}. Wikibase does not use it yet and
   * normally sends `0`; `None` when absent or not a finite number.
   */
  readonly before: Option.Option<number>;
  /**
   * How far the true time may lie after {@link TimeValue.time}, in units
   * of {@link TimeValue.precision}. Wikibase does not use it yet and
   * normally sends `0`; `None` when absent or not a finite number.
   */
  readonly after: Option.Option<number>;
}

/**
 * A geographic coordinate (`globecoordinate`). `globe` is the globe entity
 * IRI (Earth = `Q2`). Every field but `_tag` may be `None`, so a `globecoordinate`
 * datavalue never degrades to {@link UnknownValue}.
 */
export interface GlobeCoordinateValue {
  /** Discriminates this value in the {@link DataValue} union: Wikibase's datavalue `type`. */
  readonly _tag: "globecoordinate";
  /** The latitude in decimal degrees, north positive; `None` when absent or not a finite number. */
  readonly latitude: Option.Option<number>;
  /** The longitude in decimal degrees, east positive; `None` when absent or not a finite number. */
  readonly longitude: Option.Option<number>;
  /**
   * The altitude, which Wikibase has never used and sends as `null`; `None`
   * then and when it is not a finite number.
   */
  readonly altitude: Option.Option<number>;
  /**
   * How precise the coordinate is, in degrees (`0.0002777…` is one
   * arcsecond). `None` when Wikibase sent none, as on some older
   * statements, or it is not a finite number.
   */
  readonly precision: Option.Option<number>;
  /**
   * The entity IRI of the body the coordinate is on, such as
   * `http://www.wikidata.org/entity/Q2` (Earth) or `…/Q405` (the Moon).
   * `None` when absent; the IRI is not validated.
   */
  readonly globe: Option.Option<string>;
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
   * (metre), or `"1"` for a dimensionless count. `None` when absent; the IRI
   * is not validated.
   */
  readonly unit: Option.Option<string>;
  /**
   * The upper bound of the amount's uncertainty, as a signed decimal string in
   * the same unit; `None` when the statement gives no bounds.
   */
  readonly upperBound: Option.Option<string>;
  /**
   * The lower bound of the amount's uncertainty, as a signed decimal string in
   * the same unit; `None` when the statement gives no bounds.
   */
  readonly lowerBound: Option.Option<string>;
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
   * `None` when absent. It is not validated.
   */
  readonly language: Option.Option<string>;
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
   * whose payload was unusable, or a type this module does not know); `None`
   * when `type` was absent or not a string.
   */
  readonly type: Option.Option<string>;
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
   * …), trimmed; `None` when the snak carried none. It is what splits a
   * `string` datavalue into {@link ExternalIdValue} or {@link StringValue}.
   */
  readonly datatype: Option.Option<string>;
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
   * `None` when the snak carried none.
   */
  readonly datatype: Option.Option<string>;
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
   * `None` when the snak carried none.
   */
  readonly datatype: Option.Option<string>;
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
   * statement (and is shared by identical references); `None` when absent.
   */
  readonly hash: Option.Option<string>;
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
  /** The statement GUID (`Q42$...`), trimmed; `None` when absent. */
  readonly id: Option.Option<string>;
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
   * reports it; `None` when absent.
   */
  readonly type: Option.Option<string>;
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
   * {@link MAX_SITELINKS}. A sitelink without a title is dropped, and the map
   * is empty when sitelinks were not fetched.
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

// ── The wire shape: parsed JSON, read defensively ─────────────────────────

/**
 * Lenient schema for the `wbgetentities` response envelope: the decode step
 * {@link getEntities} runs before {@link normaliseEntities}. Each entity is
 * kept as parsed JSON and read by the same defensive reader as a dump line
 * ({@link decodeEntity}), so a partial, extended or future-shaped entity,
 * or one with a container of the wrong kind inside it, yields a best-effort
 * item rather than a failure. Only a body or `entities` of the wrong kind
 * fails the decode, which {@link getEntities} reports as a `RequestFailed`.
 * Read the typed {@link WikidataItem}s that {@link normaliseEntities} builds
 * from it, not these fields.
 */
export const WbGetEntitiesResponse = Schema.Struct({
  /**
   * The entities, keyed by id, as parsed JSON; a requested id that does not
   * exist still has an entry, flagged `missing`.
   */
  entities: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
});
export type WbGetEntitiesResponse = typeof WbGetEntitiesResponse.Type;

// ── Normalisers: parsed JSON → honest typed model ────────────────────────

/** The fields of a value that is not a JSON object: none. */
const NO_FIELDS: Schema.JsonObject = {};

/** Whether a JSON value is an object (not an array or `null`). */
const isJsonObject = (value?: Schema.Json): value is Schema.JsonObject =>
  P.isObject(value) && !Array.isArray(value);

/** A JSON value's fields: none unless it is an object. */
function fieldsOf(value?: Schema.Json): Schema.JsonObject {
  return isJsonObject(value) ? value : NO_FIELDS;
}

/** A JSON value as a string, or `None` when it is not one. */
function stringOf(value?: Schema.Json): Option.Option<string> {
  return P.isString(value) ? Option.some(value) : Option.none();
}

/**
 * The objects in a JSON list; none when `raw` is not an array. A dump line
 * is unvalidated, so a statement list can be a number and an entry `null`
 * (#147).
 */
function objectsIn(raw?: Schema.Json): readonly Schema.JsonObject[] {
  return Array.isArray(raw) ? Arr.filter(raw, isJsonObject) : [];
}

/**
 * The own entries of a JSON object; none when `raw` is not an object (#147).
 * A `__proto__` key is dropped: assigning it to the plain object a
 * normaliser builds would replace that object's prototype rather than add an
 * entry, and no language code, site id, property id or entity id is spelled
 * so (#164).
 */
function entriesOf(raw?: Schema.Json): ReadonlyArray<readonly [string, Schema.Json]> {
  if (!isJsonObject(raw)) return [];
  return Arr.filter(R.toEntries(raw), ([key]) => key !== "__proto__");
}

/** What {@link normaliseDataValue} dispatches on: the datavalue's own `type`, plus its payload. */
interface DataValueInput {
  /**
   * The raw `type`, or `""` when it is absent or not a string: the matcher
   * compares it to literals, and `""` is no Wikibase type, so it falls through
   * to {@link UnknownValue}.
   */
  readonly type: string;
  /** The datavalue object itself, whose `value` is the payload. */
  readonly raw: Schema.JsonObject;
  /** The payload's fields, when it is an object. */
  readonly fields: Schema.JsonObject;
  readonly datatype: Option.Option<string>;
  readonly unknown: UnknownValue;
}

/**
 * The per-`type` normalisers behind {@link normaliseDataValue}, built once at
 * module load: the dump pipeline calls it for every datavalue it reads.
 */
const matchDataValue = Match.type<DataValueInput>().pipe(
  Match.when({ type: "wikibase-entityid" }, ({ fields, unknown }): DataValue => {
    const entityType = sanitiseText(fields["entity-type"]);
    return Option.match(Option.flatMap(stringOf(fields["id"]), parseEntityId), {
      onNone: () => unknown,
      onSome: (id): DataValue => ({ _tag: "wikibase-entityid", id, entityType }),
    });
  }),
  Match.when({ type: "time" }, ({ fields, unknown }): DataValue =>
    Option.match(toBoundedString(fields["time"], 64), {
      onNone: () => unknown,
      onSome: (time): DataValue => ({
        _tag: "time",
        time,
        precision: toFiniteNumber(fields["precision"]),
        calendarModel: toBoundedString(fields["calendarmodel"]),
        timezone: toFiniteNumber(fields["timezone"]),
        before: toFiniteNumber(fields["before"]),
        after: toFiniteNumber(fields["after"]),
      }),
    }),
  ),
  Match.when({ type: "globecoordinate" }, ({ fields }): DataValue => ({
    _tag: "globecoordinate",
    latitude: toFiniteNumber(fields["latitude"]),
    longitude: toFiniteNumber(fields["longitude"]),
    altitude: toFiniteNumber(fields["altitude"]),
    precision: toFiniteNumber(fields["precision"]),
    globe: toBoundedString(fields["globe"]),
  })),
  Match.when({ type: "quantity" }, ({ fields, unknown }): DataValue =>
    Option.match(toBoundedString(fields["amount"], 64), {
      onNone: () => unknown,
      onSome: (amount): DataValue => ({
        _tag: "quantity",
        amount,
        unit: toBoundedString(fields["unit"]),
        upperBound: toBoundedString(fields["upperBound"], 64),
        lowerBound: toBoundedString(fields["lowerBound"], 64),
      }),
    }),
  ),
  Match.when({ type: "monolingualtext" }, ({ fields, unknown }): DataValue =>
    Option.match(sanitiseText(fields["text"]), {
      onNone: () => unknown,
      onSome: (text): DataValue => ({
        _tag: "monolingualtext",
        text,
        language: sanitiseText(fields["language"]),
      }),
    }),
  ),
  Match.when({ type: "string" }, ({ raw, datatype, unknown }): DataValue =>
    Option.match(sanitiseText(raw["value"]), {
      onNone: () => unknown,
      onSome: (str): DataValue =>
        Option.contains(datatype, "external-id")
          ? { _tag: "external-id", value: str }
          : { _tag: "string", value: str },
    }),
  ),
  Match.orElse(({ unknown }): DataValue => unknown),
);

/**
 * Normalises a parsed `{ type, value }` datavalue into the typed
 * {@link DataValue} union. `datatype` (the *property's* datatype, from the
 * enclosing snak) is only consulted to split a `string` datavalue into
 * {@link ExternalIdValue} vs {@link StringValue}. Any `type` this function
 * doesn't recognise — or a recognised `type` whose payload is unusable —
 * degrades to {@link UnknownValue}; this function always returns a value and
 * never throws.
 */
export function normaliseDataValue(
  raw: Schema.JsonObject,
  datatype: Option.Option<string>,
): DataValue {
  const type = stringOf(raw["type"]);
  const value = raw["value"];
  return matchDataValue({
    type: Option.getOrElse(type, () => ""),
    raw,
    fields: fieldsOf(value),
    datatype,
    unknown: { _tag: "unknown", type, value },
  });
}

/** Normalises one parsed snak into the typed {@link Snak}; `None` when it carries no valid property. */
export function normaliseSnak(raw: Schema.JsonObject): Option.Option<Snak> {
  return Option.map(
    Option.flatMap(stringOf(raw["property"]), parsePropertyId),
    (property): Snak => {
      const datatype = sanitiseText(raw["datatype"]);
      const snaktype = raw["snaktype"];
      if (snaktype === "novalue") return { _tag: "novalue", property, datatype };
      if (snaktype === "somevalue") return { _tag: "somevalue", property, datatype };
      // Otherwise it is a value snak. Wikibase always sends snaktype "value"
      // explicitly, but if a datavalue is somehow absent (or, in an unvalidated
      // dump line, not an object) we fall back to "somevalue" rather than
      // inventing an empty value.
      const datavalue = raw["datavalue"];
      if (!isJsonObject(datavalue)) return { _tag: "somevalue", property, datatype };
      const value = normaliseDataValue(datavalue, datatype);
      return { _tag: "value", property, datatype, value };
    },
  );
}

/**
 * Keeps, in order, the first `max` items that `f` maps to a `Some`, unwrapped.
 * `f` is not called once `max` are kept, so a hostile list costs one
 * comparison per surplus entry.
 */
function keepUsable<A, B>(items: Iterable<A>, max: number, f: (item: A) => Option.Option<B>): B[] {
  return Arr.reduce(items, Arr.empty<B>(), (kept, item) => {
    if (kept.length < max) {
      const usable = f(item);
      if (Option.isSome(usable)) kept.push(usable.value);
    }
    return kept;
  });
}

/**
 * Builds a record from the entries of `raw` (see `entriesOf`: none unless it
 * is an object, and never a `__proto__` key) that `f` maps to a `Some`
 * `[key, value]`, keeping at most `max` of them, in order; `f` is not called
 * once `max` are kept. The record is built with `R.fromEntries`, so every
 * key is an own property.
 */
function keepUsableEntries<B>(
  max: number,
  f: (key: string, value: Schema.Json) => Option.Option<readonly [string, B]>,
  raw?: Schema.Json,
) {
  const kept: (readonly [string, B])[] = [];
  Arr.forEach(entriesOf(raw), ([key, value]) => {
    if (kept.length >= max) return;
    const entry = f(key, value);
    if (Option.isSome(entry)) kept.push(entry.value);
  });
  return R.fromEntries(kept);
}

/** Normalises a `{ property: snak[] }` block (qualifiers / reference snaks), dropping unusable snaks. */
function normaliseSnakList(raw?: Schema.Json): Record<string, readonly Snak[]> {
  return keepUsableEntries(
    Number.POSITIVE_INFINITY,
    (property, snaks) =>
      Option.flatMap(parsePropertyId(property), (validProperty) => {
        const list = keepUsable(objectsIn(snaks), MAX_LIST_ENTRIES, normaliseSnak);
        return Arr.isReadonlyArrayNonEmpty(list)
          ? Option.some([validProperty, list] as const)
          : Option.none();
      }),
    raw,
  );
}

function normaliseRank(raw?: Schema.Json): StatementRank {
  return raw === "preferred" || raw === "deprecated" ? raw : "normal";
}

/** Normalises one parsed statement; `None` when its main snak carries no valid property. */
export function normaliseStatement(raw: Schema.JsonObject): Option.Option<Statement> {
  const mainsnak = raw["mainsnak"];
  if (!isJsonObject(mainsnak)) return Option.none();
  return Option.map(normaliseSnak(mainsnak), (snak): Statement => ({
    id: sanitiseText(raw["id"]),
    rank: normaliseRank(raw["rank"]),
    mainsnak: snak,
    qualifiers: normaliseSnakList(raw["qualifiers"]),
    references: keepUsable(objectsIn(raw["references"]), MAX_LIST_ENTRIES, (reference) =>
      Option.some<Reference>({
        hash: sanitiseText(reference["hash"]),
        snaks: normaliseSnakList(reference["snaks"]),
      }),
    ),
  }));
}

/** Normalises a `{ lang: { value } }` term map into a flat `lang → value` map. */
function normaliseTermMap(raw?: Schema.Json): LanguageMap {
  return keepUsableEntries(
    Number.POSITIVE_INFINITY,
    (language, term) =>
      Option.map(sanitiseText(fieldsOf(term)["value"]), (value) => [language, value] as const),
    raw,
  );
}

function normaliseAliases(raw?: Schema.Json): Record<string, readonly string[]> {
  return keepUsableEntries(
    Number.POSITIVE_INFINITY,
    (language, terms) => {
      const values = keepUsable(objectsIn(terms), MAX_LIST_ENTRIES, (term) =>
        sanitiseText(term["value"]),
      );
      return Arr.isReadonlyArrayNonEmpty(values)
        ? Option.some([language, values] as const)
        : Option.none();
    },
    raw,
  );
}

/** Keeps the first {@link MAX_LIST_ENTRIES} badges that are valid item ids. */
function normaliseBadges(raw?: Schema.Json): ItemId[] {
  return keepUsable(Array.isArray(raw) ? raw : [], MAX_LIST_ENTRIES, (badge: Schema.Json) =>
    Option.flatMap(stringOf(badge), parseItemId),
  );
}

/** Keeps the first {@link MAX_SITELINKS} sitelinks that carry a title. */
function normaliseSitelinks(raw?: Schema.Json): Record<string, Sitelink> {
  return keepUsableEntries(
    MAX_SITELINKS,
    (site, link) => {
      const fields = fieldsOf(link);
      return Option.map(sanitiseText(fields["title"]), (title) => {
        const sitelink: Sitelink = {
          site: Option.getOrElse(sanitiseText(fields["site"]), () => site),
          title,
          badges: normaliseBadges(fields["badges"]),
        };
        return [site, sitelink] as const;
      });
    },
    raw,
  );
}

/**
 * Normalises one parsed entity object into a typed {@link WikidataItem};
 * `None` when the entity carries no valid id or Wikibase flagged it
 * `missing` (the item does not exist upstream).
 */
export function normaliseItem(raw: Schema.JsonObject): Option.Option<WikidataItem> {
  if (raw["missing"] !== undefined) return Option.none();
  return Option.map(Option.flatMap(stringOf(raw["id"]), parseEntityId), (id): WikidataItem => ({
    id,
    type: sanitiseText(raw["type"]),
    labels: normaliseTermMap(raw["labels"]),
    descriptions: normaliseTermMap(raw["descriptions"]),
    aliases: normaliseAliases(raw["aliases"]),
    sitelinks: normaliseSitelinks(raw["sitelinks"]),
    claims: normaliseClaims(raw["claims"]),
  }));
}

/** Normalises the `{ property: statement[] }` claims map, dropping invalid property keys. */
function normaliseClaims(raw?: Schema.Json): Record<string, readonly Statement[]> {
  return keepUsableEntries(
    Number.POSITIVE_INFINITY,
    (property, statements) =>
      Option.map(
        parsePropertyId(property),
        (validProperty) =>
          [
            validProperty,
            keepUsable(objectsIn(statements), MAX_LIST_ENTRIES, normaliseStatement),
          ] as const,
      ),
    raw,
  );
}

/**
 * Decodes one parsed JSON entity — a `wbgetentities` entity, or a single
 * line from a Wikidata JSON **dump** — into the typed {@link WikidataItem}
 * model. Returns `None` when the value is not a JSON object, carries no
 * valid id, or Wikibase flagged it `missing`. Pure, total, and lenient: it
 * never throws on any JSON value. A partial or future-shaped object yields a
 * best-effort item, and so does one whose nested containers are the wrong
 * kind: a map or list that is not an object or array reads as empty, a
 * statement, snak, reference, term or sitelink that is not an object is
 * dropped, and a `datavalue` that is not an object makes its snak
 * `somevalue`. A `__proto__` key in any keyed map is dropped. This is the
 * entry point the {@link Dumps} entity-dump pipeline runs each dump line
 * through; it reads the parsed JSON by hand rather than through a schema,
 * which would roughly double the per-line cost of a dump (#224).
 */
export function decodeEntity(raw: Schema.Json): Option.Option<WikidataItem> {
  return isJsonObject(raw) ? normaliseItem(raw) : Option.none();
}

/**
 * Normalises a whole `wbgetentities` response into typed items keyed by
 * their id. Entities Wikibase flagged `missing`, or that carry no valid id,
 * are omitted — a caller reads "present" as "key exists". Pure and total: a
 * hostile or unexpected payload yields fewer items or fewer entries in an
 * item, never a throw; each entity is normalised as {@link decodeEntity}
 * does, `__proto__` keys dropped included.
 */
export function normaliseEntities(response: WbGetEntitiesResponse): Record<string, WikidataItem> {
  return keepUsableEntries(
    Number.POSITIVE_INFINITY,
    (_, raw) => Option.map(decodeEntity(raw), (item) => [item.id, item] as const),
    response.entities,
  );
}

// ── wbgetentities (batched, 50-id chunking) ──────────────────────────────

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
  const validated = yield* Effect.forEach(
    ids,
    (id) =>
      Effect.fromOption(parseEntityId(id)).pipe(
        Effect.mapError(() => new InvalidRequest({ kind: "entityId", value: id })),
      ),
    { concurrency: 1 },
  );
  const client = yield* WikimediaClient;
  const props = (options?.props ?? DEFAULT_PROPS).join("|");
  const languages =
    options?.languages !== undefined && Arr.isReadonlyArrayNonEmpty(options.languages)
      ? { languages: options.languages.join("|") }
      : undefined;
  const responses = yield* Effect.forEach(
    Arr.chunksOf(validated, MAX_IDS_PER_REQUEST),
    (group) =>
      client.getJson(
        {
          host,
          path: "/w/api.php",
          params: {
            action: "wbgetentities",
            ids: group.join("|"),
            props,
            format: "json",
            ...languages,
          },
        },
        WbGetEntitiesResponse,
        retry ?? DEFAULT_RETRY_OPTIONS,
      ),
    { concurrency: 1 },
  );
  return Arr.reduce(responses, R.empty<string, WikidataItem>(), (merged, response) =>
    Object.assign(merged, normaliseEntities(response)),
  );
});

// ── wbsearchentities (label search) ──────────────────────────────────────

/** Cap on how many search results a single call returns. */
export const MAX_SEARCH_RESULTS = 50;

const RawSearchHit = Schema.Struct({
  /** The matched entity's id (`"Q42"`); a hit without a valid one is dropped. */
  id: Schema.optional(Schema.Json),
  /** The entity's label in the display language. */
  label: Schema.optional(Schema.Json),
  /** The entity's description in the display language. */
  description: Schema.optional(Schema.Json),
  /** Which term the query matched. */
  match: Schema.optional(
    Schema.Struct({
      /** The kind of term matched (`"label"`, `"alias"`, …). */
      type: Schema.optional(Schema.Json),
      /** The matched term's language code. */
      language: Schema.optional(Schema.Json),
      /** The matched term's text. */
      text: Schema.optional(Schema.Json),
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
   * UTF-16 code units; `None` when the entity has none to show.
   */
  readonly label: Option.Option<string>;
  /**
   * The entity's short description in the search language, trimmed and cut
   * at 4,000 UTF-16 code units; `None` when it has none.
   */
  readonly description: Option.Option<string>;
  /**
   * How the search matched, as Wikibase reports it (such as `"label"` or
   * `"alias"`); `None` when Wikibase did not say.
   */
  readonly matchType: Option.Option<string>;
  /**
   * The matched text (a label or alias), which may differ from
   * {@link SearchHit.label} when an alias or another language matched;
   * `None` when Wikibase did not say.
   */
  readonly matchText: Option.Option<string>;
}

/**
 * Normalises a `wbsearchentities` response, dropping hits whose id isn't a
 * valid entity id and keeping at most {@link MAX_SEARCH_RESULTS}.
 */
export function normaliseSearch(response: WbSearchResponse): readonly SearchHit[] {
  return keepUsable(response.search ?? [], MAX_SEARCH_RESULTS, (hit) =>
    Option.map(Option.flatMap(stringOf(hit.id), parseEntityId), (id): SearchHit => ({
      id,
      label: sanitiseText(hit.label),
      description: sanitiseText(hit.description),
      matchType: sanitiseText(hit.match?.type),
      matchText: sanitiseText(hit.match?.text),
    })),
  );
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
  const cleaned = sanitiseText(query);
  if (Option.isNone(cleaned)) return yield* new InvalidRequest({ kind: "query", value: query });
  const cleanedQuery = cleaned.value;
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
