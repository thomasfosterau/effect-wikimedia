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

import * as Struct from "effect/Struct";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it, layer } from "@effect/vitest";
import { assertInstanceOf } from "@effect/vitest/utils";
import { describe, expect, expectTypeOf } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
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
function routeKeyFor(request: Core.WikimediaRequest): Option.Option<string> {
  if (request.params?.list === "search") return Option.some("list=search");
  if (request.params?.action === "wbsearchentities") return Option.some("action=wbsearchentities");
  if (request.params?.action === "wbgetentities") return Option.some("action=wbgetentities");
  return Option.none();
}

/** The routes the stub client answers and the requests it records, for one test. */
interface StubState {
  readonly routes: Record<string, StubRoute>;
  readonly requests: Core.WikimediaRequest[];
}

/**
 * The stub state of the running test. The lookup resolves its
 * `Core.WikimediaClient` once, when its layer is built, so every test in a
 * block shares one stub client (`stubLookupLayer`); the client reads the
 * routes from the requesting fiber, where `stubClient`'s `provideStub` set
 * them.
 */
const CurrentStub = Context.Reference<StubState>("tests/lookup/CurrentStub", {
  defaultValue: () => ({ routes: {}, requests: [] }),
});

/**
 * A stub `Core.WikimediaClient` that dispatches by route key (see
 * {@link routeKeyFor}) over the running test's {@link CurrentStub},
 * recording every request. An unmatched request answers an empty body (a
 * clean "no results").
 */
const stubWikimediaClient = Layer.succeed(Core.WikimediaClient, {
  getJson: Effect.fn("stubWikimediaClient.getJson")(function* <S extends Schema.Top>(
    request: Core.WikimediaRequest,
    schema: S,
  ) {
    const { routes, requests } = yield* CurrentStub;
    requests.push(request);
    const route = Option.getOrUndefined(
      Option.flatMap(routeKeyFor(request), (key) => R.get(routes, key)),
    );
    if (route?.fail) return yield* route.fail;
    // Decode the wire-shaped body with the caller's schema, as the real client does.
    return yield* Schema.decodeUnknownEffect(schema)(route?.body ?? {}).pipe(
      Effect.mapError((error) => new Core.RequestFailed({ description: String(error) })),
    );
  }),
  getText: () => Effect.fail(new Core.RequestFailed({ description: "getText not stubbed" })),
});

/** The real `WikidataLookup` over {@link stubWikimediaClient}, shared by each block below. */
const stubLookupLayer = wikidataLookupClientLayer.pipe(Layer.provide(stubWikimediaClient));

/**
 * Stubs the routes for one test: `provideStub` installs them (see
 * {@link CurrentStub}) and `requests` records every request made under it.
 */
function stubClient(routes: Record<string, StubRoute>) {
  const requests: Core.WikimediaRequest[] = [];
  return { requests, provideStub: Effect.provideService(CurrentStub, { routes, requests }) };
}

type ProvideStub = ReturnType<typeof stubClient>["provideStub"];

type Result = readonly WikidataCandidate[];

const withLookup = (
  provideStub: ProvideStub,
  use: (lookup: {
    readonly searchByLabel: (label: string) => Effect.Effect<Result, LookupError>;
    readonly searchByIdentifier: (id: ExternalIdentifier) => Effect.Effect<Result, LookupError>;
  }) => Effect.Effect<Result, LookupError>,
): Effect.Effect<Result, LookupError, WikidataLookup> =>
  Effect.gen(function* () {
    const lookup = yield* WikidataLookup;
    return yield* use(lookup);
  }).pipe(provideStub);

// ── Service key ──────────────────────────────────────────────────────

describe("WikidataLookup", () => {
  it("is keyed in the package's namespace, like Core.WikimediaClient", () => {
    // The key is public: a consumer providing the service by raw key string
    // depends on it, so changing it is a breaking change (#19).
    expect(WikidataLookup.key).toBe("effect-wikimedia/WikidataLookup");
  });
});

// ── Label search ─────────────────────────────────────────────────────

layer(stubLookupLayer)("WikidataLookup.searchByLabel", (it) => {
  it.effect("parses candidates and collapses whitespace in the fields", () => {
    const { requests, provideStub } = stubClient({
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

    return withLookup(provideStub, (lookup) => lookup.searchByLabel("Douglas Adams")).pipe(
      Effect.map((candidates) => {
        expect(candidates).toEqual([
          {
            qid: "Q42",
            label: Option.some("Douglas Adams"),
            description: Option.some("British writer (1952–2001)"),
            instanceOf: [],
          },
        ]);
        // The label travelled as the search query parameter.
        expect(requests[0]?.params?.search).toBe("Douglas Adams");
        return candidates;
      }),
    );
  });

  it.effect("returns an empty list when Wikidata has no matches", () =>
    Effect.gen(function* () {
      const { provideStub } = stubClient({
        "action=wbsearchentities": { body: { search: [] } },
      });
      const result = yield* withLookup(provideStub, (lookup) => lookup.searchByLabel("zzz"));
      expect(result).toEqual([]);
    }),
  );

  it.effect("drops a non-item entity id effect-wikimedia accepts but this policy does not", () =>
    Effect.gen(function* () {
      // "P31" is a well-formed *property* id — effect-wikimedia's own
      // `wbsearchentities` normaliser accepts any Q/P/L entity id and lets it
      // through. This layer's candidates are always item QIDs, so
      // `hitToCandidate` re-validates with its own `normaliseQid` and drops it
      // — a defensive check independent of the general package's typing.
      const { provideStub } = stubClient({
        "action=wbsearchentities": {
          body: { search: [{ id: "P31", label: "instance of" }] },
        },
      });
      const result = yield* withLookup(provideStub, (lookup) => lookup.searchByLabel("instance"));
      expect(result).toEqual([]);
    }),
  );

  it.effect("rejects a blank label before any request", () =>
    Effect.gen(function* () {
      const { requests, provideStub } = stubClient({});
      assertInstanceOf(
        yield* Effect.flip(withLookup(provideStub, (lookup) => lookup.searchByLabel("   "))),
        InvalidQuery,
      );
      expect(requests).toEqual([]);
    }),
  );

  it.effect("fails with LookupFailed on an upstream transport fault", () =>
    Effect.gen(function* () {
      const { provideStub } = stubClient({
        "action=wbsearchentities": {
          fail: new Core.RequestFailed({ description: "wikidata returned HTTP 503" }),
        },
      });
      assertInstanceOf(
        yield* Effect.flip(
          withLookup(provideStub, (lookup) => lookup.searchByLabel("Douglas Adams")),
        ),
        LookupFailed,
      );
    }),
  );

  it.effect("fails with LookupFailed when the upstream is rate-limited", () =>
    Effect.gen(function* () {
      const { provideStub } = stubClient({
        "action=wbsearchentities": { fail: new Core.RateLimited({ retryAfterSeconds: 5 }) },
      });
      const failure = yield* Effect.flip(
        withLookup(provideStub, (lookup) => lookup.searchByLabel("Douglas Adams")),
      );
      assertInstanceOf(failure, LookupFailed);
      expect(failure).toMatchObject({
        _tag: "LookupFailed",
        description: expect.stringContaining("rate-limited"),
      });
    }),
  );
});

// ── Identifier search ────────────────────────────────────────────────

layer(stubLookupLayer)("WikidataLookup.searchByIdentifier", (it) => {
  it.effect("matches via haswbstatement then enriches via wbgetentities", () => {
    const { requests, provideStub } = stubClient({
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

    return withLookup(provideStub, (lookup) =>
      lookup.searchByIdentifier({ property: "P214", value: "113230702" }),
    ).pipe(
      Effect.map((candidates) => {
        expect(candidates).toEqual([
          {
            qid: "Q42",
            label: Option.some("Douglas Adams"),
            description: Option.some("British writer"),
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
    );
  });

  it.effect("returns an empty list (no enrichment call) when no item carries the identifier", () =>
    Effect.gen(function* () {
      const { requests, provideStub } = stubClient({
        "list=search": { body: { query: { search: [] } } },
      });
      const result = yield* withLookup(provideStub, (lookup) =>
        lookup.searchByIdentifier({ property: "P214", value: "999999" }),
      );
      expect(result).toEqual([]);
      expect(requests.some((r) => r.params?.action === "wbgetentities")).toBe(false);
    }),
  );

  it.effect("rejects a malformed property id before any request", () =>
    Effect.gen(function* () {
      const { requests, provideStub } = stubClient({});
      assertInstanceOf(
        yield* Effect.flip(
          withLookup(provideStub, (lookup) =>
            lookup.searchByIdentifier({ property: "Q42", value: "113230702" }),
          ),
        ),
        InvalidQuery,
      );
      expect(requests).toEqual([]);
    }),
  );

  it.effect("drops a matched QID the batched enrichment call didn't return", () =>
    Effect.gen(function* () {
      // haswbstatement matches two QIDs, but the enrichment response only
      // carries one of them (an upstream partial miss for the batch) — the
      // missing one is silently dropped, not treated as an error.
      const { provideStub } = stubClient({
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
      const result = yield* withLookup(provideStub, (lookup) =>
        lookup.searchByIdentifier({ property: "P214", value: "113230702" }),
      );
      expect(result).toEqual([
        {
          qid: "Q42",
          label: Option.some("Douglas Adams"),
          description: Option.none(),
          instanceOf: [],
        },
      ]);
    }),
  );

  it.effect("caps the matched QIDs at MAX_CANDIDATES and de-duplicates titles", () =>
    Effect.gen(function* () {
      // 25 distinct titles plus a repeat of the first — de-duplication and the
      // MAX_CANDIDATES(20) cap both apply before any enrichment call is built.
      const hits = Array.from({ length: 25 }, (_, i) => ({ title: `Q${i + 1}` }));
      hits.push({ title: "Q1" });
      const { requests, provideStub } = stubClient({
        "list=search": { body: { query: { search: hits } } },
        "action=wbgetentities": { body: { entities: {} } },
      });
      yield* withLookup(provideStub, (lookup) =>
        lookup.searchByIdentifier({ property: "P214", value: "113230702" }),
      );
      const enrich = requests.find((r) => r.params?.action === "wbgetentities");
      const ids = (enrich?.params?.ids ?? "").split("|");
      expect(ids).toHaveLength(20);
      expect(ids).toEqual(Arr.dedupe(ids));
    }),
  );

  it.effect("skips a P31 statement whose main snak carries no value (somevalue/novalue)", () =>
    Effect.gen(function* () {
      const { provideStub } = stubClient({
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
                      mainsnak: {
                        snaktype: "somevalue",
                        property: "P31",
                        datatype: "wikibase-item",
                      },
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
      const result = yield* withLookup(provideStub, (lookup) =>
        lookup.searchByIdentifier({ property: "P214", value: "113230702" }),
      );
      // Only the real value snak's instance-of survives.
      expect(result[0]?.instanceOf).toEqual(["Q5"]);
    }),
  );

  it.effect("rejects an identifier value that would inject a second statement", () =>
    Effect.gen(function* () {
      const { requests, provideStub } = stubClient({});
      assertInstanceOf(
        yield* Effect.flip(
          withLookup(provideStub, (lookup) =>
            lookup.searchByIdentifier({ property: "P214", value: "1|haswbstatement:P31=Q5" }),
          ),
        ),
        InvalidQuery,
      );
      expect(requests).toEqual([]);
    }),
  );

  it.effect(
    "fails with LookupFailed when the enrichment call is invalid at the effect-wikimedia layer",
    () =>
      Effect.gen(function* () {
        const { provideStub } = stubClient({
          "list=search": { body: { query: { search: [{ title: "Q42" }] } } },
          "action=wbgetentities": {
            fail: new Core.InvalidRequest({ kind: "entityId", value: "Q42" }),
          },
        });
        assertInstanceOf(
          yield* Effect.flip(
            withLookup(provideStub, (lookup) =>
              lookup.searchByIdentifier({ property: "P214", value: "113230702" }),
            ),
          ),
          LookupFailed,
        );
      }),
  );
});

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

/** Runs `WikidataLookup.enrich` for `qid` through `provideStub`. */
const enrichEffect = (provideStub: ProvideStub, qid: string) =>
  Effect.gen(function* () {
    const lookup = yield* WikidataLookup;
    return yield* lookup.enrich(qid);
  }).pipe(provideStub);

/**
 * Runs {@link enrichEffect} and asserts a non-null result, narrowing the
 * type once so the assertion bodies below read plain fields instead of
 * repeating `facts?.` on every line.
 */
const loadFacts = (
  provideStub: ProvideStub,
  qid: string,
): Effect.Effect<WikidataFacts, LookupError, WikidataLookup> =>
  Effect.map(enrichEffect(provideStub, qid), (facts) =>
    Option.getOrElse(facts, () => expect.unreachable(`expected facts for ${qid}`)),
  );

/** A `P569` time claim carrying `calendarmodel`. */
const calendarTimeClaim = (calendarmodel?: string | number) => ({
  mainsnak: {
    snaktype: "value",
    property: "P569",
    datatype: "time",
    datavalue: {
      type: "time",
      // `calendarTimeClaim()` omits the key rather than sending `undefined`.
      value: R.filter(
        { time: "+1452-04-15T00:00:00Z", precision: 11, calendarmodel },
        P.isNotUndefined,
      ),
    },
  },
});

/** A `P569` time claim carrying `precision`. */
const precisionTimeClaim = (precision?: number) => ({
  mainsnak: {
    snaktype: "value",
    property: "P569",
    datatype: "time",
    datavalue: {
      type: "time",
      // `precisionTimeClaim()` omits the key rather than sending `undefined`.
      value: R.filter({ time: "+1952-00-00T00:00:00Z", precision }, P.isNotUndefined),
    },
  },
});

layer(stubLookupLayer)("WikidataLookup.enrich", (it) => {
  it.effect("returns the item fact first, then every curated authority as an Identifier fact", () =>
    Effect.gen(function* () {
      const { requests, provideStub } = stubClient({
        "action=wbgetentities": { body: enrichBody("Q42") },
      });
      const facts = yield* loadFacts(provideStub, "Q42");

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
    }),
  );

  it.effect("returns the birth date as a Date fact with its label, precision and calendar", () =>
    Effect.gen(function* () {
      const { provideStub } = stubClient({ "action=wbgetentities": { body: enrichBody("Q42") } });
      const facts = yield* loadFacts(provideStub, "Q42");

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
    }),
  );

  it.effect("reads the calendar from the recorded Q42 fixture's calendar model", () =>
    Effect.gen(function* () {
      const { provideStub } = stubClient({ "action=wbgetentities": { body: q42Fixture } });
      const facts = yield* loadFacts(provideStub, "Q42");

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
    }),
  );

  it.effect("maps the calendar model to gregorian, julian or null", () =>
    Effect.gen(function* () {
      const { provideStub } = stubClient({
        "action=wbgetentities": {
          body: {
            entities: {
              Q1: {
                id: "Q1",
                claims: {
                  P569: [
                    // Proleptic Gregorian and proleptic Julian, as Wikibase
                    // spells them (its `http` concept URI)…
                    calendarTimeClaim("http://www.wikidata.org/entity/Q1985727"),
                    calendarTimeClaim("http://www.wikidata.org/entity/Q1985786"),
                    // …and as `https` entity IRIs.
                    calendarTimeClaim("https://www.wikidata.org/entity/Q1985727"),
                    calendarTimeClaim("https://www.wikidata.org/entity/Q1985786"),
                    // No calendar model at all.
                    calendarTimeClaim(),
                    // Another entity (Q12138, the non-proleptic Gregorian
                    // calendar item), a bare QID, another host, a page URL,
                    // and a non-string.
                    calendarTimeClaim("http://www.wikidata.org/entity/Q12138"),
                    calendarTimeClaim("Q1985727"),
                    calendarTimeClaim("http://test.wikidata.org/entity/Q1985727"),
                    calendarTimeClaim("https://www.wikidata.org/wiki/Q1985786"),
                    calendarTimeClaim(1985727),
                  ],
                },
              },
            },
          },
        },
      });
      const facts = yield* loadFacts(provideStub, "Q1");
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
    }),
  );

  it.effect("reports a missing or out-of-range precision as null", () =>
    Effect.gen(function* () {
      const { provideStub } = stubClient({
        "action=wbgetentities": {
          body: {
            entities: {
              Q1: {
                id: "Q1",
                claims: {
                  P569: [
                    precisionTimeClaim(9),
                    precisionTimeClaim(),
                    precisionTimeClaim(15),
                    precisionTimeClaim(9.5),
                    precisionTimeClaim(-1),
                  ],
                },
              },
            },
          },
        },
      });
      const facts = yield* loadFacts(provideStub, "Q1");
      expect(facts.facts.filter(WikidataFact.guards.Date).map((fact) => fact.precision)).toEqual([
        9,
        null,
        null,
        null,
        null,
      ]);
    }),
  );

  it.effect("returns only the accepted Image fact, dropping a hostile filename", () =>
    Effect.gen(function* () {
      const { provideStub } = stubClient({ "action=wbgetentities": { body: enrichBody("Q42") } });
      const facts = yield* loadFacts(provideStub, "Q42");

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
    }),
  );

  it.effect("returns facts in kind order, each decoding against the WikidataFact schema", () =>
    Effect.gen(function* () {
      const { provideStub } = stubClient({ "action=wbgetentities": { body: enrichBody("Q42") } });
      const facts = yield* loadFacts(provideStub, "Q42");

      expect(facts.facts.map((fact) => Struct.get(fact, "_tag"))).toEqual([
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
    }),
  );

  it.effect("carries no website mapping-table fields (mappingKind, notes)", () =>
    Effect.gen(function* () {
      const { provideStub } = stubClient({ "action=wbgetentities": { body: enrichBody("Q42") } });
      const facts = yield* loadFacts(provideStub, "Q42");
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
    }),
  );

  it.effect(
    "drops a hostile external-id value and an out-of-shape date, keeping the QID link",
    () =>
      Effect.gen(function* () {
        const { provideStub } = stubClient({
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
        const facts = yield* enrichEffect(provideStub, "Q1");
        // Only the QID self-link survives.
        expect(Option.map(facts, (f) => f.facts)).toEqual(
          Option.some([{ _tag: "Item", qid: "Q1", iri: "http://www.wikidata.org/entity/Q1" }]),
        );
      }),
  );

  it.effect("drops an external-id value that would escape its authority's IRI path", () =>
    Effect.gen(function* () {
      const { provideStub } = stubClient({
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
      const facts = yield* loadFacts(provideStub, "Q1");
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
    }),
  );

  it.effect("succeeds with None when the item is absent upstream", () =>
    Effect.gen(function* () {
      const { provideStub } = stubClient({
        "action=wbgetentities": { body: { entities: {} } },
      });
      expect(yield* enrichEffect(provideStub, "Q9999999")).toEqual(Option.none());
    }),
  );

  it.effect("succeeds with None for Wikidata's `missing` sentinel (a non-existent QID)", () =>
    Effect.gen(function* () {
      // `wbgetentities` returns a non-existent item keyed under its QID as
      // `{ id, missing: "" }` — the key is present but the item does not exist.
      const { provideStub } = stubClient({
        "action=wbgetentities": {
          body: { entities: { Q9999999: { id: "Q9999999", missing: "" } } },
        },
      });
      expect(yield* enrichEffect(provideStub, "Q9999999")).toEqual(Option.none());
    }),
  );

  it.effect("rejects a non-QID before any request", () =>
    Effect.gen(function* () {
      const { requests, provideStub } = stubClient({});
      assertInstanceOf(yield* Effect.flip(enrichEffect(provideStub, "not-a-qid")), InvalidQuery);
      expect(requests).toHaveLength(0);
    }),
  );

  it.effect("fails with LookupFailed on an upstream transport fault", () =>
    Effect.gen(function* () {
      const { provideStub } = stubClient({
        "action=wbgetentities": {
          fail: new Core.RequestFailed({ description: "wikidata returned HTTP 502" }),
        },
      });
      assertInstanceOf(yield* Effect.flip(enrichEffect(provideStub, "Q42")), LookupFailed);
    }),
  );
});
