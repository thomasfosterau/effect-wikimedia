/**
 * @copyright Thomas Foster
 *
 * Neutral candidate-match shape and untrusted-input helpers for the
 * Wikidata reconciliation lookup service (KB-011, issue #575). This
 * package's policy layer over `@thomasfosterau/effect-wikimedia` (#1067) —
 * the general package types and decodes the Wikidata wire; this module
 * defines what *this site* trusts and stores.
 *
 * A {@link WikidataCandidate} is the provider-neutral match the lookup
 * service ({@link module:lib/server/wikidata/lookup}) normalises
 * effect-wikimedia's typed `Wikidata.WikidataItem` / `SearchHit` values
 * into ({@link module:lib/server/wikidata/normalise}). This slice is the
 * **Match** step only: it resolves an Entity's label and/or external
 * identifiers to candidate QIDs for the owner to disambiguate. It
 * deliberately does **not** persist anything.
 *
 * Persistence is a separate concern, delivered by issue #612: a QID is a
 * stable, identity-level authority reference that belongs on `entity`
 * (per the {@link
 * ../../../docs/decisions/ontology-mappings-and-status-assertions.md
 * ontology-mappings decision}). A confirmed QID is persisted through the
 * stable `entity_external_identifier` table (KB-004 — since #864 S5/D5
 * also the biblio pipeline's `openlibrary` / `crossref` provenance home,
 * one row per authority) via `updateEntity`'s `externalIdentifiers` input
 * — see {@link module:lib/server/operations/entities}. This module
 * remains the Match step only and still persists nothing itself.
 *
 * Everything in this module is pure: input validation and the candidate
 * shape are unit-testable without a database or network.
 *
 * @module lib/server/wikidata/candidate
 */

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
   * the owner tell a person from a film from a concept during review.
   * Empty when the lookup path didn't fetch claims (label search doesn't).
   */
  readonly instanceOf: readonly string[];
}

// ── Field bounds ──────────────────────────────────────────────────────

/**
 * Upper bound on any single free-text field copied from an untrusted
 * Wikidata response. Labels and descriptions are clamped to this before
 * being returned so a hostile or malformed response can't push an
 * unbounded blob through the service (defence in depth).
 */
export const MAX_TEXT_FIELD_LENGTH = 2000;

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
 * Trims, collapses, and length-clamps an untrusted free-text value.
 * Returns `null` for empty / whitespace-only input so callers can map
 * "nothing usable" to an absent field rather than an empty string.
 */
export function sanitiseText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.slice(0, MAX_TEXT_FIELD_LENGTH);
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

// ── Enrich: neutral fact shape + extraction helpers (#613) ─────────────

/**
 * A single fact pulled from a confirmed Wikidata item, in the neutral
 * shape the ingest operation stamps onto `entity_mapping` as a
 * provenance-marked assertion. `externalIri` is the dedup key (the
 * correspondence target); `authority` + `externalId` name the source
 * scheme and its value; `notes` carries the human-readable fact label
 * (e.g. `"date of birth"`) for facts that aren't ontology correspondences.
 * Every string is already validated / clamped — consumers treat them as
 * trusted application values.
 */
export interface WikidataFact {
  /** Source scheme, e.g. `"wikidata"`, `"viaf"`, `"wikimedia-commons"`. */
  readonly authority: string;
  /** The identifier / value in that scheme, if any (a VIAF number, a date). */
  readonly externalId: string | null;
  /** The correspondence target IRI — the `(mapping_kind, external_iri)` dedup key. */
  readonly externalIri: string;
  /** `exact` for identity links (the QID, a `sameAs`); `equivalent` for facts (dates, images). */
  readonly mappingKind: "exact" | "equivalent";
  /** Human label for non-correspondence facts; `null` for plain `sameAs` links. */
  readonly notes: string | null;
}

/** Selected facts extracted from a confirmed Wikidata item, ready to assert. */
export interface WikidataFacts {
  /** The confirmed item id the facts were pulled for. */
  readonly qid: string;
  /** The neutral facts (QID self-link + `sameAs` + dates + images). */
  readonly facts: readonly WikidataFact[];
}

/** Cap on how many `sameAs` external-identifier facts we extract per item. */
export const MAX_SAME_AS = 30;

/** Cap on how many date facts we extract per item. */
export const MAX_DATES = 10;

/** Cap on how many image facts we extract per item. */
export const MAX_IMAGES = 5;

/** The `http://www.wikidata.org/entity/<id>` IRI for a validated Q/P id. */
export function wikidataEntityIri(id: string): string {
  return `http://www.wikidata.org/entity/${id}`;
}

/**
 * Curated allowlist of Wikidata external-identifier properties we lift as
 * `sameAs` links — property id → the local authority name and the IRI
 * template that turns a validated identifier value into a resolvable URL.
 *
 * Deliberately a closed set: only well-known authorities over known hosts,
 * so an enriched `sameAs` IRI is always built from a fixed template plus a
 * `normaliseExternalIdValue`-checked value — never an arbitrary host from
 * the untrusted response. New authorities are a one-line addition.
 */
export const EXTERNAL_ID_AUTHORITIES: Readonly<
  Record<string, { readonly authority: string; readonly iri: (value: string) => string }>
> = {
  P214: { authority: "viaf", iri: (v) => `https://viaf.org/viaf/${v}` },
  P213: { authority: "isni", iri: (v) => `https://isni.org/isni/${v}` },
  P496: { authority: "orcid", iri: (v) => `https://orcid.org/${v}` },
  P244: { authority: "lccn", iri: (v) => `https://id.loc.gov/authorities/names/${v}` },
  P227: { authority: "gnd", iri: (v) => `https://d-nb.info/gnd/${v}` },
  P268: { authority: "bnf", iri: (v) => `https://catalogue.bnf.fr/ark:/12148/cb${v}` },
};

/**
 * Wikidata properties whose value is a calendar date we lift as a fact,
 * mapped to the human label stored in the assertion's `notes`.
 */
export const DATE_PROPERTIES: Readonly<Record<string, string>> = {
  P569: "date of birth",
  P570: "date of death",
  P571: "inception",
  P576: "dissolved, abolished or demolished date",
};

/** Wikidata image properties (Commons media). */
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
 * builds its stable `Special:FilePath` URL. Rejects control characters and
 * the `|`/`#`/`?` that could break out of the path segment; the filename is
 * percent-encoded into the fixed Commons host. Returns `null` for unusable
 * input. The returned `{ externalId, externalIri }` are both trusted.
 */
export function normaliseCommonsImage(
  raw: unknown,
): { readonly externalId: string; readonly externalIri: string } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return null;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  if (/[|#?]/.test(trimmed)) return null;
  const externalIri = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(trimmed)}`;
  return { externalId: trimmed, externalIri };
}
