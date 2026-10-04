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
 * as `WikidataLookup` returns it: 2000, against the 4000 of
 * `Core.MAX_TEXT_FIELD_LENGTH`, which bounds the general-purpose clients
 * (`Action`, `Rest`). The barrel exports both names, so qualify them by
 * namespace when you use both. The clamp keeps a hostile or malformed
 * response from pushing an unbounded blob through the service (defence in
 * depth).
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
 * Cleans an untrusted free-text value for a reconciliation candidate: trims
 * it, collapses each internal whitespace run to one space, and clamps it to
 * {@link MAX_TEXT_FIELD_LENGTH} (2000) code units. Returns `null` for a
 * non-string or an empty / whitespace-only string, so callers can map
 * "nothing usable" to an absent field rather than an empty string.
 *
 * Differs from the same-named `Core.sanitiseText`, which only trims, keeps
 * internal whitespace and clamps to `Core.MAX_TEXT_FIELD_LENGTH` (4000).
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

// ── Enrich: neutral fact shape + extraction helpers (website#613) ──────

/**
 * A single fact pulled from a confirmed Wikidata item, in a neutral shape
 * a consumer can store as a provenance-marked mapping. `externalIri` (with
 * `mappingKind`) is the natural dedup key (the correspondence target);
 * `authority` + `externalId` name the source scheme and its value; `notes` carries the human-readable fact label
 * (e.g. `"date of birth"`) for facts that aren't ontology correspondences.
 * Every string is already validated / clamped — consumers treat them as
 * trusted application values.
 */
export interface WikidataFact {
  /** Source scheme, e.g. `"wikidata"`, `"viaf"`, `"wikimedia-commons"`. */
  readonly authority: string;
  /** The identifier / value in that scheme, if any (a VIAF number, a date). */
  readonly externalId: string | null;
  /** The correspondence target IRI; with {@link WikidataFact.mappingKind}, the natural dedup key. */
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
