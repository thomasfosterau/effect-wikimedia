/**
 * The **Sparql** surface: a typed client for the Wikidata Query Service
 * (WDQS) SPARQL endpoint (`query.wikidata.org/sparql`).
 *
 * WDQS answers a SPARQL query with the [SPARQL 1.1 Query Results JSON
 * format](https://www.w3.org/TR/sparql11-results-json/): a `head.vars`
 * variable list and a `results.bindings` array of `{ var → term }` rows,
 * where each term is a typed RDF node — an IRI (`uri`), a plain / language-
 * tagged / datatyped literal, or a blank node (`bnode`). This module decodes
 * those into the discriminated {@link SparqlTerm} union, mapping an
 * `xsd:*`-datatyped literal back toward the Wikibase datavalue vocabulary
 * ({@link literalKind}) so a caller reads a WDQS answer in the same terms as
 * a `wbgetentities` claim.
 *
 * **LIMIT discipline.** An unbounded WDQS query is the fastest way to hit the
 * service's 60-second timeout and earn a rate-limit; {@link query} therefore
 * requires the SPARQL text to carry a `LIMIT` clause (or an explicit opt-out
 * for a query that is intrinsically bounded) and fails
 * {@link "./core".InvalidRequest} before any request when it does not.
 *
 * Etiquette is inherited from {@link "./core"}: the polite `User-Agent` on
 * every request, and WDQS's `429` / `503` + `Retry-After` backoff handled by
 * the shared retry loop. `maxlag` — an Action-API parameter WDQS does not
 * accept — is omitted.
 *
 * Imports only {@link "./core"} — never `Action`, `Rest`, `Commons`, or
 * `Wikidata` — so a consumer that imports only `Sparql` from the package
 * barrel never pulls those modules' code into a bundle.
 *
 * @copyright Thomas Foster
 * @module sparql
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  DEFAULT_RETRY_OPTIONS,
  InvalidRequest,
  type RetryOptions,
  WikimediaClient,
} from "./core.ts";

/** The default WDQS host — the public Wikidata Query Service SPARQL endpoint. */
export const WDQS_HOST = "query.wikidata.org";

/** The fixed WDQS SPARQL path. */
export const WDQS_PATH = "/sparql";

// ── LIMIT discipline ─────────────────────────────────────────────────────

/**
 * Detects a `LIMIT <n>` clause in a SPARQL query, ignoring case and
 * SPARQL's `#`-to-end-of-line comments (so a commented-out `LIMIT` doesn't
 * count). This is a deliberately simple lexical check, not a SPARQL parser:
 * its job is to stop an *accidentally* unbounded query, not to defeat a
 * caller determined to write one.
 */
export function hasLimitClause(sparql: string): boolean {
  if (typeof sparql !== "string") return false;
  // Strip line comments (`#...` to end of line) before scanning.
  const withoutComments = sparql.replace(/#[^\n\r]*/g, "");
  return /\blimit\s+\d+/i.test(withoutComments);
}

// ── SPARQL JSON result terms ─────────────────────────────────────────────

/** An IRI node (`{ "type": "uri" }`). */
export interface UriTerm {
  readonly _tag: "uri";
  readonly value: string;
}

/**
 * A literal node (`{ "type": "literal" | "typed-literal" }`). `datatype` is
 * the literal's `xsd:*` (or other) datatype IRI, when typed; `language` is
 * the BCP-47 tag on a language-tagged literal (`rdf:langString`); `kind`
 * maps `datatype` toward the Wikibase datavalue vocabulary for convenience
 * (see {@link literalKind}).
 */
export interface LiteralTerm {
  readonly _tag: "literal";
  readonly value: string;
  readonly datatype: string | null;
  readonly language: string | null;
  readonly kind: LiteralKind;
}

/** A blank node (`{ "type": "bnode" }`). */
export interface BlankNodeTerm {
  readonly _tag: "bnode";
  readonly value: string;
}

/** A term whose `type` this module does not recognise — the lenient degrade. */
export interface UnknownTerm {
  readonly _tag: "unknown";
  readonly type: string | null;
  readonly value: string | null;
}

/** A single RDF term in a SPARQL result binding. */
export type SparqlTerm = UriTerm | LiteralTerm | BlankNodeTerm | UnknownTerm;

/**
 * A coarse classification of a typed literal, mapped back toward the
 * Wikibase datavalue vocabulary so a WDQS answer reads in the same terms as
 * a claim: `"time"` for `xsd:dateTime`, `"quantity"` for the `xsd:` numeric
 * datatypes, `"string"` for `xsd:string` / an untyped literal,
 * `"monolingualtext"` for a language-tagged literal, `"other"` for any other
 * datatype IRI.
 */
export type LiteralKind = "time" | "quantity" | "string" | "monolingualtext" | "other";

const XSD = "http://www.w3.org/2001/XMLSchema#";
const XSD_NUMERIC = new Set(
  [
    "decimal",
    "integer",
    "double",
    "float",
    "long",
    "int",
    "short",
    "byte",
    "nonNegativeInteger",
    "positiveInteger",
    "nonPositiveInteger",
    "negativeInteger",
    "unsignedLong",
    "unsignedInt",
    "unsignedShort",
    "unsignedByte",
  ].map((t) => XSD + t),
);

/**
 * Maps a literal's datatype IRI (and whether it is language-tagged) to a
 * {@link LiteralKind}. A language-tagged literal is `"monolingualtext"`
 * regardless of datatype; `xsd:dateTime` is `"time"`; the `xsd:` numeric
 * family is `"quantity"`; `xsd:string` or no datatype is `"string"`;
 * anything else is `"other"`.
 */
export function literalKind(datatype: string | null, language: string | null): LiteralKind {
  if (language !== null) return "monolingualtext";
  if (datatype === null || datatype === `${XSD}string`) return "string";
  if (datatype === `${XSD}dateTime` || datatype === `${XSD}date`) return "time";
  if (XSD_NUMERIC.has(datatype)) return "quantity";
  return "other";
}

// ── Lenient wire schema (Unknown-heavy) ──────────────────────────────────

const RawTerm = Schema.Struct({
  type: Schema.optional(Schema.Unknown),
  value: Schema.optional(Schema.Unknown),
  datatype: Schema.optional(Schema.Unknown),
  "xml:lang": Schema.optional(Schema.Unknown),
});
type RawTerm = typeof RawTerm.Type;

/** Lenient schema for the SPARQL 1.1 JSON results envelope. */
export const SparqlResultsResponse = Schema.Struct({
  head: Schema.optional(
    Schema.Struct({
      vars: Schema.optional(Schema.Array(Schema.Unknown)),
    }),
  ),
  results: Schema.optional(
    Schema.Struct({
      bindings: Schema.optional(Schema.Array(Schema.Record(Schema.String, RawTerm))),
    }),
  ),
  // ASK queries answer `{ head: {}, boolean: true }`.
  boolean: Schema.optional(Schema.Unknown),
});
export type SparqlResultsResponse = typeof SparqlResultsResponse.Type;

/** One decoded result row — variable name → typed term. */
export type SparqlBinding = Readonly<Record<string, SparqlTerm>>;

/** A decoded SPARQL SELECT result set. */
export interface SparqlResults {
  /** The `SELECT` variable names, in projection order. */
  readonly vars: readonly string[];
  /** The result rows; each maps a (possibly-partial) subset of `vars` to a term. */
  readonly bindings: readonly SparqlBinding[];
}

// ── Normalisers ──────────────────────────────────────────────────────────

const MAX_TERM_LENGTH = 10_000;

function boundedValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.length > MAX_TERM_LENGTH ? value.slice(0, MAX_TERM_LENGTH) : value;
}

/** Normalises one raw term into the typed {@link SparqlTerm} union; never throws. */
export function normaliseTerm(raw: RawTerm): SparqlTerm {
  const type = typeof raw.type === "string" ? raw.type : null;
  const value = boundedValue(raw.value);
  if (type === "uri") return { _tag: "uri", value: value ?? "" };
  if (type === "bnode") return { _tag: "bnode", value: value ?? "" };
  if (type === "literal" || type === "typed-literal") {
    const datatype = typeof raw.datatype === "string" ? raw.datatype.slice(0, 2000) : null;
    const language = typeof raw["xml:lang"] === "string" ? raw["xml:lang"].slice(0, 40) : null;
    return {
      _tag: "literal",
      value: value ?? "",
      datatype,
      language,
      kind: literalKind(datatype, language),
    };
  }
  return { _tag: "unknown", type, value };
}

/** Normalises a SPARQL JSON results envelope into typed {@link SparqlResults}. */
export function normaliseResults(response: SparqlResultsResponse): SparqlResults {
  const vars: string[] = [];
  for (const v of response.head?.vars ?? []) {
    if (typeof v === "string") vars.push(v.slice(0, 200));
  }
  const bindings: SparqlBinding[] = [];
  for (const row of response.results?.bindings ?? []) {
    const binding: Record<string, SparqlTerm> = {};
    for (const [name, term] of Object.entries(row)) {
      binding[name] = normaliseTerm(term);
    }
    bindings.push(binding);
  }
  return { vars, bindings };
}

// ── Query ────────────────────────────────────────────────────────────────

/** Upper bound on a SPARQL query string before it is even considered. */
export const MAX_QUERY_LENGTH = 50_000;

/** Options for {@link query}. */
export interface QueryOptions {
  /**
   * Allow a query with no `LIMIT` clause. Off by default — the whole point
   * of the helper is to make an unbounded query a deliberate, visible choice
   * (set this only for a query that is intrinsically bounded, e.g. a single
   * `VALUES` block or an `ASK`). See {@link hasLimitClause}.
   */
  readonly allowUnbounded?: boolean;
  /** The WDQS host. Defaults to {@link WDQS_HOST}. */
  readonly host?: string;
}

/**
 * Runs a SPARQL query against WDQS and decodes the JSON results into typed
 * terms. Enforces the LIMIT discipline: unless `allowUnbounded` is set, a
 * query with no `LIMIT` clause fails {@link "./core".InvalidRequest} before
 * any request is made. The query text is sent as a percent-encoded query
 * parameter (never interpolated into the path), over the shared client's UA
 * and retry etiquette; `format=json` is forced.
 */
export const query = Effect.fn("Sparql.query")(function* (
  sparql: string,
  options?: QueryOptions,
  retry?: RetryOptions,
) {
  if (typeof sparql !== "string" || sparql.trim().length === 0) {
    return yield* new InvalidRequest({ kind: "query", value: String(sparql) });
  }
  if (sparql.length > MAX_QUERY_LENGTH) {
    return yield* new InvalidRequest({ kind: "queryLength", value: String(sparql.length) });
  }
  if (options?.allowUnbounded !== true && !hasLimitClause(sparql)) {
    return yield* new InvalidRequest({ kind: "missingLimit", value: sparql.slice(0, 120) });
  }
  const client = yield* WikimediaClient;
  const response = yield* client.getJson(
    {
      host: options?.host ?? WDQS_HOST,
      path: WDQS_PATH,
      params: { query: sparql, format: "json" },
      // WDQS does not accept the Action API's `maxlag` parameter.
      maxlagSeconds: null,
    },
    SparqlResultsResponse,
    retry ?? DEFAULT_RETRY_OPTIONS,
  );
  return normaliseResults(response);
});
