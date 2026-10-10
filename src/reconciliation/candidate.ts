/**
 * The candidate and fact shapes, field bounds, input validators and curated
 * property allowlists of the reconciliation namespace. Pure: no network.
 *
 * A {@link WikidataCandidate} is the provider-neutral match the lookup
 * service (`./lookup.ts`) normalises the `Wikidata` / `Action` results into
 * (`./normalise.ts`), for a reviewer to disambiguate; a {@link WikidataFacts}
 * is what Enrich returns for a confirmed QID. Nothing here persists anything:
 * storing a chosen QID or the facts is the caller's job.
 *
 * @copyright Thomas Foster
 * @module reconciliation/candidate
 */

import * as Schema from "effect/Schema";
import { normaliseTitle } from "../core.ts";

/**
 * A provider-neutral Wikidata candidate match. Every string field is
 * already trimmed and length-bounded by the normalisers, so consumers
 * treat these as trusted application values, not raw upstream output.
 */
export interface WikidataCandidate {
  /** The Wikidata item id (`Q<digits>`), validated and safe to persist. */
  readonly qid: string;
  /** English display label, if the item carries one. */
  readonly label: string | null;
  /** Short English description, used for disambiguation, if present. */
  readonly description: string | null;
  /**
   * `instance of` (P31) target QIDs, where cheaply available — these help
   * a reviewer tell a person from a film from a concept.
   * Empty when the lookup path didn't fetch claims (label search doesn't).
   */
  readonly instanceOf: readonly string[];
}

// ── Field bounds ──────────────────────────────────────────────────────

/**
 * Upper bound, in UTF-16 code units, on a candidate's label or description
 * as `WikidataLookup` returns it: 2000. It is deliberately tighter than
 * `Core.MAX_TEXT_FIELD_LENGTH` (4000), which bounds the `Action` and `Rest`
 * clients (`Wikidata` applies its own 4000 bound). The clamp keeps a hostile
 * or malformed response from pushing an unbounded blob through the service
 * (defence in depth).
 */
export const MAX_CANDIDATE_TEXT_LENGTH = 2000;

/** Cap on how many candidates a single search returns. */
export const MAX_CANDIDATES = 20;

/** Cap on how many `instance of` targets we keep per candidate. */
export const MAX_INSTANCE_OF = 10;

/**
 * Upper bound on a search-label query. Wikidata's `wbsearchentities`
 * ignores anything beyond a sane length; we clamp first so an unbounded
 * caller value never reaches the query string.
 */
export const MAX_LABEL_QUERY_LENGTH = 300;

/**
 * Cleans an untrusted free-text value for a reconciliation candidate: trims
 * it, collapses each internal whitespace run to one space, and clamps it to
 * {@link MAX_CANDIDATE_TEXT_LENGTH} (2000) code units. Returns `null` for a
 * non-string or an empty / whitespace-only string, so callers can map
 * "nothing usable" to an absent field rather than an empty string.
 *
 * Differs from `Core.sanitiseText`, which only trims, keeps internal
 * whitespace and clamps to `Core.MAX_TEXT_FIELD_LENGTH` (4000).
 */
export function sanitiseCandidateText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.slice(0, MAX_CANDIDATE_TEXT_LENGTH);
}

// ── Input validation (SSRF / injection defence) ───────────────────────

/**
 * Normalises an untrusted label-search string into a value safe to place
 * in the Wikidata query string, or `null` if there is nothing to search.
 *
 * The query is sent as a URL **query parameter** (not a path segment) and
 * is percent-encoded by `URLSearchParams` before transmission, so this is
 * primarily about rejecting useless input early and bounding length — but
 * we still trim, collapse whitespace, and clamp so a megabyte of caller
 * text never reaches the request builder.
 */
export function normaliseLabelQuery(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.slice(0, MAX_LABEL_QUERY_LENGTH);
}

/**
 * Validates a Wikidata item id (`Q` followed by digits) and upper-cases
 * the leading letter. Returns `null` for anything else.
 *
 * The strict character class is the SSRF / injection guard: a QID echoed
 * back by an upstream response, or supplied by a caller, may be slotted
 * into a request and is persisted downstream, so it must be exclusively
 * `Q` plus digits — never a slash, dot, or anything that could escape its
 * intended position.
 */
export function normaliseQid(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().toUpperCase();
  if (/^Q[1-9]\d{0,18}$/.test(cleaned)) return cleaned;
  return null;
}

/**
 * Validates a Wikidata property id (`P` followed by digits). Used to key
 * an identifier lookup (e.g. `P214` = VIAF, `P244` = LCCN). Returns
 * `null` for anything else.
 *
 * Like {@link normaliseQid}, the strict class is the injection guard: the
 * property id is interpolated into the `haswbstatement:` search clause, so
 * it must be exclusively `P` plus digits.
 */
export function normalisePropertyId(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().toUpperCase();
  if (/^P[1-9]\d{0,18}$/.test(cleaned)) return cleaned;
  return null;
}

/**
 * Validates an external-identifier **value** for use in a
 * `haswbstatement:P<prop>=<value>` search clause.
 *
 * External identifier values (VIAF numbers, ISNIs, ORCIDs, …) are short
 * tokens. We accept a conservative character class — letters, digits, and
 * a handful of separators that appear in real identifiers (`-`, `.`, `:`,
 * `/`, `_`, space) — and reject control characters, the `|` that would
 * inject an extra search term, and anything over a sane length. The value
 * is percent-encoded by `URLSearchParams` before transmission; this is
 * the belt to that braces, refusing a hostile value before the request is
 * even built.
 */
export function normaliseExternalIdValue(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return null;
  // Reject ASCII control characters defensively. A codepoint check (not a
  // literal-control-char regex) keeps this source file free of control
  // bytes.
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  // `haswbstatement` uses `|` to OR terms; refuse it so a value can never
  // smuggle a second statement clause into the search.
  if (!/^[A-Za-z0-9 ._:/-]+$/.test(trimmed)) return null;
  return trimmed;
}

// ── Enrich: the fact union + extraction helpers (website#613) ──────────

/**
 * The confirmed item itself (`_tag: "Item"`): the canonical Wikidata
 * correspondence for the QID that was enriched. `enrich` always returns
 * exactly one, first.
 */
export const ItemFact = Schema.TaggedStruct("Item", {
  /** The confirmed item id (`Q<digits>`), validated by {@link normaliseQid}. */
  qid: Schema.String,
  /** The item's entity IRI, `http://www.wikidata.org/entity/<qid>` ({@link wikidataEntityIri}). */
  iri: Schema.String,
});

/** The confirmed item itself; see {@link ItemFact}. */
export type ItemFact = typeof ItemFact.Type;

/**
 * An external identifier the item carries (`_tag: "Identifier"`), a
 * `sameAs` link to one of the curated {@link EXTERNAL_ID_AUTHORITIES}.
 * `{ property, value }` is an `ExternalIdentifier`-shaped pair, so it
 * can be passed back to `WikidataLookup.searchByIdentifier`.
 */
export const IdentifierFact = Schema.TaggedStruct("Identifier", {
  /** The Wikidata external-identifier property, e.g. `"P214"` (VIAF). */
  property: Schema.String,
  /** The authority's local name from {@link EXTERNAL_ID_AUTHORITIES}, e.g. `"viaf"`. */
  authority: Schema.String,
  /** The identifier as the claim spells it (an ISNI may keep Wikidata's spaces). */
  value: Schema.String,
  /** The authority's IRI for the identifier, built from a fixed template, e.g. `https://viaf.org/viaf/113230702`. */
  iri: Schema.String,
});

/** An external identifier the item carries; see {@link IdentifierFact}. */
export type IdentifierFact = typeof IdentifierFact.Type;

/**
 * A calendar date claim on the item (`_tag: "Date"`), for one of the
 * {@link DATE_PROPERTIES}.
 */
export const DateFact = Schema.TaggedStruct("Date", {
  /** The Wikidata date property, e.g. `"P569"`. */
  property: Schema.String,
  /** The property's English label from {@link DATE_PROPERTIES}, e.g. `"date of birth"`. */
  label: Schema.String,
  /**
   * The Wikibase timestamp without its leading `+`, e.g.
   * `"1952-03-11T00:00:00Z"` (see {@link normaliseTimeValue}). Read it with
   * `precision`: a year-precision date is stored as `"1952-00-00T00:00:00Z"`.
   * Read it with `calendar` too: a Julian `time` is not the Gregorian day
   * with the same digits.
   */
  time: Schema.String,
  /**
   * Wikibase's precision code, an integer from 0 (billion years) to 14
   * (second): 9 is a year, 10 a month, 11 a day. `null` when the claim
   * carries none or it is out of range.
   */
  precision: Schema.NullOr(Schema.Int),
  /**
   * The calendar `time` is written in, from the claim's Wikibase calendar
   * model: `"gregorian"` for proleptic Gregorian (`Q1985727`), `"julian"` for
   * proleptic Julian (`Q1985786`). Julian dates are common before 1582, and
   * their `time` is not a Gregorian date. `null` when the claim names no
   * calendar model or one that is neither of these, so read `time` as of
   * unknown calendar.
   */
  calendar: Schema.NullOr(Schema.Literals(["gregorian", "julian"])),
});

/** A calendar date claim on the item; see {@link DateFact}. */
export type DateFact = typeof DateFact.Type;

/**
 * A Commons image claim on the item (`_tag: "Image"`), for one of the
 * {@link IMAGE_PROPERTIES}.
 */
export const ImageFact = Schema.TaggedStruct("Image", {
  /** The Wikidata image property, e.g. `"P18"`. */
  property: Schema.String,
  /**
   * The Commons filename as the claim spells it. Wikibase `commonsMedia`
   * values carry no `File:` prefix; {@link normaliseCommonsImage} doesn't strip one.
   */
  filename: Schema.String,
  /** The file's `Special:FilePath` URL on Commons (see {@link normaliseCommonsImage}). */
  iri: Schema.String,
});

/** A Commons image claim on the item; see {@link ImageFact}. */
export type ImageFact = typeof ImageFact.Type;

/**
 * A single fact pulled from a confirmed Wikidata item, as a union tagged by
 * fact kind: {@link ItemFact} (`"Item"`), {@link IdentifierFact}
 * (`"Identifier"`), {@link DateFact} (`"Date"`) or {@link ImageFact}
 * (`"Image"`). Branch on `_tag`, or use the schema's `match`, `guards` and
 * `isAnyOf`, e.g. `WikidataFact.match(fact, { Item: …, Identifier: …, Date: …, Image: … })`.
 * Every string in a fact `enrich` returns is already validated and clamped,
 * so consumers treat them as trusted application values; decoding through
 * the schema checks only the shape. How a fact is stored is the caller's
 * choice.
 */
export const WikidataFact = Schema.Union([ItemFact, IdentifierFact, DateFact, ImageFact]).pipe(
  Schema.toTaggedUnion("_tag"),
);

/** A single fact pulled from a confirmed Wikidata item; see {@link WikidataFact}. */
export type WikidataFact = typeof WikidataFact.Type;

/** The selected facts `WikidataLookup.enrich` extracts from a confirmed Wikidata item. */
export interface WikidataFacts {
  /** The confirmed item id the facts were pulled for. */
  readonly qid: string;
  /** The facts, in order: the {@link ItemFact}, then {@link IdentifierFact}s, {@link DateFact}s and {@link ImageFact}s. */
  readonly facts: readonly WikidataFact[];
}

/** Cap on how many {@link IdentifierFact}s we extract per item. */
export const MAX_SAME_AS = 30;

/** Cap on how many {@link DateFact}s we extract per item. */
export const MAX_DATES = 10;

/** Cap on how many {@link ImageFact}s we extract per item. */
export const MAX_IMAGES = 5;

/** The `http://www.wikidata.org/entity/<id>` IRI for a validated Q/P id. */
export function wikidataEntityIri(id: string): string {
  return `http://www.wikidata.org/entity/${id}`;
}

/**
 * One curated external-identifier authority: its local name and the
 * builder that turns a Wikidata claim value into the authority's IRI.
 */
export interface ExternalIdAuthority {
  /** Local authority name, reported as {@link IdentifierFact}'s `authority`, e.g. `"viaf"`. */
  readonly authority: string;
  /**
   * Builds the authority's IRI for an identifier value, or returns `null`
   * when the value doesn't match the authority's identifier format. The
   * value is percent-encoded into a single path segment of a fixed host,
   * so the result never points outside that authority's identifier path.
   */
  readonly iri: (value: string) => string | null;
}

/**
 * Builds an {@link ExternalIdAuthority} whose `iri` checks `format` (an
 * anchored pattern for the whole value) before it percent-encodes the
 * value, after `canonical` has rewritten it, into `template`.
 */
const externalIdAuthority = (
  authority: string,
  format: RegExp,
  template: (encoded: string) => string,
  canonical: (value: string) => string = (value) => value,
): ExternalIdAuthority => ({
  authority,
  iri: (value) =>
    typeof value === "string" && format.test(value)
      ? template(encodeURIComponent(canonical(value)))
      : null,
});

/**
 * Curated allowlist of Wikidata external-identifier properties we lift as
 * `sameAs` links — property id → the local authority name and the IRI
 * builder that turns an identifier value into a resolvable URL.
 *
 * Deliberately a closed set: only well-known authorities over known hosts,
 * so an enriched `sameAs` IRI is always a fixed template plus one
 * percent-encoded path segment — never an arbitrary host or path from the
 * untrusted response. Each `iri` returns `null` for a value outside the
 * authority's identifier format, which also refuses `.`, `..` and `/`.
 * Each format is anchored at both ends and is at least as permissive as
 * the property's Wikidata "format as a regular expression" (P1793)
 * constraint: VIAF and BnF follow it, ISNI, ORCID and GND accept a wider
 * set of shapes, and P244 (LCCN) uses the Library of Congress's normalised
 * LCCN form (https://www.loc.gov/marc/lccn-namespace.html) — an 8- or
 * 10-digit year and serial number after a prefix of up to 3 letters — with
 * this package's own requirement that the prefix have at least one letter,
 * since a name-authority LCCN always does. Every value a format accepts is
 * digits, ASCII letters and `-` (ISNI's spaces are removed first), so the
 * percent-encoding is defence in depth that changes no accepted value.
 * No template needs a `/` inside the value. P213 (ISNI) accepts
 * Wikidata's spaced form (`0000 0001 2103 2683`) and the compact form; its
 * IRI always uses the compact form.
 */
export const EXTERNAL_ID_AUTHORITIES: Readonly<Record<string, ExternalIdAuthority>> = {
  P214: externalIdAuthority(
    "viaf",
    /^[1-9]\d(?:\d{0,7}|\d{17,20})$/,
    (v) => `https://viaf.org/viaf/${v}`,
  ),
  P213: externalIdAuthority(
    "isni",
    /^0000(?: \d{4} \d{4} \d{3}|\d{11})[\dX]$/,
    (v) => `https://isni.org/isni/${v}`,
    (v) => v.replaceAll(" ", ""),
  ),
  P496: externalIdAuthority(
    "orcid",
    /^0000-000[1-9]-\d{4}-\d{3}[\dX]$/,
    (v) => `https://orcid.org/${v}`,
  ),
  P244: externalIdAuthority(
    "lccn",
    /^[a-z]{1,3}(?:\d{8}|\d{10})$/,
    (v) => `https://id.loc.gov/authorities/names/${v}`,
  ),
  P227: externalIdAuthority(
    "gnd",
    /^(?:1[012]?\d{7}[\dX]|[47]\d{6}-\d|[1-9]\d{0,7}-[\dX]|3\d{7}[\dX])$/,
    (v) => `https://d-nb.info/gnd/${v}`,
  ),
  P268: externalIdAuthority(
    "bnf",
    /^\d{8}[\dbcdfghjkmnpqrstvwxz]$/,
    (v) => `https://catalogue.bnf.fr/ark:/12148/cb${v}`,
  ),
};

/**
 * Wikidata properties whose value is a calendar date we lift as a
 * {@link DateFact}, mapped to the English label reported as its `label`.
 */
export const DATE_PROPERTIES: Readonly<Record<string, string>> = {
  P569: "date of birth",
  P570: "date of death",
  P571: "inception",
  P576: "dissolved, abolished or demolished date",
};

/** Wikidata image properties (Commons media) we lift as an {@link ImageFact}. */
export const IMAGE_PROPERTIES: readonly string[] = ["P18"];

/**
 * Validates and trims a Wikidata time value's `time` string (e.g.
 * `"+1879-03-14T00:00:00Z"`). Returns the value with the leading `+`
 * dropped, or `null` for anything that isn't a Wikidata-shaped timestamp.
 * The strict pattern is the guard: a stored date is surfaced downstream,
 * so it must be exclusively a sign, digits, and the fixed separators.
 */
export function normaliseTimeValue(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  // Wikidata times are `±YYYYYYYYYYY-MM-DDThh:mm:ssZ` (year up to 16 digits).
  if (!/^[+-]\d{1,16}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(trimmed)) return null;
  return trimmed.replace(/^\+/, "");
}

/**
 * Validates a Commons media filename (the value of a P18 image claim) and
 * builds its stable `Special:FilePath` URL. Rejects control characters, the
 * `|`/`#`/`?` that could break out of the path segment, and MediaWiki's
 * relative-path titles (`.`, `..`, a leading `./` or `../`, a `/./` or
 * `/../` anywhere, a trailing `/.` or `/..`), which `new URL` would resolve
 * into a different path; the filename is percent-encoded into the fixed
 * Commons host. Returns `null` for unusable input, as `Commons.filePathUrl`
 * does. The returned `filename` is the trimmed claim as spelled (the
 * {@link ImageFact} `filename`) and `iri` is its `Special:FilePath` URL;
 * both are trusted.
 */
export function normaliseCommonsImage(
  raw: unknown,
): { readonly filename: string; readonly iri: string } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return null;
  // Checked on the raw string: `normaliseTitle` collapses whitespace
  // (tab, newline, CR, ...) to `_` before its own control-character check,
  // so it can't be relied on to reject them here.
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  if (/[|#?]/.test(trimmed)) return null;
  // `normaliseTitle` adds the relative-path forms; its whitespace-collapsed
  // result is discarded so `filename` keeps the claim's own spelling.
  if (normaliseTitle(trimmed) === null) return null;
  const iri = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(trimmed)}`;
  return { filename: trimmed, iri };
}
