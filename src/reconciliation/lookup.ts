/**
 * The Wikidata reconciliation service: **Match** (`searchByLabel`,
 * `searchByIdentifier` → candidate items) and **Enrich** (`enrich` → the
 * selected facts for a confirmed QID).
 *
 * Match resolves a label and/or external identifiers to candidate Wikidata
 * items ({@link WikidataCandidate}: QID + label + description, plus
 * `instance of` where cheap) for a reviewer to disambiguate. Enrich pulls the
 * selected facts for a **confirmed** QID — the item itself, its curated
 * external identifiers, dates, and images ({@link WikidataFacts}, each a
 * {@link Reconciliation.WikidataFact} tagged by kind).
 *
 * Runs over this package's `Action` and `Wikidata` modules through
 * `Core.WikimediaClient`: provide {@link wikidataLookupLayer} in production,
 * or {@link wikidataLookupClientLayer} over a stub client in tests.
 * Persistence-free: storing a chosen QID or the returned facts is the
 * caller's job.
 *
 * Every input (label, property id, identifier value) is validated before it
 * reaches a request, and every field read off a response is re-validated
 * against this namespace's allowlists (see `./normalise.ts`); an empty
 * upstream result is an empty list, and transport or decode faults fail with
 * {@link LookupFailed}.
 *
 * @copyright Thomas Foster
 * @module reconciliation/lookup
 */

import * as Action from "../action.ts";
import * as Core from "../core.ts";
import * as Wikidata from "../wikidata.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  MAX_CANDIDATES,
  normaliseExternalIdValue,
  normaliseLabelQuery,
  normalisePropertyId,
  normaliseQid,
  type WikidataCandidate,
  type WikidataFacts,
} from "./candidate.ts";
import { dedupedQids, hitToCandidate, itemToCandidate, normaliseFacts } from "./normalise.ts";

/**
 * The fixed Wikidata host every request in this module targets. Passed
 * explicitly to each `Wikidata` / `Action` call (their host is always a
 * parameter, never a constant they bake in) — pinning it here is this
 * namespace's choice, not the surface modules'.
 */
const WIKIDATA_HOST = "www.wikidata.org";

/** The interface language we ask Wikidata for labels / descriptions in. */
const DEFAULT_LANGUAGE = "en";

/** The `wbgetentities` facets this service ever needs — narrower than effect-wikimedia's full-item default. */
const ENTITY_PROPS = ["labels", "descriptions", "claims"] as const;

/** A bad input the caller supplied — fix the input, don't retry. */
export class InvalidQuery extends Schema.TaggedError<InvalidQuery>()("InvalidQuery", {
  kind: Schema.Literals(["label", "property", "identifier"]),
  value: Schema.String,
}) {}

/** An upstream transport / decode failure (network, 5xx, malformed body). */
export class LookupFailed extends Schema.TaggedError<LookupFailed>()("LookupFailed", {
  description: Schema.String,
}) {}

/** The typed error channel of every {@link WikidataLookup} method. */
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
     * Fetch the selected enrichment facts for a **confirmed** QID: the
     * item itself, then its curated external identifiers, dates and
     * images, each a {@link Reconciliation.WikidataFact} tagged by kind.
     * Returns `null` when the item is absent upstream; fails
     * `InvalidQuery` for a non-QID input.
     */
    readonly enrich: (qid: string) => Effect.Effect<WikidataFacts | null, LookupError>;
  }
>()("effect-wikimedia/WikidataLookup") {}

/**
 * Maps effect-wikimedia's typed error channel onto this service's
 * {@link LookupFailed}. `InvalidRequest` is included defensively — every
 * request this module builds already validates its inputs against this
 * layer's own policy before calling effect-wikimedia, so the general
 * package should never see anything it rejects; if it somehow does, that's
 * an upstream/transport concern from this service's contract, not a caller
 * input error.
 */
function toLookupFailed(error: Core.WikimediaError): LookupFailed {
  switch (error._tag) {
    case "RequestFailed":
      return new LookupFailed({ description: error.description });
    case "RateLimited":
      return new LookupFailed({
        description: `wikidata rate-limited the request (retry after ${error.retryAfterSeconds}s)`,
      });
    case "InvalidRequest":
      return new LookupFailed({
        description: `unexpected invalid request building the wikidata query (${error.kind}: ${error.value})`,
      });
  }
}

// ── Service implementation ────────────────────────────────────────────

/**
 * Builds the {@link WikidataLookup} service over a `Core.WikimediaClient`.
 * Wrapped by {@link wikidataLookupClientLayer} (which tests drive with a
 * stub client) and {@link wikidataLookupLayer} (production, over
 * effect-wikimedia's `Core.wikimediaLayer`); not exported because both
 * layers live in this module.
 */
const makeWikidataLookup = Effect.fnUntraced(function* () {
  // Resolved once at layer-build time (mirrors effect-wikimedia's own
  // `WikimediaClient` construction over `HttpClient`) so every service
  // method below is `R = never`, matching the `WikidataLookup` contract —
  // callers depend on the service, not on effect-wikimedia's context.
  const client = yield* Core.WikimediaClient;

  /** Runs an effect-wikimedia call against the resolved client, mapping its error channel onto {@link LookupFailed}. */
  const run = <A>(
    effect: Effect.Effect<A, Core.WikimediaError, Core.WikimediaClient>,
  ): Effect.Effect<A, LookupFailed> =>
    effect.pipe(
      Effect.provideService(Core.WikimediaClient, client),
      Effect.mapError(toLookupFailed),
    );

  const searchByLabel = Effect.fn("WikidataLookup.searchByLabel")(function* (label: string) {
    const query = normaliseLabelQuery(label);
    if (query === null) {
      return yield* new InvalidQuery({ kind: "label", value: label });
    }
    const hits = yield* run(
      Wikidata.searchEntities(WIKIDATA_HOST, query, {
        language: DEFAULT_LANGUAGE,
        type: "item",
        limit: MAX_CANDIDATES,
      }),
    );
    return hits.flatMap(hitToCandidate);
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
    // clause is still handed to effect-wikimedia as a single query
    // parameter value, never interpolated into a path.
    const hits = yield* run(
      Action.search(WIKIDATA_HOST, `haswbstatement:${property}=${value}`, {
        limit: MAX_CANDIDATES,
      }),
    );
    const qids = dedupedQids(hits);
    if (qids.length === 0) return [] as readonly WikidataCandidate[];

    // One batched enrichment call resolves label / description / P31 for
    // every matched QID. The ids are all validated `Q<digits>`.
    const entities = yield* run(
      Wikidata.getEntities(WIKIDATA_HOST, qids, {
        languages: [DEFAULT_LANGUAGE],
        props: ENTITY_PROPS,
      }),
    );
    return qids.flatMap((qid) => itemToCandidate(entities[qid], qid, DEFAULT_LANGUAGE));
  });

  const enrich = Effect.fn("WikidataLookup.enrich")(function* (qid: string) {
    const validated = normaliseQid(qid);
    if (validated === null) {
      return yield* new InvalidQuery({ kind: "identifier", value: qid });
    }
    // Single confirmed item; `validated` is the already-validated QID.
    const entities = yield* run(
      Wikidata.getEntities(WIKIDATA_HOST, [validated], {
        languages: [DEFAULT_LANGUAGE],
        props: ENTITY_PROPS,
      }),
    );
    const item = entities[validated];
    if (item === undefined) return null;
    return normaliseFacts(item, validated);
  });

  return { searchByLabel, searchByIdentifier, enrich } as const;
});

/**
 * {@link WikidataLookup} layer over whatever `Core.WikimediaClient` is in
 * context. The production graph supplies {@link Core.wikimediaLayer} (see
 * {@link wikidataLookupLayer}); a test supplies a stub `Core.WikimediaClient`
 * directly under the same slot (see `tests/reconciliation/lookup.test.ts` —
 * stubbing at this layer rather than at `FetchHttpClient` keeps that suite
 * decoupled from the surface modules' own URL-building / wire-decode tests). Kept
 * separate from {@link wikidataLookupLayer} so tests can inject their own
 * client without bundling the global fetch.
 */
export const wikidataLookupClientLayer: Layer.Layer<WikidataLookup, never, Core.WikimediaClient> =
  Layer.effect(WikidataLookup)(makeWikidataLookup());

/**
 * Production {@link WikidataLookup} layer, backed by `Core.wikimediaLayer`
 * (the global `fetch` via `FetchHttpClient`).
 */
export const wikidataLookupLayer: Layer.Layer<WikidataLookup> = wikidataLookupClientLayer.pipe(
  Layer.provide(Core.wikimediaLayer),
);
