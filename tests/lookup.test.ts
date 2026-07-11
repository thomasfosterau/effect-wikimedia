/**
 * Unit tests for the Wikidata reconciliation lookup service
 * (`src/lookup.ts`).
 *
 * The network is stubbed at `FetchHttpClient.Fetch` with a substring
 * router (Wikidata varies only the query string of one fixed endpoint),
 * so the tests exercise the full request-building, schema-decoding, and
 * normalisation pipeline while never reaching the network. No database.
 *
 * Covered:
 * - label search candidate parsing (id / label / description);
 * - identifier search: `haswbstatement` match -> batched `wbgetentities`
 *   enrichment (label / description / instance-of);
 * - empty upstream result -> empty list (not an error);
 * - malformed input rejected before any request is built;
 * - field sanitisation (whitespace collapse) and non-QID entries dropped;
 * - upstream 5xx / malformed body -> LookupFailed.
 *
 * @module tests/lookup
 */

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import {
  type ExternalIdentifier,
  InvalidQuery,
  LookupFailed,
  type WikidataCandidate,
  type WikidataFacts,
  WikidataLookup,
  wikidataLookupClientLayer,
} from "@thomasfosterau/wikidata";
import { expectFailureInstanceOf, runTest } from "@test-helpers/effect";

// ── Fetch router stub ────────────────────────────────────────────────

interface StubRoute {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Builds a Layer providing a `FetchHttpClient` whose fetch routes by the
 * first key that is a **substring** of the request URL (the query string
 * order is not deterministic, so exact-match would be brittle). Unmatched
 * URLs answer an empty `200` (a clean "no results"). Each requested URL is
 * captured for assertions.
 */
const stubRouter = (routes: Record<string, StubRoute>) => {
  const urls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    urls.push(request.url);
    const key = Object.keys(routes).find((k) => request.url.includes(k));
    const route = key ? routes[key] : undefined;
    if (!route) {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { "content-type": "application/json" },
    });
  };
  const layer = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  return { urls, layer };
};

type Result = readonly WikidataCandidate[];

const withLookup = <E>(
  layer: Layer.Layer<FetchHttpClient.HttpClient>,
  use: (lookup: {
    readonly searchByLabel: (label: string) => Effect.Effect<Result, E>;
    readonly searchByIdentifier: (id: ExternalIdentifier) => Effect.Effect<Result, E>;
  }) => Effect.Effect<Result, E>,
): Effect.Effect<Result, E, never> =>
  Effect.gen(function* () {
    const lookup = yield* WikidataLookup;
    return yield* use(lookup);
  }).pipe(Effect.provide(wikidataLookupClientLayer), Effect.provide(layer)) as Effect.Effect<
    Result,
    E,
    never
  >;

// ── Label search ─────────────────────────────────────────────────────

describe("WikidataLookup.searchByLabel", () => {
  it("parses candidates and collapses whitespace in the fields", () => {
    const { urls, layer } = stubRouter({
      "action=wbsearchentities": {
        status: 200,
        body: {
          search: [
            {
              id: "Q42",
              label: "Douglas  Adams",
              description: "British  writer (1952–2001)",
            },
            // A non-QID entry is dropped by the normaliser.
            { id: "not-a-qid", label: "junk" },
          ],
        },
      },
    });

    return runTest(
      withLookup(layer, (lookup) => lookup.searchByLabel("Douglas Adams")).pipe(
        Effect.map((candidates) => {
          expect(candidates).toEqual([
            {
              qid: "Q42",
              label: "Douglas Adams",
              description: "British writer (1952–2001)",
              instanceOf: [],
            },
          ]);
          // The label travelled as a query parameter, percent-encoded.
          expect(urls[0]).toContain("search=Douglas+Adams");
          return candidates;
        }),
      ),
    );
  });

  it("returns an empty list when Wikidata has no matches", async () => {
    const { layer } = stubRouter({
      "action=wbsearchentities": { status: 200, body: { search: [] } },
    });
    const result = await runTest(withLookup(layer, (lookup) => lookup.searchByLabel("zzz")));
    expect(result).toEqual([]);
  });

  it("rejects a blank label before any request", async () => {
    const { urls, layer } = stubRouter({});
    await expectFailureInstanceOf(
      withLookup(layer, (lookup) => lookup.searchByLabel("   ")),
      InvalidQuery,
    );
    expect(urls).toEqual([]);
  });

  it("fails with LookupFailed on an upstream 5xx", async () => {
    const { layer } = stubRouter({
      "action=wbsearchentities": { status: 503, body: {} },
    });
    await expectFailureInstanceOf(
      withLookup(layer, (lookup) => lookup.searchByLabel("Douglas Adams")),
      LookupFailed,
    );
  });
});

// ── Identifier search ────────────────────────────────────────────────

describe("WikidataLookup.searchByIdentifier", () => {
  it("matches via haswbstatement then enriches via wbgetentities", () => {
    const { urls, layer } = stubRouter({
      "list=search": {
        status: 200,
        body: { query: { search: [{ title: "Q42" }, { title: "Q42" }] } },
      },
      "action=wbgetentities": {
        status: 200,
        body: {
          entities: {
            Q42: {
              id: "Q42",
              labels: { en: { language: "en", value: "Douglas Adams" } },
              descriptions: { en: { language: "en", value: "British writer" } },
              claims: {
                P31: [{ mainsnak: { datavalue: { value: { id: "Q5" } } } }],
              },
            },
          },
        },
      },
    });

    return runTest(
      withLookup(layer, (lookup) =>
        lookup.searchByIdentifier({ property: "P214", value: "113230702" }),
      ).pipe(
        Effect.map((candidates) => {
          expect(candidates).toEqual([
            {
              qid: "Q42",
              label: "Douglas Adams",
              description: "British writer",
              instanceOf: ["Q5"],
            },
          ]);
          // The statement clause travelled as a query parameter.
          expect(urls[0]).toContain("haswbstatement");
          // Exactly one enrichment call, with the de-duplicated id.
          const enrich = urls.find((u) => u.includes("action=wbgetentities"));
          expect(enrich).toContain("ids=Q42");
          return candidates;
        }),
      ),
    );
  });

  it("returns an empty list (no enrichment call) when no item carries the identifier", async () => {
    const { urls, layer } = stubRouter({
      "list=search": { status: 200, body: { query: { search: [] } } },
    });
    const result = await runTest(
      withLookup(layer, (lookup) =>
        lookup.searchByIdentifier({ property: "P214", value: "999999" }),
      ),
    );
    expect(result).toEqual([]);
    expect(urls.some((u) => u.includes("wbgetentities"))).toBe(false);
  });

  it("rejects a malformed property id before any request", async () => {
    const { urls, layer } = stubRouter({});
    await expectFailureInstanceOf(
      withLookup(layer, (lookup) =>
        lookup.searchByIdentifier({ property: "Q42", value: "113230702" }),
      ),
      InvalidQuery,
    );
    expect(urls).toEqual([]);
  });

  it("rejects an identifier value that would inject a second statement", async () => {
    const { urls, layer } = stubRouter({});
    await expectFailureInstanceOf(
      withLookup(layer, (lookup) =>
        lookup.searchByIdentifier({ property: "P214", value: "1|haswbstatement:P31=Q5" }),
      ),
      InvalidQuery,
    );
    expect(urls).toEqual([]);
  });

  it("fails with LookupFailed when the enrichment body has the wrong shape", async () => {
    const { layer } = stubRouter({
      "list=search": {
        status: 200,
        body: { query: { search: [{ title: "Q42" }] } },
      },
      "action=wbgetentities": {
        status: 200,
        // `entities` must be a record; a string trips the schema decode.
        body: { entities: "not an object" },
      },
    });
    await expectFailureInstanceOf(
      withLookup(layer, (lookup) =>
        lookup.searchByIdentifier({ property: "P214", value: "113230702" }),
      ),
      LookupFailed,
    );
  });
});

describe("WikidataLookup.enrich", () => {
  /** A `wbgetentities` body for `qid` carrying VIAF + birth date + image + P31 claims. */
  const enrichBody = (qid: string) => ({
    entities: {
      [qid]: {
        id: qid,
        claims: {
          P214: [{ mainsnak: { datavalue: { value: "113230702" } } }],
          P569: [
            {
              mainsnak: { datavalue: { value: { time: "+1952-03-11T00:00:00Z", precision: 11 } } },
            },
          ],
          P18: [{ mainsnak: { datavalue: { value: "Douglas adams portrait.jpg" } } }],
          P31: [{ mainsnak: { datavalue: { value: { id: "Q5" } } } }],
        },
      },
    },
  });

  const enrichEffect = (layer: Layer.Layer<FetchHttpClient.HttpClient>, qid: string) =>
    Effect.gen(function* () {
      const lookup = yield* WikidataLookup;
      return yield* lookup.enrich(qid);
    }).pipe(Effect.provide(wikidataLookupClientLayer), Effect.provide(layer)) as Effect.Effect<
      WikidataFacts | null,
      InvalidQuery | LookupFailed,
      never
    >;

  it("extracts the QID self-link, sameAs, date and image facts", async () => {
    const { urls, layer } = stubRouter({
      "action=wbgetentities": { status: 200, body: enrichBody("Q42") },
    });
    const facts = await runTest(enrichEffect(layer, "Q42"));

    expect(facts).not.toBeNull();
    expect(facts?.qid).toBe("Q42");
    expect(facts?.facts).toContainEqual({
      authority: "wikidata",
      externalId: "Q42",
      externalIri: "http://www.wikidata.org/entity/Q42",
      mappingKind: "exact",
      notes: null,
    });
    expect(facts?.facts).toContainEqual({
      authority: "viaf",
      externalId: "113230702",
      externalIri: "https://viaf.org/viaf/113230702",
      mappingKind: "exact",
      notes: null,
    });
    expect(facts?.facts).toContainEqual({
      authority: "wikidata",
      externalId: "1952-03-11T00:00:00Z",
      externalIri: "http://www.wikidata.org/entity/P569",
      mappingKind: "equivalent",
      notes: "date of birth",
    });
    expect(facts?.facts).toContainEqual({
      authority: "wikimedia-commons",
      externalId: "Douglas adams portrait.jpg",
      externalIri:
        "https://commons.wikimedia.org/wiki/Special:FilePath/Douglas%20adams%20portrait.jpg",
      mappingKind: "equivalent",
      notes: "image",
    });
    // The request targeted the fixed wbgetentities endpoint for the QID.
    expect(urls.some((u) => u.includes("action=wbgetentities") && u.includes("ids=Q42"))).toBe(
      true,
    );
  });

  it("drops a hostile external-id value and an out-of-shape date, keeping the QID link", async () => {
    const { layer } = stubRouter({
      "action=wbgetentities": {
        status: 200,
        body: {
          entities: {
            Q1: {
              id: "Q1",
              claims: {
                // `|` would smuggle a second statement clause — rejected.
                P214: [{ mainsnak: { datavalue: { value: "123|P31=Q5" } } }],
                // Not a Wikidata time shape — rejected.
                P569: [{ mainsnak: { datavalue: { value: { time: "yesterday" } } } }],
              },
            },
          },
        },
      },
    });
    const facts = await runTest(enrichEffect(layer, "Q1"));
    // Only the QID self-link survives.
    expect(facts?.facts).toHaveLength(1);
    expect(facts?.facts[0]?.authority).toBe("wikidata");
  });

  it("returns null when the item is absent upstream", async () => {
    const { layer } = stubRouter({
      "action=wbgetentities": { status: 200, body: { entities: {} } },
    });
    expect(await runTest(enrichEffect(layer, "Q9999999"))).toBeNull();
  });

  it("returns null for Wikidata's `missing` sentinel (a non-existent QID)", async () => {
    // `wbgetentities` returns a non-existent item keyed under its QID as
    // `{ id, missing: "" }` — the key is present but the item does not exist.
    const { layer } = stubRouter({
      "action=wbgetentities": {
        status: 200,
        body: { entities: { Q9999999: { id: "Q9999999", missing: "" } } },
      },
    });
    expect(await runTest(enrichEffect(layer, "Q9999999"))).toBeNull();
  });

  it("rejects a non-QID before any request", async () => {
    const { urls, layer } = stubRouter({});
    await expectFailureInstanceOf(enrichEffect(layer, "not-a-qid"), InvalidQuery);
    expect(urls).toHaveLength(0);
  });

  it("fails with LookupFailed on an upstream 5xx", async () => {
    const { layer } = stubRouter({ "action=wbgetentities": { status: 502, body: {} } });
    await expectFailureInstanceOf(enrichEffect(layer, "Q42"), LookupFailed);
  });
});
