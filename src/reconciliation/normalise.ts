/**
 * Maps typed `Wikidata` / `Action` results onto {@link WikidataCandidate}s and
 * {@link WikidataFacts}, re-validating every field against the bounds and
 * allowlists in `./candidate.ts`. Pure: no network.
 *
 * The `Wikidata` module already types the wire; this module decides which
 * fields become a {@link WikidataCandidate} and which claims become a
 * {@link WikidataFact}. Field bounds, the curated `EXTERNAL_ID_AUTHORITIES`
 * allowlist and the injection-guard character classes are applied here,
 * because a typed value is not yet a trusted one.
 *
 * @copyright Thomas Foster
 * @module reconciliation/normalise
 */

import type * as Action from "../action.ts";
import type * as Wikidata from "../wikidata.ts";
import {
  DATE_PROPERTIES,
  EXTERNAL_ID_AUTHORITIES,
  IMAGE_PROPERTIES,
  MAX_CANDIDATES,
  MAX_DATES,
  MAX_IMAGES,
  MAX_INSTANCE_OF,
  MAX_SAME_AS,
  normaliseCommonsImage,
  normaliseExternalIdValue,
  normaliseQid,
  normaliseTimeValue,
  sanitiseCandidateText,
  type DateFact,
  type IdentifierFact,
  type ImageFact,
  type WikidataCandidate,
  type WikidataFact,
  type WikidataFacts,
  wikidataEntityIri,
} from "./candidate.ts";

// ── wbsearchentities (label search) ───────────────────────────────────

/**
 * Maps one typed `wbsearchentities` hit to a neutral candidate. Empty when
 * the hit's id is not a well-formed QID (a defensive re-validation of the
 * general package's already-typed `EntityId` — this layer's candidates are
 * always item ids). Label search does not fetch claims, so `instanceOf` is
 * always empty.
 */
export function hitToCandidate(hit: Wikidata.SearchHit): readonly WikidataCandidate[] {
  const qid = normaliseQid(hit.id);
  if (qid === null) return [];
  return [
    {
      qid,
      label: sanitiseCandidateText(hit.label),
      description: sanitiseCandidateText(hit.description),
      instanceOf: [],
    },
  ];
}

// ── list=search (identifier search) ────────────────────────────────────

/**
 * Extracts the matched QIDs from a `haswbstatement` search (run through
 * `Action.search` — for a main-namespace Wikidata item, the page title
 * *is* the QID). Non-QID titles are dropped; the result is de-duplicated
 * and capped at {@link MAX_CANDIDATES}.
 */
export function dedupedQids(hits: readonly Action.SearchResult[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of hits) {
    if (out.length >= MAX_CANDIDATES) break;
    const qid = normaliseQid(hit.title);
    if (qid === null || seen.has(qid)) continue;
    seen.add(qid);
    out.push(qid);
  }
  return out;
}

/** The validated `wikibase-entityid` targets of a P31 (`instance of`) statement list, capped. */
function instanceOfQids(item: Wikidata.WikidataItem): readonly string[] {
  const out: string[] = [];
  for (const statement of item.claims.P31 ?? []) {
    if (out.length >= MAX_INSTANCE_OF) break;
    if (statement.mainsnak._tag !== "value") continue;
    const value = statement.mainsnak.value;
    if (value._tag !== "wikibase-entityid") continue;
    const qid = normaliseQid(value.id);
    if (qid !== null) out.push(qid);
  }
  return out;
}

/**
 * Maps a fetched `WikidataItem` (keyed by `qid`, the identifier-search
 * match) to a neutral candidate — `undefined` when the batched
 * `wbgetentities` fetch didn't return this id (an upstream miss for one
 * QID in the batch). Re-validates the echoed id, falling back to the
 * requested `qid` (already validated before the request was built).
 */
export function itemToCandidate(
  item: Wikidata.WikidataItem | undefined,
  qid: string,
  language: string,
): readonly WikidataCandidate[] {
  if (item === undefined) return [];
  return [
    {
      qid: normaliseQid(item.id) ?? qid,
      label: sanitiseCandidateText(item.labels[language]),
      description: sanitiseCandidateText(item.descriptions[language]),
      instanceOf: instanceOfQids(item),
    },
  ];
}

// ── wbgetentities → enrich facts (website#613) ──────────────────────────

/** The values of every `value`-kind statement on `property`, in claim order. */
function statementValues(
  item: Wikidata.WikidataItem,
  property: string,
): readonly Wikidata.DataValue[] {
  const out: Wikidata.DataValue[] = [];
  for (const statement of item.claims[property] ?? []) {
    if (statement.mainsnak._tag === "value") out.push(statement.mainsnak.value);
  }
  return out;
}

/**
 * {@link IdentifierFact}s — one per allowlisted external-id claim
 * ({@link EXTERNAL_ID_AUTHORITIES}). Only a typed `external-id` datavalue
 * is read (the property's registered Wikibase datatype); its value is
 * re-validated by {@link normaliseExternalIdValue}, then checked against
 * the authority's identifier format and percent-encoded into its fixed IRI
 * template, so a hostile value never reaches a stored IRI. A value outside
 * the format yields no fact.
 */
function identifierFacts(item: Wikidata.WikidataItem): IdentifierFact[] {
  const out: IdentifierFact[] = [];
  for (const [property, scheme] of Object.entries(EXTERNAL_ID_AUTHORITIES)) {
    for (const value of statementValues(item, property)) {
      if (out.length >= MAX_SAME_AS) return out;
      if (value._tag !== "external-id") continue;
      const validated = normaliseExternalIdValue(value.value);
      if (validated === null) continue;
      const iri = scheme.iri(validated);
      if (iri === null) continue;
      out.push({
        _tag: "Identifier",
        property,
        authority: scheme.authority,
        value: validated,
        iri,
      });
    }
  }
  return out;
}

/** Wikibase's precision code when it is an integer in its 0–14 range, else `null`. */
function timePrecision(precision: number | null): number | null {
  return precision !== null && Number.isInteger(precision) && precision >= 0 && precision <= 14
    ? precision
    : null;
}

/**
 * The {@link DateFact} `calendar` for a time value's calendar model: the
 * entity IRI of proleptic Gregorian (`Q1985727`) or proleptic Julian
 * (`Q1985786`), as `http` (Wikibase's concept URI, what the JSON carries)
 * or `https`. Anything else, including a missing model, is `null`.
 */
function timeCalendar(calendarModel: string | null): DateFact["calendar"] {
  const match =
    calendarModel === null
      ? null
      : /^https?:\/\/www\.wikidata\.org\/entity\/(Q1985727|Q1985786)$/.exec(calendarModel);
  if (match === null) return null;
  return match[1] === "Q1985727" ? "gregorian" : "julian";
}

/**
 * {@link DateFact}s ({@link DATE_PROPERTIES}) — the typed `time` value
 * validated by {@link normaliseTimeValue}, its precision code range-checked,
 * its calendar model mapped to a calendar, and the property's English label.
 */
function dateFacts(item: Wikidata.WikidataItem): DateFact[] {
  const out: DateFact[] = [];
  for (const [property, label] of Object.entries(DATE_PROPERTIES)) {
    for (const value of statementValues(item, property)) {
      if (out.length >= MAX_DATES) return out;
      if (value._tag !== "time") continue;
      const time = normaliseTimeValue(value.time);
      if (time === null) continue;
      out.push({
        _tag: "Date",
        property,
        label,
        time,
        precision: timePrecision(value.precision),
        calendar: timeCalendar(value.calendarModel),
      });
    }
  }
  return out;
}

/**
 * {@link ImageFact}s ({@link IMAGE_PROPERTIES}) — the Commons filename and
 * the `Special:FilePath` URL built by {@link normaliseCommonsImage}.
 * Deliberately keeps this namespace's own filename → URL policy rather than
 * `Commons.filePathUrl` — that helper canonicalises spaces to underscores
 * (MediaWiki's canonical title form), which would change the `iri` of facts
 * a consumer has already stored.
 */
function imageFacts(item: Wikidata.WikidataItem): ImageFact[] {
  const out: ImageFact[] = [];
  for (const property of IMAGE_PROPERTIES) {
    for (const value of statementValues(item, property)) {
      if (out.length >= MAX_IMAGES) return out;
      if (value._tag !== "string") continue;
      const image = normaliseCommonsImage(value.value);
      if (image === null) continue;
      out.push({ _tag: "Image", property, ...image });
    }
  }
  return out;
}

/**
 * Builds the {@link WikidataFacts} the enrich operation returns for a
 * confirmed, already-fetched item: the {@link ItemFact} for `qid`, then the
 * `identifierFacts`, `dateFacts` and `imageFacts` branches.
 * Each branch is bounded and re-validates the upstream value, so a hostile
 * response can at worst yield fewer facts — never an injection or an
 * arbitrary host in a returned IRI. Presence (the `wbgetentities` miss /
 * `missing`-sentinel case) is handled by the caller, which only calls this
 * once it has a fetched `WikidataItem` for `qid`.
 */
export function normaliseFacts(item: Wikidata.WikidataItem, qid: string): WikidataFacts {
  const facts: WikidataFact[] = [
    { _tag: "Item", qid, iri: wikidataEntityIri(qid) },
    ...identifierFacts(item),
    ...dateFacts(item),
    ...imageFacts(item),
  ];
  return { qid, facts };
}
