/**
 * Unit tests for the Sparql surface (`src/sparql.ts`): SPARQL JSON result
 * decoding with correct term typing (uri / literal / typed-literal / bnode),
 * the datatype → Wikibase-vocabulary mapping, the LIMIT-enforcing query
 * helper, and WDQS etiquette (host, UA, no `maxlag`). The network is stubbed
 * at `FetchHttpClient.Fetch` — no live network anywhere in this suite.
 *
 * @module tests/sparql
 */

import * as Struct from "effect/Struct";
import * as P from "effect/Predicate";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import { Core, Sparql } from "../src/index.ts";
import { expectFailureInstanceOf, runTest } from "./helpers/effect.ts";

const fixture = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
  readFileSync(fileURLToPath(new URL("./fixtures/wdqs-results.json", import.meta.url)), "utf8"),
);

const stubWdqs = (body: Schema.Json) => {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json(body, { status: 200 });
  };
  const fetchLayer = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  return { requests, layer: Core.wikimediaClientLayer.pipe(Layer.provide(fetchLayer)) };
};

const toEffect = <A, E>(
  layer: Layer.Layer<Core.WikimediaClient>,
  effect: Effect.Effect<A, E, Core.WikimediaClient>,
): Effect.Effect<A, E> => effect.pipe(Effect.provide(layer));

const run = <A, E>(
  layer: Layer.Layer<Core.WikimediaClient>,
  effect: Effect.Effect<A, E, Core.WikimediaClient>,
) => runTest(toEffect(layer, effect));

const SELECT = "SELECT ?item WHERE { ?item wdt:P31 wd:Q5 } LIMIT 10";

/** Narrows a term to a literal, or fails the test. */
const asLiteral = (
  term: Sparql.SparqlTerm | undefined,
): Extract<Sparql.SparqlTerm, { _tag: "literal" }> => {
  if (!P.isTagged(term, "literal"))
    return expect.unreachable(
      `expected a literal, got ${term === undefined ? "nothing" : Struct.get(term, "_tag")}`,
    );
  return term;
};

/** Decodes the recorded WDQS fixture into typed results (row 0, row 1). */
const decodeFixture = async () => {
  const { layer } = stubWdqs(fixture);
  const results = await run(layer, Sparql.query(SELECT));
  return { results, first: results.bindings[0], second: results.bindings[1] };
};

// ── LIMIT discipline ─────────────────────────────────────────────────────

describe("Sparql.hasLimitClause", () => {
  it("detects a LIMIT clause case-insensitively", () => {
    expect(Sparql.hasLimitClause("SELECT ?x WHERE {} LIMIT 5")).toBe(true);
    expect(Sparql.hasLimitClause("select ?x where {} limit 100")).toBe(true);
  });

  it("returns false when there is no LIMIT, or it is only in a comment", () => {
    expect(Sparql.hasLimitClause("SELECT ?x WHERE { ?x ?y ?z }")).toBe(false);
    expect(Sparql.hasLimitClause("SELECT ?x WHERE {} # LIMIT 5")).toBe(false);
    expect(Sparql.hasLimitClause("LIMIT")).toBe(false);
  });
});

describe("Sparql.query — LIMIT enforcement", () => {
  it("rejects an unbounded query before any request", async () => {
    const { requests, layer } = stubWdqs(fixture);
    await expectFailureInstanceOf(
      toEffect(layer, Sparql.query("SELECT ?item WHERE { ?item wdt:P31 wd:Q5 }")),
      Core.InvalidRequest,
    );
    expect(requests).toHaveLength(0);
  });

  it("allows an unbounded query when explicitly opted out", async () => {
    const { requests, layer } = stubWdqs(fixture);
    await run(
      layer,
      Sparql.query("SELECT ?item WHERE { VALUES ?item { wd:Q42 } }", { allowUnbounded: true }),
    );
    expect(requests).toHaveLength(1);
  });

  it("rejects a blank query", async () => {
    const { requests, layer } = stubWdqs(fixture);
    await expectFailureInstanceOf(toEffect(layer, Sparql.query("   ")), Core.InvalidRequest);
    expect(requests).toHaveLength(0);
  });
});

// ── Term typing ──────────────────────────────────────────────────────────

describe("Sparql.query — recorded fixture, term typing", () => {
  it("targets the WDQS endpoint with the polite UA and no maxlag", async () => {
    const { requests, layer } = stubWdqs(fixture);
    await run(layer, Sparql.query(SELECT));
    const request = requests[0];
    expect(request).toBeDefined();
    const url = new URL(request?.url ?? "");
    expect(url.host).toBe(Sparql.WDQS_HOST);
    expect(url.pathname).toBe(Sparql.WDQS_PATH);
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("query")).toBe(SELECT);
    expect(url.searchParams.has("maxlag")).toBe(false);
    expect(request?.headers.get("user-agent")).toBe(Core.USER_AGENT);
  });

  it("decodes the head vars in projection order", async () => {
    const { results } = await decodeFixture();
    expect(results.vars).toEqual([
      "item",
      "itemLabel",
      "dob",
      "height",
      "coord",
      "article",
      "anon",
    ]);
  });

  it("decodes uri and bnode terms", async () => {
    const { first } = await decodeFixture();
    expect(first?.item).toEqual({ _tag: "uri", value: "http://www.wikidata.org/entity/Q42" });
    expect(first?.anon).toMatchObject({ _tag: "bnode" });
  });

  it("decodes a language-tagged literal as monolingualtext", async () => {
    const { first } = await decodeFixture();
    expect(first?.itemLabel).toEqual({
      _tag: "literal",
      value: "Douglas Adams",
      datatype: Option.none(),
      language: Option.some("en"),
      kind: "monolingualtext",
    });
  });

  it("maps xsd-typed literals back to the datavalue vocabulary", async () => {
    const { first } = await decodeFixture();
    const dob = asLiteral(first?.dob);
    expect(dob.kind).toBe("time");
    expect(dob.datatype).toEqual(Option.some("http://www.w3.org/2001/XMLSchema#dateTime"));
    expect(asLiteral(first?.height).kind).toBe("quantity");
    // A non-xsd datatype → "other".
    expect(asLiteral(first?.coord).kind).toBe("other");
  });

  it("decodes a partial binding (untyped literal, missing var)", async () => {
    const { second } = await decodeFixture();
    const label = asLiteral(second?.itemLabel);
    expect(label.kind).toBe("string");
    expect(label.language).toEqual(Option.none());
    expect(second?.dob).toBeUndefined();
  });
});

// ── literalKind mapping ──────────────────────────────────────────────────

describe("Sparql.literalKind", () => {
  const xsd = "http://www.w3.org/2001/XMLSchema#";
  it("maps datatype IRIs back toward the Wikibase datavalue vocabulary", () => {
    expect(Sparql.literalKind(Option.none(), Option.some("en"))).toBe("monolingualtext");
    expect(Sparql.literalKind(Option.some(`${xsd}string`), Option.some("en"))).toBe(
      "monolingualtext",
    );
    expect(Sparql.literalKind(Option.some(`${xsd}dateTime`), Option.none())).toBe("time");
    expect(Sparql.literalKind(Option.some(`${xsd}date`), Option.none())).toBe("time");
    expect(Sparql.literalKind(Option.some(`${xsd}decimal`), Option.none())).toBe("quantity");
    expect(Sparql.literalKind(Option.some(`${xsd}integer`), Option.none())).toBe("quantity");
    expect(Sparql.literalKind(Option.some(`${xsd}string`), Option.none())).toBe("string");
    expect(Sparql.literalKind(Option.none(), Option.none())).toBe("string");
    expect(Sparql.literalKind(Option.some("http://example.com/custom"), Option.none())).toBe(
      "other",
    );
  });
});

// ── Unknown term degrade ─────────────────────────────────────────────────

describe("Sparql.normaliseTerm", () => {
  it("degrades an unrecognised term type to a typed Unknown member", () => {
    const term = Sparql.normaliseTerm({ type: "triple", value: "<< s p o >>" });
    expect(term).toMatchObject({ _tag: "unknown" });
    expect(term).toMatchObject({ _tag: "unknown", type: Option.some("triple") });
  });

  it("cuts an unrecognised type at 200 UTF-16 code units (#150)", () => {
    const term = Sparql.normaliseTerm({ type: "z".repeat(20_000) });
    expect(term).toEqual({
      _tag: "unknown",
      type: Option.some("z".repeat(200)),
      value: Option.none(),
    });
    // A non-string `type` is dropped by the response schema's lenient leaf.
    const response = Schema.decodeUnknownSync(Sparql.SparqlResultsResponse)({
      results: { bindings: [{ x: { type: 5, value: 6 } }] },
    });
    expect(Sparql.normaliseResults(response).bindings[0]?.["x"]).toEqual({
      _tag: "unknown",
      type: Option.none(),
      value: Option.none(),
    });
  });
});

// ── ASK ──────────────────────────────────────────────────────────────────

describe("Sparql.query — ASK (#149)", () => {
  // The SPARQL 1.1 Query Results JSON Format's ASK form.
  it.each([true, false])("carries an ASK answer of %s through", async (answer) => {
    const { layer } = stubWdqs({ head: {}, boolean: answer });
    const results = await run(
      layer,
      Sparql.query("ASK { wd:Q42 wdt:P31 wd:Q5 }", { allowUnbounded: true }),
    );
    expect(results).toEqual({ vars: [], bindings: [], boolean: Option.some(answer) });
  });

  it("reports no answer for a SELECT, or a boolean that is not one", async () => {
    const { results } = await decodeFixture();
    expect(results.boolean).toEqual(Option.none());
    expect(Sparql.normaliseResults({ head: {}, boolean: "true" }).boolean).toEqual(Option.none());
  });
});
