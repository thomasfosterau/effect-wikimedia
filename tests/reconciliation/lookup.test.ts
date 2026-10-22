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
 * - upstream transport / rate-limit / invalid-request faults -> LookupFailed;
 * - enrich facts, including a date's precision and calendar model.
 *
 * @module tests/lookup
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Core from "../../src/core.ts";
import {
  type DateFact,
  type ExternalIdentifier,
  type IdentifierFact,
  type ImageFact,
  InvalidQuery,
  type ItemFact,
  type LookupError,
  LookupFailed,
  type WikidataCandidate,
  WikidataFact,
  type WikidataFacts,
  WikidataLookup,
  wikidataLookupClientLayer,
} from "../../src/reconciliation/index.ts";
import { expectFailureInstanceOf, runTest } from "../helpers/effect.ts";

/** The recorded `wbgetentities` body for Q42 (Douglas Adams), as the wire carries it. */
const q42Fixture = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
  readFileSync(fileURLToPath(new URL("../fixtures/wikidata-q42.json", import.meta.url)), "utf8"),
);

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

// ── Service key ──────────────────────────────────────────────────────

describe("WikidataLookup", () => {
  it("is keyed in the package's namespace, like Core.WikimediaClient", () => {
    // The key is public: a consumer providing the service by raw key string
    // depends on it, so changing it is a breaking change (#19).
    expect(WikidataLookup.key).toBe("effect-wikimedia/WikidataLookup");
  });
});

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
    const failure = await expectFailureInstanceOf(
      withLookup(layer, (lookup) => lookup.searchByLabel("Douglas Adams")),
      LookupFailed,
    );
    expect(failure).toMatchObject({
      _tag: "LookupFailed",
      description: expect.stringContaining("rate-limited"),
    });
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
    expect(ids).toEqual(Arr.dedupe(ids));
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
                  value: {
                    time: "+1952-03-11T00:00:00Z",
                    precision: 11,
                    calendarmodel: "http://www.wikidata.org/entity/Q1985727",
                  },
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
    return facts ?? expect.unreachable(`expected facts for ${qid}`);
  };

  it("returns the item fact first, then every curated authority as an Identifier fact", async () => {
    const { requests, layer } = stubClient({
      "action=wbgetentities": { body: enrichBody("Q42") },
    });
    const facts = await loadFacts(layer, "Q42");

    expect(facts.qid).toBe("Q42");
    expect(facts.facts[0]).toEqual({
      _tag: "Item",
      qid: "Q42",
      iri: "http://www.wikidata.org/entity/Q42",
    });
    // Every curated authority — not just VIAF — in `EXTERNAL_ID_AUTHORITIES` order.
    expect(facts.facts.filter(WikidataFact.guards.Identifier)).toEqual([
      {
        _tag: "Identifier",
        property: "P214",
        authority: "viaf",
        value: "113230702",
        iri: "https://viaf.org/viaf/113230702",
      },
      {
        _tag: "Identifier",
        property: "P213",
        authority: "isni",
        value: "0000000121032683",
        iri: "https://isni.org/isni/0000000121032683",
      },
      {
        _tag: "Identifier",
        property: "P496",
        authority: "orcid",
        value: "0000-0002-1825-0097",
        iri: "https://orcid.org/0000-0002-1825-0097",
      },
      {
        _tag: "Identifier",
        property: "P244",
        authority: "lccn",
        value: "n79021164",
        iri: "https://id.loc.gov/authorities/names/n79021164",
      },
      {
        _tag: "Identifier",
        property: "P227",
        authority: "gnd",
        value: "118540238",
        iri: "https://d-nb.info/gnd/118540238",
      },
      {
        _tag: "Identifier",
        property: "P268",
        authority: "bnf",
        value: "119008064",
        iri: "https://catalogue.bnf.fr/ark:/12148/cb119008064",
      },
    ]);
    // The request targeted the fixed wbgetentities endpoint for the QID.
    expect(
      requests.some((r) => r.params?.action === "wbgetentities" && r.params?.ids === "Q42"),
    ).toBe(true);
  });

  it("returns the birth date as a Date fact with its label, precision and calendar", async () => {
    const { layer } = stubClient({ "action=wbgetentities": { body: enrichBody("Q42") } });
    const facts = await loadFacts(layer, "Q42");

    expect(facts.facts.filter(WikidataFact.guards.Date)).toEqual([
      {
        _tag: "Date",
        property: "P569",
        label: "date of birth",
        time: "1952-03-11T00:00:00Z",
        precision: 11,
        calendar: "gregorian",
      },
    ]);
  });

  it("reads the calendar from the recorded Q42 fixture's calendar model", async () => {
    const { layer } = stubClient({ "action=wbgetentities": { body: q42Fixture } });
    const facts = await loadFacts(layer, "Q42");

    // The recorded P569 carries `http://www.wikidata.org/entity/Q1985727`.
    expect(facts.facts.filter(WikidataFact.guards.Date)).toEqual([
      {
        _tag: "Date",
        property: "P569",
        label: "date of birth",
        time: "1952-03-11T00:00:00Z",
        precision: 11,
        calendar: "gregorian",
      },
    ]);
  });

  it("maps the calendar model to gregorian, julian or null", async () => {
    const timeClaim = (calendarmodel: unknown) => ({
      mainsnak: {
        snaktype: "value",
        property: "P569",
        datatype: "time",
        datavalue: {
          type: "time",
          // `timeClaim(undefined)` omits the key rather than sending `undefined`.
          value: Record.filter(
            { time: "+1452-04-15T00:00:00Z", precision: 11, calendarmodel },
            Predicate.isNotUndefined,
          ),
        },
      },
    });
    const { layer } = stubClient({
      "action=wbgetentities": {
        body: {
          entities: {
            Q1: {
              id: "Q1",
              claims: {
                P569: [
                  // Proleptic Gregorian and proleptic Julian, as Wikibase
                  // spells them (its `http` concept URI)…
                  timeClaim("http://www.wikidata.org/entity/Q1985727"),
                  timeClaim("http://www.wikidata.org/entity/Q1985786"),
                  // …and as `https` entity IRIs.
                  timeClaim("https://www.wikidata.org/entity/Q1985727"),
                  timeClaim("https://www.wikidata.org/entity/Q1985786"),
                  // No calendar model at all.
                  timeClaim(undefined),
                  // Another entity (Q12138, the non-proleptic Gregorian
                  // calendar item), a bare QID, another host, a page URL,
                  // and a non-string.
                  timeClaim("http://www.wikidata.org/entity/Q12138"),
                  timeClaim("Q1985727"),
                  timeClaim("http://test.wikidata.org/entity/Q1985727"),
                  timeClaim("https://www.wikidata.org/wiki/Q1985786"),
                  timeClaim(1985727),
                ],
              },
            },
          },
        },
      },
    });
    const facts = await loadFacts(layer, "Q1");
    expect(facts.facts.filter(WikidataFact.guards.Date).map((fact) => fact.calendar)).toEqual([
      "gregorian",
      "julian",
      "gregorian",
      "julian",
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("reports a missing or out-of-range precision as null", async () => {
    const timeClaim = (precision: unknown) => ({
      mainsnak: {
        snaktype: "value",
        property: "P569",
        datatype: "time",
        datavalue: {
          type: "time",
          // `timeClaim(undefined)` omits the key rather than sending `undefined`.
          value: Record.filter(
            { time: "+1952-00-00T00:00:00Z", precision },
            Predicate.isNotUndefined,
          ),
        },
      },
    });
    const { layer } = stubClient({
      "action=wbgetentities": {
        body: {
          entities: {
            Q1: {
              id: "Q1",
              claims: {
                P569: [
                  timeClaim(9),
                  timeClaim(undefined),
                  timeClaim(15),
                  timeClaim(9.5),
                  timeClaim(-1),
                ],
              },
            },
          },
        },
      },
    });
    const facts = await loadFacts(layer, "Q1");
    expect(facts.facts.filter(WikidataFact.guards.Date).map((fact) => fact.precision)).toEqual([
      9,
      null,
      null,
      null,
      null,
    ]);
  });

  it("returns only the accepted Image fact, dropping a hostile filename", async () => {
    const { layer } = stubClient({ "action=wbgetentities": { body: enrichBody("Q42") } });
    const facts = await loadFacts(layer, "Q42");

    // The second P18 claim's hostile filename (`#`) was rejected, not
    // returned as a second image fact.
    expect(facts.facts.filter(WikidataFact.guards.Image)).toEqual([
      {
        _tag: "Image",
        property: "P18",
        filename: "Douglas adams portrait.jpg",
        iri: "https://commons.wikimedia.org/wiki/Special:FilePath/Douglas%20adams%20portrait.jpg",
      },
    ]);
  });

  it("returns facts in kind order, each decoding against the WikidataFact schema", async () => {
    const { layer } = stubClient({ "action=wbgetentities": { body: enrichBody("Q42") } });
    const facts = await loadFacts(layer, "Q42");

    expect(facts.facts.map((fact) => fact._tag)).toEqual([
      "Item",
      ...Array.from({ length: 6 }, () => "Identifier"),
      "Date",
      "Image",
    ]);
    Arr.forEach(facts.facts, (fact) => {
      expect(Schema.decodeSync(WikidataFact)(fact)).toEqual(fact);
    });
    // `match` is exhaustive over the four kinds.
    const describeFact = WikidataFact.match({
      Item: (fact) => `item ${fact.qid}`,
      Identifier: (fact) => `${fact.authority} ${fact.value}`,
      Date: (fact) => `${fact.label} ${fact.time}`,
      Image: (fact) => `image ${fact.filename}`,
    });
    expect(facts.facts.map(describeFact).slice(-2)).toEqual([
      "date of birth 1952-03-11T00:00:00Z",
      "image Douglas adams portrait.jpg",
    ]);
  });

  it("carries no website mapping-table fields (mappingKind, notes)", async () => {
    const { layer } = stubClient({ "action=wbgetentities": { body: enrichBody("Q42") } });
    const facts = await loadFacts(layer, "Q42");
    Arr.forEach(facts.facts, (fact) => {
      expect(fact).not.toHaveProperty("mappingKind");
      expect(fact).not.toHaveProperty("notes");
    });
    // Type level: no variant of the union declares either field.
    expectTypeOf<
      Extract<
        keyof ItemFact | keyof IdentifierFact | keyof DateFact | keyof ImageFact,
        "mappingKind" | "notes"
      >
    >().toEqualTypeOf<never>();
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
    expect(facts?.facts).toEqual([
      { _tag: "Item", qid: "Q1", iri: "http://www.wikidata.org/entity/Q1" },
    ]);
  });

  it("drops an external-id value that would escape its authority's IRI path", async () => {
    const { layer } = stubClient({
      "action=wbgetentities": {
        body: {
          entities: {
            Q1: {
              id: "Q1",
              claims: {
                // Passes `normaliseExternalIdValue` (`.` and `/` are allowed
                // for the search clause) but would build
                // `https://viaf.org/viaf/../../x`, i.e. `https://viaf.org/x`.
                P214: [externalIdClaim("P214", "../../x")],
                P496: [externalIdClaim("P496", "..")],
                P213: [externalIdClaim("P213", "0000 0001 2103 2683")],
              },
            },
          },
        },
      },
    });
    const facts = await loadFacts(layer, "Q1");
    // The QID self-link and the well-formed (spaced) ISNI survive.
    expect(facts.facts).toEqual([
      { _tag: "Item", qid: "Q1", iri: "http://www.wikidata.org/entity/Q1" },
      {
        _tag: "Identifier",
        property: "P213",
        authority: "isni",
        value: "0000 0001 2103 2683",
        iri: "https://isni.org/isni/0000000121032683",
      },
    ]);
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
