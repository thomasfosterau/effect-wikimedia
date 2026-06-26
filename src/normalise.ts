/**
 * @copyright Thomas Foster
 *
 * Untrusted-response schemas and pure normalisers for the Wikidata
 * reconciliation lookup service (KB-011, issue #575).
 *
 * Wikidata API responses are **untrusted**: the schemas here are
 * deliberately lenient (every field optional, arrays of unknown shapes
 * tolerated) so a partial or unexpected payload decodes rather than
 * throwing, and the normalisers then extract only the fields we trust,
 * sanitising each one ({@link module:lib/server/wikidata/candidate}).
 * Decoding never trusts upstream lengths or types — a hostile response
 * can at worst yield fewer / no candidates, never an injection.
 *
 * Three response shapes are modelled, one per lookup path:
 * - `wbsearchentities` (label search) → `search[]` with `id` / `label` /
 *   `description`;
 * - `query` + `list=search` (`haswbstatement` identifier search) →
 *   `query.search[]` with a `title` that is the matched QID;
 * - `wbgetentities` (label / description / `instance of` enrichment) →
 *   `entities` keyed by QID.
 *
 * These functions are pure and unit-tested against captured fixtures
 * without any network access.
 *
 * @module lib/server/wikidata/normalise
 */

import * as Schema from "effect/Schema";
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
} from "./candidate";

// ── wbsearchentities (label search) ───────────────────────────────────

/**
 * Lenient schema for a single `wbsearchentities` result. Only the fields
 * we read are modelled, all optional. Unknown extra keys are ignored.
 */
const WbSearchEntity = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
  label: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.Unknown),
});

/** Lenient schema for the `wbsearchentities` response envelope. */
export const WbSearchResponse = Schema.Struct({
  search: Schema.optional(Schema.Array(WbSearchEntity)),
});
export type WbSearchResponse = typeof WbSearchResponse.Type;

/**
 * Normalises a `wbsearchentities` response into neutral candidates.
 * Entries whose `id` is not a well-formed QID are dropped (a defensive
 * re-validation of the upstream id before it is returned / persisted).
 * Label search does not fetch claims, so `instanceOf` is always empty.
 */
export function normaliseSearch(response: WbSearchResponse): readonly WikidataCandidate[] {
  const out: WikidataCandidate[] = [];
  for (const entry of response.search ?? []) {
    if (out.length >= MAX_CANDIDATES) break;
    const qid = typeof entry.id === "string" ? normaliseQid(entry.id) : null;
    if (qid === null) continue;
    out.push({
      qid,
      label: sanitiseText(entry.label),
      description: sanitiseText(entry.description),
      instanceOf: [],
    });
  }
  return out;
}

// ── query + list=search (identifier search) ───────────────────────────

/** Lenient schema for a single `query.search` result. */
const QuerySearchHit = Schema.Struct({
  title: Schema.optional(Schema.Unknown),
});

/** Lenient schema for the `query` + `list=search` response envelope. */
export const QuerySearchResponse = Schema.Struct({
  query: Schema.optional(
    Schema.Struct({
      search: Schema.optional(Schema.Array(QuerySearchHit)),
    }),
  ),
});
export type QuerySearchResponse = typeof QuerySearchResponse.Type;

/**
 * Extracts the matched QIDs from a `haswbstatement` search response. Each
 * hit's `title` is the page title, which for a main-namespace Wikidata
 * item is the QID itself. Non-QID titles are dropped; the result is
 * de-duplicated and capped.
 */
export function identifierMatchQids(response: QuerySearchResponse): readonly string[] {
  const hits = response.query?.search ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of hits) {
    if (out.length >= MAX_CANDIDATES) break;
    const qid = typeof hit.title === "string" ? normaliseQid(hit.title) : null;
    if (qid === null || seen.has(qid)) continue;
    seen.add(qid);
    out.push(qid);
  }
  return out;
}

// ── wbgetentities (label / description / instance-of enrichment) ───────

/** A localised text value (`{ language, value }`). */
const LocalisedText = Schema.Struct({
  value: Schema.optional(Schema.Unknown),
});

/**
 * A single Wikidata statement, modelled only down to the main snak's
 * `datavalue.value`. That value is left `Unknown` because its shape varies
 * by datatype — a `Q<id>` object for `instance of`, a bare string for an
 * external-id or image, a `{ time }` object for a date — and each consumer
 * narrows it defensively. Everything else (qualifiers, references, rank) is
 * tolerated and ignored.
 */
const ClaimStatement = Schema.Struct({
  mainsnak: Schema.optional(
    Schema.Struct({
      datavalue: Schema.optional(
        Schema.Struct({
          value: Schema.optional(Schema.Unknown),
        }),
      ),
    }),
  ),
});
type ClaimStatement = typeof ClaimStatement.Type;

/**
 * Lenient schema for a single `wbgetentities` item. `claims` is a generic
 * record keyed by property id (`P31`, `P214`, `P569`, `P18`, …); the
 * normalisers read only the properties they recognise.
 */
const WbEntity = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
  // Wikidata flags a non-existent item as `{ id, missing: "" }` keyed under
  // its QID (the key is present, the item is not). Modelled so the enrich
  // path can tell "no such item" from a real one with no claims.
  missing: Schema.optional(Schema.Unknown),
  labels: Schema.optional(Schema.Record(Schema.String, LocalisedText)),
  descriptions: Schema.optional(Schema.Record(Schema.String, LocalisedText)),
  claims: Schema.optional(Schema.Record(Schema.String, Schema.Array(ClaimStatement))),
});
type WbEntity = typeof WbEntity.Type;

/** The main-snak value of a statement, or `undefined` when absent. */
function claimValue(claim: ClaimStatement): unknown {
  return claim.mainsnak?.datavalue?.value;
}

/** Lenient schema for the `wbgetentities` response envelope. */
export const WbGetEntitiesResponse = Schema.Struct({
  entities: Schema.optional(Schema.Record(Schema.String, WbEntity)),
});
export type WbGetEntitiesResponse = typeof WbGetEntitiesResponse.Type;

/** Reads the preferred-language label/description value, sanitised. */
function localisedValue(
  record: Record<string, { value?: unknown }> | undefined,
  language: string,
): string | null {
  if (!record) return null;
  return sanitiseText(record[language]?.value);
}

/** Extracts the validated `instance of` QIDs from an entity's P31 claims. */
function instanceOfQids(entity: WbEntity): readonly string[] {
  const claims = entity.claims?.P31 ?? [];
  const out: string[] = [];
  for (const claim of claims) {
    if (out.length >= MAX_INSTANCE_OF) break;
    // A P31 value is a `{ id: "Q…" }` entity reference.
    const value = claimValue(claim);
    const id = typeof value === "object" && value !== null ? (value as { id?: unknown }).id : null;
    const qid = typeof id === "string" ? normaliseQid(id) : null;
    if (qid !== null) out.push(qid);
  }
  return out;
}

/**
 * Normalises a `wbgetentities` response into candidates, preserving the
 * order of `qids` (the identifier-search match order) and skipping any
 * QID the response didn't return. `language` selects which localised
 * label / description to surface.
 */
export function normaliseEntities(
  response: WbGetEntitiesResponse,
  qids: readonly string[],
  language: string,
): readonly WikidataCandidate[] {
  const entities = response.entities ?? {};
  const out: WikidataCandidate[] = [];
  for (const requested of qids) {
    const entity = entities[requested];
    if (!entity) continue;
    // Re-validate the echoed id; fall back to the requested QID, which we
    // already validated before building the request.
    const echoed = typeof entity.id === "string" ? normaliseQid(entity.id) : null;
    out.push({
      qid: echoed ?? requested,
      label: localisedValue(entity.labels, language),
      description: localisedValue(entity.descriptions, language),
      instanceOf: instanceOfQids(entity),
    });
  }
  return out;
}

// ── wbgetentities → enrich facts (#613) ───────────────────────────────

/** An entity's claims, keyed by property id. */
type WbClaims = Record<string, readonly ClaimStatement[]>;

/**
 * `sameAs` facts — an `exact` mapping per allowlisted external-id claim
 * ({@link EXTERNAL_ID_AUTHORITIES}). Each value is re-validated by
 * {@link normaliseExternalIdValue} and slotted into the authority's fixed
 * IRI template, so a hostile value never reaches a stored IRI.
 */
function sameAsFacts(claims: WbClaims): WikidataFact[] {
  const out: WikidataFact[] = [];
  for (const [property, scheme] of Object.entries(EXTERNAL_ID_AUTHORITIES)) {
    for (const claim of claims[property] ?? []) {
      if (out.length >= MAX_SAME_AS) return out;
      const raw = claimValue(claim);
      const value = typeof raw === "string" ? normaliseExternalIdValue(raw) : null;
      if (value === null) continue;
      out.push({
        authority: scheme.authority,
        externalId: value,
        externalIri: scheme.iri(value),
        mappingKind: "exact",
        notes: null,
      });
    }
  }
  return out;
}

/**
 * Date facts ({@link DATE_PROPERTIES}) — `equivalent` mappings keyed by the
 * date property's entity IRI, the `{ time }` value validated by
 * {@link normaliseTimeValue}, the human label stored in `notes`.
 */
function dateFacts(claims: WbClaims): WikidataFact[] {
  const out: WikidataFact[] = [];
  for (const [property, label] of Object.entries(DATE_PROPERTIES)) {
    for (const claim of claims[property] ?? []) {
      if (out.length >= MAX_DATES) return out;
      const raw = claimValue(claim);
      const time =
        typeof raw === "object" && raw !== null
          ? normaliseTimeValue((raw as { time?: unknown }).time)
          : null;
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
 */
function imageFacts(claims: WbClaims): WikidataFact[] {
  const out: WikidataFact[] = [];
  for (const property of IMAGE_PROPERTIES) {
    for (const claim of claims[property] ?? []) {
      if (out.length >= MAX_IMAGES) return out;
      const image = normaliseCommonsImage(claimValue(claim));
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
 * Normalises the confirmed item in a `wbgetentities` response into the
 * neutral {@link WikidataFacts} the enrich operation asserts: the **QID
 * self-link** plus the {@link sameAsFacts}, {@link dateFacts}, and
 * {@link imageFacts} branches. Each branch is bounded and re-validates the
 * upstream value, so a hostile response can at worst yield fewer / no facts
 * — never an injection or an arbitrary host in a stored IRI. Returns `null`
 * when the requested `qid` is absent (a clean upstream miss).
 */
export function normaliseFacts(response: WbGetEntitiesResponse, qid: string): WikidataFacts | null {
  const entity = (response.entities ?? {})[qid];
  // Absent from the map, or present as Wikidata's `missing` sentinel — either
  // way the item does not exist upstream, so the caller writes nothing.
  if (!entity || entity.missing !== undefined) return null;
  const claims = entity.claims ?? {};
  const facts: WikidataFact[] = [
    // The QID self-link (the canonical Wikidata correspondence).
    {
      authority: "wikidata",
      externalId: qid,
      externalIri: wikidataEntityIri(qid),
      mappingKind: "exact",
      notes: null,
    },
    ...sameAsFacts(claims),
    ...dateFacts(claims),
    ...imageFacts(claims),
  ];
  return { qid, facts };
}
