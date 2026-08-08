/**
 * Unit tests for the Sparql surface (`src/sparql.ts`): SPARQL JSON result
 * decoding with correct term typing (uri / literal / typed-literal / bnode),
 * the datatype → Wikibase-vocabulary mapping, the LIMIT-enforcing query
 * helper, and WDQS etiquette (host, UA, no `maxlag`). The network is stubbed
 * at `FetchHttpClient.Fetch` — no live network anywhere in this suite.
 *
 * @module tests/sparql
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import { Core, Sparql } from "../src/index.ts";
import { expectFailureInstanceOf, runTest } from "./helpers/effect.ts";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/wdqs-results.json", import.meta.url)), "utf8"),
) as unknown;

const stubWdqs = (body: unknown) => {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const fetchLayer = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  return { requests, layer: Core.wikimediaClientLayer.pipe(Layer.provide(fetchLayer)) };
};

const toEffect = <A, E>(
  layer: Layer.Layer<Core.WikimediaClient>,
  effect: Effect.Effect<A, E, Core.WikimediaClient>,
): Effect.Effect<A, E, never> => effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>;

const run = <A, E>(
  layer: Layer.Layer<Core.WikimediaClient>,
  effect: Effect.Effect<A, E, Core.WikimediaClient>,
) => runTest(toEffect(layer, effect));

const SELECT = "SELECT ?item WHERE { ?item wdt:P31 wd:Q5 } LIMIT 10";

/** Narrows a term to a literal, or fails the test. */
const asLiteral = (
  term: Sparql.SparqlTerm | undefined,
): Extract<Sparql.SparqlTerm, { _tag: "literal" }> => {
  if (term?._tag !== "literal") throw new Error(`expected a literal, got ${term?._tag}`);
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
    expect(first?.anon._tag).toBe("bnode");
  });

  it("decodes a language-tagged literal as monolingualtext", async () => {
    const { first } = await decodeFixture();
    expect(first?.itemLabel).toEqual({
      _tag: "literal",
      value: "Douglas Adams",
      datatype: null,
      language: "en",
      kind: "monolingualtext",
    });
  });

  it("maps xsd-typed literals back to the datavalue vocabulary", async () => {
    const { first } = await decodeFixture();
    const dob = asLiteral(first?.dob);
    expect(dob.kind).toBe("time");
    expect(dob.datatype).toBe("http://www.w3.org/2001/XMLSchema#dateTime");
    expect(asLiteral(first?.height).kind).toBe("quantity");
    // A non-xsd datatype → "other".
    expect(asLiteral(first?.coord).kind).toBe("other");
  });

  it("decodes a partial binding (untyped literal, missing var)", async () => {
    const { second } = await decodeFixture();
    const label = asLiteral(second?.itemLabel);
    expect(label.kind).toBe("string");
    expect(label.language).toBeNull();
    expect(second?.dob).toBeUndefined();
  });
});

// ── literalKind mapping ──────────────────────────────────────────────────

describe("Sparql.literalKind", () => {
  const xsd = "http://www.w3.org/2001/XMLSchema#";
  it("maps datatype IRIs back toward the Wikibase datavalue vocabulary", () => {
    expect(Sparql.literalKind(null, "en")).toBe("monolingualtext");
    expect(Sparql.literalKind(`${xsd}string`, "en")).toBe("monolingualtext");
    expect(Sparql.literalKind(`${xsd}dateTime`, null)).toBe("time");
    expect(Sparql.literalKind(`${xsd}date`, null)).toBe("time");
    expect(Sparql.literalKind(`${xsd}decimal`, null)).toBe("quantity");
    expect(Sparql.literalKind(`${xsd}integer`, null)).toBe("quantity");
    expect(Sparql.literalKind(`${xsd}string`, null)).toBe("string");
    expect(Sparql.literalKind(null, null)).toBe("string");
    expect(Sparql.literalKind("http://example.com/custom", null)).toBe("other");
  });
});

// ── Unknown term degrade ─────────────────────────────────────────────────

describe("Sparql.normaliseTerm", () => {
  it("degrades an unrecognised term type to a typed Unknown member", () => {
    const term = Sparql.normaliseTerm({ type: "triple", value: "<< s p o >>" });
    expect(term._tag).toBe("unknown");
    expect(term._tag === "unknown" && term.type).toBe("triple");
  });
});
