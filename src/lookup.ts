/**
 * @copyright Thomas Foster
 *
 * Wikidata reconciliation lookup service (KB-011, issues #575 / #613) —
 * the **Match** and **Enrich** steps.
 *
 * `searchByLabel` / `searchByIdentifier` resolve an Entity's label and/or
 * external identifiers to candidate Wikidata items ({@link WikidataCandidate}:
 * QID + label + description, plus `instance of` where cheap) for the owner
 * to disambiguate (Match, #575). `enrich` then pulls the selected facts for
 * a **confirmed** QID — the QID self-link, `sameAs` external identifiers,
 * dates, and images ({@link WikidataFacts}) — for the operation layer to
 * stamp as provenance-marked mapping assertions (Enrich, #613). Runs over
 * Effect's `HttpClient`. The Wikidata public APIs are free and need no
 * credentials. The service is an injectable `Context.Service` so callers
 * depend on the contract, not on `fetch`: tests provide a stubbed client
 * under {@link wikidataLookupClientLayer}, production provides
 * {@link wikidataLookupLayer} over `FetchHttpClient`.
 *
 * The lookup service itself is **persistence-free**: Match returns
 * candidates and Enrich returns neutral facts; storing a chosen QID (on the
 * stable `entity_external_identifier` table) and asserting enriched facts
 * (on the versioned `entity_mapping` table) are the operation layer's job
 * (`src/lib/server/operations/entities.ts`).
 *
 * Untrusted-data discipline (mirrors the biblio lookup service):
 * - inputs (label, property id, identifier value) are validated /
 *   normalised before any URL is built, so a caller-supplied value can
 *   never escape its intended position (SSRF / injection guard — see
 *   `normaliseLabelQuery` / `normalisePropertyId` / `normaliseExternalIdValue`);
 * - every request targets a fixed host + protocol over `https`, with all
 *   variable parts placed in `URLSearchParams` (percent-encoded), never
 *   interpolated into the path;
 * - responses decode through deliberately-lenient schemas and are then
 *   sanitised field-by-field by the normalisers;
 * - an empty result decodes to an empty candidate list (not an error);
 *   transport / decode faults land on the typed {@link LookupError}.
 *
 * @module lib/server/wikidata/lookup
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  type HttpClientError,
} from "effect/unstable/http";
import {
  MAX_CANDIDATES,
  normaliseExternalIdValue,
  normaliseLabelQuery,
  normalisePropertyId,
  normaliseQid,
  type WikidataCandidate,
  type WikidataFacts,
} from "./candidate";
import {
  identifierMatchQids,
  normaliseEntities,
  normaliseFacts,
  normaliseSearch,
  QuerySearchResponse,
  WbGetEntitiesResponse,
  WbSearchResponse,
} from "./normalise";

/**
 * The fixed Wikidata API endpoint. Pinned host + protocol: every request
 * this service makes targets exactly this URL, varying only the query
 * string. A caller can never redirect the request elsewhere.
 */
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";

/** The interface language we ask Wikidata for labels / descriptions in. */
const DEFAULT_LANGUAGE = "en";

/**
 * A polite User-Agent. Wikimedia's API etiquette asks callers to identify
 * themselves so abusive traffic can be contacted rather than blanket
 * blocked.
 */
const USER_AGENT = "thomasfoster.au-wikidata-match/1.0 (mailto:me@thomasfoster.au)";

/** A bad input the caller supplied — fix the input, don't retry. */
export class InvalidQuery extends Schema.TaggedErrorClass<InvalidQuery>()("InvalidQuery", {
  kind: Schema.Literals(["label", "property", "identifier"]),
  value: Schema.String,
}) {}

/** An upstream transport / decode failure (network, 5xx, malformed body). */
export class LookupFailed extends Schema.TaggedErrorClass<LookupFailed>()("LookupFailed", {
  description: Schema.String,
}) {}

/**
 * The typed error channel for a Wikidata lookup. Public error-channel type of
 * the service contract, retained for the deferred reconciliation HTTP/Form
 * surface (#575); has no in-tree consumer yet, and shares its name with
 * biblio/lookup.ts's distinct `LookupError` — both are covered by
 * `ignoreExports` in .fallowrc.json (separate bounded contexts).
 */
export type LookupError = InvalidQuery | LookupFailed;

/** An external identifier to reconcile against: a Wikidata property + value. */
export interface ExternalIdentifier {
  /** The Wikidata property id for the identifier scheme, e.g. `"P214"` (VIAF). */
  readonly property: string;
  /** The identifier value in that scheme, e.g. a VIAF number. */
  readonly value: string;
}

/**
 * Wikidata Match contract. Each method returns a (possibly empty) list of
 * candidate matches, and fails on the typed channel for a bad input
 * ({@link InvalidQuery}) or an upstream fault ({@link LookupFailed}). An
 * empty upstream result is an empty list, **not** an error.
 */
export class WikidataLookup extends Context.Service<
  WikidataLookup,
  {
    /** Search candidate items by display label. */
    readonly searchByLabel: (
      label: string,
    ) => Effect.Effect<readonly WikidataCandidate[], LookupError>;
    /** Find candidate items carrying a given external identifier. */
    readonly searchByIdentifier: (
      identifier: ExternalIdentifier,
    ) => Effect.Effect<readonly WikidataCandidate[], LookupError>;
    /**
     * Fetch the selected enrichment facts (QID self-link, `sameAs`
     * external identifiers, dates, images) for a **confirmed** QID, ready
     * to assert as provenance-marked mappings (#613). Returns `null` when
     * the item is absent upstream; fails `InvalidQuery` for a non-QID input.
     */
    readonly enrich: (qid: string) => Effect.Effect<WikidataFacts | null, LookupError>;
  }
>()("@app/WikidataLookup") {}

// ── HTTP plumbing ─────────────────────────────────────────────────────

/**
 * Builds the fixed-host API URL with the given query parameters. All
 * variable values go through `URLSearchParams`, which percent-encodes
 * them — they are never interpolated into the path. `format=json` is
 * forced on every request.
 */
function apiUrl(params: Record<string, string>): string {
  const url = new URL(WIKIDATA_API);
  url.search = new URLSearchParams({ ...params, format: "json" }).toString();
  return url.toString();
}

function describeHttpError(error: HttpClientError.HttpClientError): string {
  return error.reason._tag === "StatusCodeError"
    ? `wikidata returned HTTP ${error.reason.response.status}`
    : `request failed: ${String(error)}`;
}

// ── Service implementation ────────────────────────────────────────────

/**
 * Builds the {@link WikidataLookup} service over an `HttpClient`. Wrapped
 * by {@link wikidataLookupClientLayer} (which tests drive with a stub
 * client) and {@link wikidataLookupLayer} (production, over the global
 * fetch); not exported because both layers live in this module.
 */
const makeWikidataLookup = Effect.fnUntraced(function* () {
  const baseClient = yield* HttpClient.HttpClient;
  const client = baseClient.pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.setHeader("user-agent", USER_AGENT),
        HttpClientRequest.acceptJson,
      ),
    ),
    // Raise a `StatusCodeError` for any non-2xx response. `HttpClient`
    // does NOT fail on status by default, so without this a 5xx that
    // still carries a JSON body would decode against the (lenient)
    // schemas and look like an empty success.
    HttpClient.filterStatusOk,
  );

  /** JSON GET against the fixed API URL, decoded through `schema`. */
  const getJson = <S extends Schema.Top>(
    url: string,
    schema: S,
  ): Effect.Effect<S["Type"], LookupFailed, S["DecodingServices"]> =>
    client.get(url).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
      Effect.catchTags({
        HttpClientError: (error) =>
          Effect.fail(new LookupFailed({ description: describeHttpError(error) })),
        SchemaError: (error) =>
          Effect.fail(
            new LookupFailed({
              description: `wikidata response did not match the expected shape: ${String(error)}`,
            }),
          ),
      }),
    );

  const searchByLabel = Effect.fn("WikidataLookup.searchByLabel")(function* (label: string) {
    const query = normaliseLabelQuery(label);
    if (query === null) {
      return yield* new InvalidQuery({ kind: "label", value: label });
    }
    const url = apiUrl({
      action: "wbsearchentities",
      search: query,
      language: DEFAULT_LANGUAGE,
      uselang: DEFAULT_LANGUAGE,
      type: "item",
      limit: String(MAX_CANDIDATES),
    });
    const response = yield* getJson(url, WbSearchResponse);
    return normaliseSearch(response);
  });

  const searchByIdentifier = Effect.fn("WikidataLookup.searchByIdentifier")(function* (
    identifier: ExternalIdentifier,
  ) {
    const property = normalisePropertyId(identifier.property);
    if (property === null) {
      return yield* new InvalidQuery({ kind: "property", value: identifier.property });
    }
    const value = normaliseExternalIdValue(identifier.value);
    if (value === null) {
      return yield* new InvalidQuery({ kind: "identifier", value: identifier.value });
    }

    // `haswbstatement:P<prop>=<value>` is the cheap "items carrying this
    // identifier" search. Both halves are validated above; the whole
    // clause is still placed in a query parameter and percent-encoded.
    const searchUrl = apiUrl({
      action: "query",
      list: "search",
      srsearch: `haswbstatement:${property}=${value}`,
      srlimit: String(MAX_CANDIDATES),
    });
    const matches = yield* getJson(searchUrl, QuerySearchResponse);
    const qids = identifierMatchQids(matches);
    if (qids.length === 0) return [] as readonly WikidataCandidate[];

    // One batched enrichment call resolves label / description / P31 for
    // every matched QID. The ids are all validated `Q<digits>`.
    const enrichUrl = apiUrl({
      action: "wbgetentities",
      ids: qids.join("|"),
      props: "labels|descriptions|claims",
      languages: DEFAULT_LANGUAGE,
    });
    const entities = yield* getJson(enrichUrl, WbGetEntitiesResponse);
    return normaliseEntities(entities, qids, DEFAULT_LANGUAGE);
  });

  const enrich = Effect.fn("WikidataLookup.enrich")(function* (qid: string) {
    const validated = normaliseQid(qid);
    if (validated === null) {
      return yield* new InvalidQuery({ kind: "identifier", value: qid });
    }
    // Single confirmed item, widest props we read. `ids` is the validated
    // QID, placed (like every value) in the percent-encoded query string.
    const url = apiUrl({
      action: "wbgetentities",
      ids: validated,
      props: "labels|descriptions|claims",
      languages: DEFAULT_LANGUAGE,
    });
    const response = yield* getJson(url, WbGetEntitiesResponse);
    return normaliseFacts(response, validated);
  });

  return { searchByLabel, searchByIdentifier, enrich } as const;
});

/**
 * {@link WikidataLookup} layer over whatever `HttpClient` is in context.
 * The production graph supplies `FetchHttpClient` (see
 * {@link wikidataLookupLayer}); a test supplies a stubbed fetch under the
 * same `FetchHttpClient` slot. Kept separate from {@link wikidataLookupLayer}
 * so tests can inject their own client without bundling the global fetch.
 */
export const wikidataLookupClientLayer: Layer.Layer<WikidataLookup, never, HttpClient.HttpClient> =
  Layer.effect(WikidataLookup)(makeWikidataLookup());

/**
 * Production {@link WikidataLookup} layer, backed by the Worker global
 * fetch via `FetchHttpClient`. Provided by the deferred reconciliation
 * HTTP / Form surface that triggers a Match (filed back to #575); this
 * slice ships the layer and exercises the service through
 * {@link wikidataLookupClientLayer}.
 */
export const wikidataLookupLayer: Layer.Layer<WikidataLookup> = wikidataLookupClientLayer.pipe(
  Layer.provide(FetchHttpClient.layer),
);
