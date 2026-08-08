/**
 * Unit tests for the Wikidata reconciliation lookup service
 * (`src/lookup.ts`).
 *
 * Stubs effect-wikimedia's `Core.WikimediaClient` service directly (not the
 * `HttpClient`/`fetch` beneath it — effect-wikimedia's own suite already
 * covers URL-building and lenient wire decode; this suite is this
 * package's policy over the typed surface it hands back). The stub router
 * dispatches on the request's `action` / `list` param and returns raw
 * `wbsearchentities` / `list=search` / `wbgetentities` wire bodies —
 * effect-wikimedia's real normalisers still run on them inside
 * `Wikidata.searchEntities` / `Action.search` / `Wikidata.getEntities`.
 *
 * Covered:
 * - label search candidate parsing (id / label / description);
 * - identifier search: `haswbstatement` match -> batched `wbgetentities`
 *   enrichment (label / description / instance-of);
 * - empty upstream result -> empty list (not an error);
 * - malformed input rejected before any request is built;
 * - field sanitisation (whitespace collapse) and non-QID entries dropped;
 * - upstream transport / rate-limit / invalid-request faults -> LookupFailed.
 *
 * @module tests/lookup
 */

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Core } from "@thomasfosterau/effect-wikimedia";
import {
  type ExternalIdentifier,
  InvalidQuery,
  type LookupError,
  LookupFailed,
  type WikidataCandidate,
  type WikidataFacts,
  WikidataLookup,
  wikidataLookupClientLayer,
} from "@thomasfosterau/wikidata";
import { expectFailureInstanceOf, runTest } from "@test-helpers/effect";

// ── WikimediaClient stub ────────────────────────────────────────────────

/** One stubbed route: either a raw wire-shaped success body, or a typed failure. */
interface StubRoute {
  readonly body?: unknown;
  readonly fail?: Core.WikimediaError;
}

/** The route key a request dispatches to, by its Action API `action` / `list` param. */
function routeKeyFor(request: Core.WikimediaRequest): string | undefined {
  if (request.params?.list === "search") return "list=search";
  if (request.params?.action === "wbsearchentities") return "action=wbsearchentities";
  if (request.params?.action === "wbgetentities") return "action=wbgetentities";
  return undefined;
}

/**
 * Builds a Layer providing a stub `Core.WikimediaClient` that dispatches by
 * route key (see {@link routeKeyFor}), recording every request. An
 * unmatched request answers an empty body (a clean "no results").
 */
function stubClient(routes: Record<string, StubRoute>) {
  const requests: Core.WikimediaRequest[] = [];
  const getJson = <A>(request: Core.WikimediaRequest): Effect.Effect<A, Core.WikimediaError> => {
    requests.push(request);
    const route = routeKeyFor(request) ? routes[routeKeyFor(request) as string] : undefined;
    if (route?.fail) return Effect.fail(route.fail);
    return Effect.succeed((route?.body ?? {}) as A);
  };
  const layer = Layer.succeed(Core.WikimediaClient, {
    getJson,
    getText: () => Effect.fail(new Core.RequestFailed({ description: "getText not stubbed" })),
  });
  return { requests, layer };
}

type Result = readonly WikidataCandidate[];

const withLookup = (
  layer: Layer.Layer<Core.WikimediaClient>,
  use: (lookup: {
    readonly searchByLabel: (label: string) => Effect.Effect<Result, LookupError>;
    readonly searchByIdentifier: (id: ExternalIdentifier) => Effect.Effect<Result, LookupError>;
  }) => Effect.Effect<Result, LookupError>,
): Effect.Effect<Result, LookupError, never> =>
  Effect.gen(function* () {
    const lookup = yield* WikidataLookup;
    return yield* use(lookup);
  }).pipe(Effect.provide(wikidataLookupClientLayer.pipe(Layer.provide(layer))));

// ── Label search ─────────────────────────────────────────────────────

describe("WikidataLookup.searchByLabel", () => {
  it("parses candidates and collapses whitespace in the fields", () => {
    const { requests, layer } = stubClient({
      "action=wbsearchentities": {
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
          // The label travelled as the search query parameter.
          expect(requests[0]?.params?.search).toBe("Douglas Adams");
          return candidates;
        }),
      ),
    );
  });

  it("returns an empty list when Wikidata has no matches", async () => {
    const { layer } = stubClient({
      "action=wbsearchentities": { body: { search: [] } },
    });
    const result = await runTest(withLookup(layer, (lookup) => lookup.searchByLabel("zzz")));
    expect(result).toEqual([]);
  });

  it("drops a non-item entity id effect-wikimedia accepts but this policy does not", async () => {
    // "P31" is a well-formed *property* id — effect-wikimedia's own
    // `wbsearchentities` normaliser accepts any Q/P/L entity id and lets it
    // through. This layer's candidates are always item QIDs, so
    // `hitToCandidate` re-validates with its own `normaliseQid` and drops it
    // — a defensive check independent of the general package's typing.
    const { layer } = stubClient({
      "action=wbsearchentities": {
        body: { search: [{ id: "P31", label: "instance of" }] },
      },
    });
    const result = await runTest(withLookup(layer, (lookup) => lookup.searchByLabel("instance")));
    expect(result).toEqual([]);
  });

  it("rejects a blank label before any request", async () => {
    const { requests, layer } = stubClient({});
    await expectFailureInstanceOf(
      withLookup(layer, (lookup) => lookup.searchByLabel("   ")),
      InvalidQuery,
    );
    expect(requests).toEqual([]);
  });

  it("fails with LookupFailed on an upstream transport fault", async () => {
    const { layer } = stubClient({
      "action=wbsearchentities": {
        fail: new Core.RequestFailed({ description: "wikidata returned HTTP 503" }),
      },
    });
    await expectFailureInstanceOf(
      withLookup(layer, (lookup) => lookup.searchByLabel("Douglas Adams")),
      LookupFailed,
    );
  });

  it("fails with LookupFailed when the upstream is rate-limited", async () => {
    const { layer } = stubClient({
      "action=wbsearchentities": { fail: new Core.RateLimited({ retryAfterSeconds: 5 }) },
    });
    const failure = (await expectFailureInstanceOf(
      withLookup(layer, (lookup) => lookup.searchByLabel("Douglas Adams")),
      LookupFailed,
    )) as LookupFailed;
    expect(failure.description).toContain("rate-limited");
  });
});

// ── Identifier search ────────────────────────────────────────────────

describe("WikidataLookup.searchByIdentifier", () => {
  it("matches via haswbstatement then enriches via wbgetentities", () => {
    const { requests, layer } = stubClient({
      "list=search": {
        body: { query: { search: [{ title: "Q42" }, { title: "Q42" }] } },
      },
      "action=wbgetentities": {
        body: {
          entities: {
            Q42: {
              id: "Q42",
              labels: { en: { language: "en", value: "Douglas Adams" } },
              descriptions: { en: { language: "en", value: "British writer" } },
              claims: {
                P31: [
                  {
                    mainsnak: {
                      snaktype: "value",
                      property: "P31",
                      datatype: "wikibase-item",
                      datavalue: {
                        type: "wikibase-entityid",
                        value: { "entity-type": "item", id: "Q5" },
                      },
                    },
                  },
                ],
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
          // The statement clause travelled as the search query parameter.
          expect(requests[0]?.params?.srsearch).toContain("haswbstatement");
          // Exactly one enrichment call, with the de-duplicated id.
          const enrich = requests.find((r) => r.params?.action === "wbgetentities");
          expect(enrich?.params?.ids).toBe("Q42");
          return candidates;
        }),
      ),
    );
  });

  it("returns an empty list (no enrichment call) when no item carries the identifier", async () => {
    const { requests, layer } = stubClient({
      "list=search": { body: { query: { search: [] } } },
    });
    const result = await runTest(
      withLookup(layer, (lookup) =>
        lookup.searchByIdentifier({ property: "P214", value: "999999" }),
      ),
    );
    expect(result).toEqual([]);
    expect(requests.some((r) => r.params?.action === "wbgetentities")).toBe(false);
  });

  it("rejects a malformed property id before any request", async () => {
    const { requests, layer } = stubClient({});
    await expectFailureInstanceOf(
      withLookup(layer, (lookup) =>
        lookup.searchByIdentifier({ property: "Q42", value: "113230702" }),
      ),
      InvalidQuery,
    );
    expect(requests).toEqual([]);
  });

  it("drops a matched QID the batched enrichment call didn't return", async () => {
    // haswbstatement matches two QIDs, but the enrichment response only
    // carries one of them (an upstream partial miss for the batch) — the
    // missing one is silently dropped, not treated as an error.
    const { layer } = stubClient({
      "list=search": {
        body: { query: { search: [{ title: "Q42" }, { title: "Q99999999" }] } },
      },
      "action=wbgetentities": {
        body: {
          entities: {
            Q42: { id: "Q42", labels: { en: { language: "en", value: "Douglas Adams" } } },
          },
        },
      },
    });
    const result = await runTest(
      withLookup(layer, (lookup) =>
        lookup.searchByIdentifier({ property: "P214", value: "113230702" }),
      ),
    );
    expect(result).toEqual([
      { qid: "Q42", label: "Douglas Adams", description: null, instanceOf: [] },
    ]);
  });

  it("caps the matched QIDs at MAX_CANDIDATES and de-duplicates titles", async () => {
    // 25 distinct titles plus a repeat of the first — de-duplication and the
    // MAX_CANDIDATES(20) cap both apply before any enrichment call is built.
    const hits = Array.from({ length: 25 }, (_, i) => ({ title: `Q${i + 1}` }));
    hits.push({ title: "Q1" });
    const { requests, layer } = stubClient({
      "list=search": { body: { query: { search: hits } } },
      "action=wbgetentities": { body: { entities: {} } },
    });
    await runTest(
      withLookup(layer, (lookup) =>
        lookup.searchByIdentifier({ property: "P214", value: "113230702" }),
      ),
    );
    const enrich = requests.find((r) => r.params?.action === "wbgetentities");
    const ids = (enrich?.params?.ids ?? "").split("|");
    expect(ids).toHaveLength(20);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it("skips a P31 statement whose main snak carries no value (somevalue/novalue)", async () => {
    const { layer } = stubClient({
      "list=search": { body: { query: { search: [{ title: "Q42" }] } } },
      "action=wbgetentities": {
        body: {
          entities: {
            Q42: {
              id: "Q42",
              claims: {
                P31: [
                  // A "no value recorded" snak — no `.value` to read.
                  {
                    mainsnak: { snaktype: "somevalue", property: "P31", datatype: "wikibase-item" },
                  },
                  {
                    mainsnak: {
                      snaktype: "value",
                      property: "P31",
                      datatype: "wikibase-item",
                      datavalue: {
                        type: "wikibase-entityid",
                        value: { "entity-type": "item", id: "Q5" },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    });
    const result = await runTest(
      withLookup(layer, (lookup) =>
        lookup.searchByIdentifier({ property: "P214", value: "113230702" }),
      ),
    );
    // Only the real value snak's instance-of survives.
    expect(result[0]?.instanceOf).toEqual(["Q5"]);
  });

  it("rejects an identifier value that would inject a second statement", async () => {
    const { requests, layer } = stubClient({});
    await expectFailureInstanceOf(
      withLookup(layer, (lookup) =>
        lookup.searchByIdentifier({ property: "P214", value: "1|haswbstatement:P31=Q5" }),
      ),
      InvalidQuery,
    );
    expect(requests).toEqual([]);
  });

  it("fails with LookupFailed when the enrichment call is invalid at the effect-wikimedia layer", async () => {
    const { layer } = stubClient({
      "list=search": { body: { query: { search: [{ title: "Q42" }] } } },
      "action=wbgetentities": {
        fail: new Core.InvalidRequest({ kind: "entityId", value: "Q42" }),
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
  /** A single `value`-snak external-id claim, for the `sameAs`-authority fixture below. */
  const externalIdClaim = (property: string, value: string) => ({
    mainsnak: {
      snaktype: "value",
      property,
      datatype: "external-id",
      datavalue: { type: "string", value },
    },
  });

  /**
   * A `wbgetentities` wire body for `qid` carrying every curated `sameAs`
   * authority (not just VIAF), a birth date, two images (one accepted, one
   * a hostile filename `normaliseCommonsImage` rejects), and P31 claims.
   */
  const enrichBody = (qid: string) => ({
    entities: {
      [qid]: {
        id: qid,
        claims: {
          P214: [externalIdClaim("P214", "113230702")],
          P213: [externalIdClaim("P213", "0000000121032683")],
          P496: [externalIdClaim("P496", "0000-0002-1825-0097")],
          P244: [externalIdClaim("P244", "n79021164")],
          P227: [externalIdClaim("P227", "118540238")],
          P268: [externalIdClaim("P268", "119008064")],
          P569: [
            {
              mainsnak: {
                snaktype: "value",
                property: "P569",
                datatype: "time",
                datavalue: {
                  type: "time",
                  value: { time: "+1952-03-11T00:00:00Z", precision: 11 },
                },
              },
            },
          ],
          P18: [
            {
              mainsnak: {
                snaktype: "value",
                property: "P18",
                datatype: "commonsMedia",
                datavalue: { type: "string", value: "Douglas adams portrait.jpg" },
              },
            },
            // A hostile filename (`#` would break out of the path segment)
            // — rejected by `normaliseCommonsImage`, dropped silently.
            {
              mainsnak: {
                snaktype: "value",
                property: "P18",
                datatype: "commonsMedia",
                datavalue: { type: "string", value: "evil#name.jpg" },
              },
            },
          ],
          P31: [
            {
              mainsnak: {
                snaktype: "value",
                property: "P31",
                datatype: "wikibase-item",
                datavalue: {
                  type: "wikibase-entityid",
                  value: { "entity-type": "item", id: "Q5" },
                },
              },
            },
          ],
        },
      },
    },
  });

  const enrichEffect = (layer: Layer.Layer<Core.WikimediaClient>, qid: string) =>
    Effect.gen(function* () {
      const lookup = yield* WikidataLookup;
      return yield* lookup.enrich(qid);
    }).pipe(Effect.provide(wikidataLookupClientLayer.pipe(Layer.provide(layer))));

  /**
   * Runs {@link enrichEffect} and asserts a non-null result, narrowing the
   * type once so the assertion bodies below read plain fields instead of
   * repeating `facts?.` on every line.
   */
  const loadFacts = async (
    layer: Layer.Layer<Core.WikimediaClient>,
    qid: string,
  ): Promise<WikidataFacts> => {
    const facts = await runTest(enrichEffect(layer, qid));
    expect(facts).not.toBeNull();
    if (facts === null) throw new Error(`expected facts for ${qid}`);
    return facts;
  };

  it("returns the QID self-link and every curated sameAs authority", async () => {
    const { requests, layer } = stubClient({
      "action=wbgetentities": { body: enrichBody("Q42") },
    });
    const facts = await loadFacts(layer, "Q42");

    expect(facts.qid).toBe("Q42");
    expect(facts.facts).toEqual(
      expect.arrayContaining([
        {
          authority: "wikidata",
          externalId: "Q42",
          externalIri: "http://www.wikidata.org/entity/Q42",
          mappingKind: "exact",
          notes: null,
        },
        {
          authority: "viaf",
          externalId: "113230702",
          externalIri: "https://viaf.org/viaf/113230702",
          mappingKind: "exact",
          notes: null,
        },
        // Every other curated `sameAs` authority — not just VIAF.
        {
          authority: "isni",
          externalId: "0000000121032683",
          externalIri: "https://isni.org/isni/0000000121032683",
          mappingKind: "exact",
          notes: null,
        },
        {
          authority: "orcid",
          externalId: "0000-0002-1825-0097",
          externalIri: "https://orcid.org/0000-0002-1825-0097",
          mappingKind: "exact",
          notes: null,
        },
        {
          authority: "lccn",
          externalId: "n79021164",
          externalIri: "https://id.loc.gov/authorities/names/n79021164",
          mappingKind: "exact",
          notes: null,
        },
        {
          authority: "gnd",
          externalId: "118540238",
          externalIri: "https://d-nb.info/gnd/118540238",
          mappingKind: "exact",
          notes: null,
        },
        {
          authority: "bnf",
          externalId: "119008064",
          externalIri: "https://catalogue.bnf.fr/ark:/12148/cb119008064",
          mappingKind: "exact",
          notes: null,
        },
      ]),
    );
    // The request targeted the fixed wbgetentities endpoint for the QID.
    expect(
      requests.some((r) => r.params?.action === "wbgetentities" && r.params?.ids === "Q42"),
    ).toBe(true);
  });

  it("returns the birth-date fact", async () => {
    const { layer } = stubClient({ "action=wbgetentities": { body: enrichBody("Q42") } });
    const facts = await loadFacts(layer, "Q42");

    expect(facts.facts).toContainEqual({
      authority: "wikidata",
      externalId: "1952-03-11T00:00:00Z",
      externalIri: "http://www.wikidata.org/entity/P569",
      mappingKind: "equivalent",
      notes: "date of birth",
    });
  });

  it("returns only the accepted image fact, dropping a hostile filename", async () => {
    const { layer } = stubClient({ "action=wbgetentities": { body: enrichBody("Q42") } });
    const facts = await loadFacts(layer, "Q42");

    const images = facts.facts.filter((f) => f.authority === "wikimedia-commons");
    // The second P18 claim's hostile filename (`#`) was rejected, not
    // stored as a second image fact.
    expect(images).toEqual([
      {
        authority: "wikimedia-commons",
        externalId: "Douglas adams portrait.jpg",
        externalIri:
          "https://commons.wikimedia.org/wiki/Special:FilePath/Douglas%20adams%20portrait.jpg",
        mappingKind: "equivalent",
        notes: "image",
      },
    ]);
  });

  it("drops a hostile external-id value and an out-of-shape date, keeping the QID link", async () => {
    const { layer } = stubClient({
      "action=wbgetentities": {
        body: {
          entities: {
            Q1: {
              id: "Q1",
              claims: {
                // `|` would smuggle a second statement clause — rejected.
                P214: [
                  {
                    mainsnak: {
                      snaktype: "value",
                      property: "P214",
                      datatype: "external-id",
                      datavalue: { type: "string", value: "123|P31=Q5" },
                    },
                  },
                ],
                // Not a Wikidata time shape — rejected.
                P569: [
                  {
                    mainsnak: {
                      snaktype: "value",
                      property: "P569",
                      datatype: "time",
                      datavalue: { type: "time", value: { time: "yesterday" } },
                    },
                  },
                ],
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
    const { layer } = stubClient({
      "action=wbgetentities": { body: { entities: {} } },
    });
    expect(await runTest(enrichEffect(layer, "Q9999999"))).toBeNull();
  });

  it("returns null for Wikidata's `missing` sentinel (a non-existent QID)", async () => {
    // `wbgetentities` returns a non-existent item keyed under its QID as
    // `{ id, missing: "" }` — the key is present but the item does not exist.
    const { layer } = stubClient({
      "action=wbgetentities": {
        body: { entities: { Q9999999: { id: "Q9999999", missing: "" } } },
      },
    });
    expect(await runTest(enrichEffect(layer, "Q9999999"))).toBeNull();
  });

  it("rejects a non-QID before any request", async () => {
    const { requests, layer } = stubClient({});
    await expectFailureInstanceOf(enrichEffect(layer, "not-a-qid"), InvalidQuery);
    expect(requests).toHaveLength(0);
  });

  it("fails with LookupFailed on an upstream transport fault", async () => {
    const { layer } = stubClient({
      "action=wbgetentities": {
        fail: new Core.RequestFailed({ description: "wikidata returned HTTP 502" }),
      },
    });
    await expectFailureInstanceOf(enrichEffect(layer, "Q42"), LookupFailed);
  });
});
