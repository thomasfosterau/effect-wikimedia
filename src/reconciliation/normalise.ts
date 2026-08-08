/**
 * @copyright Thomas Foster
 *
 * Reconciliation shaping policy for the Wikidata lookup service (KB-011,
 * issue #575 / #613; shrunk to a policy layer over `@thomasfosterau/effect-wikimedia`
 * in #1067). `@thomasfosterau/effect-wikimedia`'s `Wikidata` module now owns
 * the HTTP plumbing and the lenient wire decode — a fully typed
 * `WikidataItem` / `DataValue` union, honest at the type, lenient at the
 * wire (see {@link module:@thomasfosterau/effect-wikimedia/wikidata}). This
 * module is what is left once that's gone: **this site's** reconciliation
 * policy — which fields become a {@link WikidataCandidate}, which claims
 * become a {@link WikidataFact} — expressed over that typed surface.
 *
 * Untrusted-data discipline still applies at this layer, even though the
 * general package already typed the wire: every value this module reads off
 * a `WikidataItem` is re-validated / re-bounded by this package's own
 * policy validators ({@link module:lib/server/wikidata/candidate}) before
 * it is returned or built into a `WikidataFact`/`WikidataCandidate` — field
 * bounds, the curated `EXTERNAL_ID_AUTHORITIES` allowlist, and the
 * injection-guard character classes are this layer's job, not the general
 * package's (it types the shape; it doesn't know this site's policy).
 *
 * These functions are pure and unit-tested against typed fixtures (no
 * network, no HTTP stub) — only `Wikidata.WikidataItem` / `SearchHit` /
 * `SearchResult` values in, `WikidataCandidate` / `WikidataFacts` values out.
 *
 * @module lib/server/wikidata/normalise
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
  sanitiseText,
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
      label: sanitiseText(hit.label),
      description: sanitiseText(hit.description),
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
      label: sanitiseText(item.labels[language]),
      description: sanitiseText(item.descriptions[language]),
      instanceOf: instanceOfQids(item),
    },
  ];
}

// ── wbgetentities → enrich facts (#613) ─────────────────────────────────

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
 * `sameAs` facts — an `exact` mapping per allowlisted external-id claim
 * ({@link EXTERNAL_ID_AUTHORITIES}). Only a typed `external-id` datavalue
 * is read (the property's registered Wikibase datatype); its value is
 * re-validated by {@link normaliseExternalIdValue} and slotted into the
 * authority's fixed IRI template, so a hostile value never reaches a
 * stored IRI.
 */
function sameAsFacts(item: Wikidata.WikidataItem): WikidataFact[] {
  const out: WikidataFact[] = [];
  for (const [property, scheme] of Object.entries(EXTERNAL_ID_AUTHORITIES)) {
    for (const value of statementValues(item, property)) {
      if (out.length >= MAX_SAME_AS) return out;
      if (value._tag !== "external-id") continue;
      const validated = normaliseExternalIdValue(value.value);
      if (validated === null) continue;
      out.push({
        authority: scheme.authority,
        externalId: validated,
        externalIri: scheme.iri(validated),
        mappingKind: "exact",
        notes: null,
      });
    }
  }
  return out;
}

/**
 * Date facts ({@link DATE_PROPERTIES}) — `equivalent` mappings keyed by the
 * date property's entity IRI, the typed `time` value validated by
 * {@link normaliseTimeValue}, the human label stored in `notes`.
 */
function dateFacts(item: Wikidata.WikidataItem): WikidataFact[] {
  const out: WikidataFact[] = [];
  for (const [property, label] of Object.entries(DATE_PROPERTIES)) {
    for (const value of statementValues(item, property)) {
      if (out.length >= MAX_DATES) return out;
      if (value._tag !== "time") continue;
      const time = normaliseTimeValue(value.time);
      if (time === null) continue;
      out.push({
        authority: "wikidata",
        externalId: time,
        externalIri: wikidataEntityIri(property),
        mappingKind: "equivalent",
        notes: label,
      });
    }
  }
  return out;
}

/**
 * Image facts ({@link IMAGE_PROPERTIES}) — `equivalent` mappings to the
 * Commons `Special:FilePath` URL built by {@link normaliseCommonsImage}.
 * Deliberately keeps this package's own filename → URL policy rather than
 * effect-wikimedia's `Commons.filePathUrl` — that helper canonicalises
 * spaces to underscores (MediaWiki's canonical title form), which would
 * change the `externalIri` this layer has always stored for existing
 * `entity_mapping` rows; see the PR description for the trade-off.
 */
function imageFacts(item: Wikidata.WikidataItem): WikidataFact[] {
  const out: WikidataFact[] = [];
  for (const property of IMAGE_PROPERTIES) {
    for (const value of statementValues(item, property)) {
      if (out.length >= MAX_IMAGES) return out;
      if (value._tag !== "string") continue;
      const image = normaliseCommonsImage(value.value);
      if (image === null) continue;
      out.push({
        authority: "wikimedia-commons",
        externalId: image.externalId,
        externalIri: image.externalIri,
        mappingKind: "equivalent",
        notes: "image",
      });
    }
  }
  return out;
}

/**
 * Builds the neutral {@link WikidataFacts} the enrich operation asserts for
 * a confirmed, already-fetched item: the **QID self-link** plus the
 * {@link sameAsFacts}, {@link dateFacts}, and {@link imageFacts} branches.
 * Each branch is bounded and re-validates the upstream value, so a hostile
 * response can at worst yield fewer facts — never an injection or an
 * arbitrary host in a stored IRI. Presence (the `wbgetentities` miss /
 * `missing`-sentinel case) is handled by the caller, which only calls this
 * once it has a fetched `WikidataItem` for `qid`.
 */
export function normaliseFacts(item: Wikidata.WikidataItem, qid: string): WikidataFacts {
  const facts: WikidataFact[] = [
    // The QID self-link (the canonical Wikidata correspondence).
    {
      authority: "wikidata",
      externalId: qid,
      externalIri: wikidataEntityIri(qid),
      mappingKind: "exact",
      notes: null,
    },
    ...sameAsFacts(item),
    ...dateFacts(item),
    ...imageFacts(item),
  ];
  return { qid, facts };
}
