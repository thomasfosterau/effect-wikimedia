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
 * {@link InvalidRequest} before any request when it does not.
 *
 * Etiquette is inherited from {@link Core}: the polite `User-Agent` and
 * `Api-User-Agent` on every request, and WDQS's `429` / `503` +
 * `Retry-After` backoff handled by the shared retry loop. `maxlag` — an
 * Action-API parameter WDQS does not accept — is omitted.
 *
 * Imports only {@link Core} — never `Action`, `Rest`, `Commons`, or
 * `Wikidata` — so a consumer that imports only `Sparql` from the package
 * barrel never pulls those modules' code into a bundle.
 *
 * @copyright Thomas Foster
 * @module
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
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
  if (!Predicate.isString(sparql)) return false;
  // Strip line comments (`#...` to end of line) before scanning.
  const withoutComments = sparql.replace(/#[^\n\r]*/g, "");
  return /\blimit\s+\d+/i.test(withoutComments);
}

// ── SPARQL JSON result terms ─────────────────────────────────────────────

/** An IRI node (`{ "type": "uri" }`). */
export interface UriTerm {
  /** The discriminant: always `"uri"`, for a raw term whose `type` is exactly `"uri"`. */
  readonly _tag: "uri";
  /**
   * The IRI as the server sent it, such as
   * `"http://www.wikidata.org/entity/Q42"` for a Wikidata item. It is cut at
   * 10,000 UTF-16 code units but not trimmed, parsed or validated as an IRI;
   * `""` when the raw `value` is absent or not a string.
   */
  readonly value: string;
}

/**
 * A literal node (`{ "type": "literal" | "typed-literal" }`): a plain,
 * language-tagged or datatyped value, with `kind` mapping its datatype toward
 * the Wikibase datavalue vocabulary for convenience (see {@link literalKind}).
 */
export interface LiteralTerm {
  /**
   * The discriminant: always `"literal"`, for a raw term whose `type` is
   * exactly `"literal"` or `"typed-literal"` (both are read the same way).
   */
  readonly _tag: "literal";
  /**
   * The literal's lexical form as the server sent it, such as `"1.96"` for an
   * `xsd:decimal` or `"1952-03-11T00:00:00Z"` for an `xsd:dateTime`: a string
   * whatever the datatype, never parsed into a number or a date. It is cut at
   * 10,000 UTF-16 code units but not trimmed; `""` when the raw `value` is
   * absent or not a string.
   */
  readonly value: string;
  /**
   * The literal's datatype IRI as the server sent it, such as
   * `"http://www.w3.org/2001/XMLSchema#dateTime"`, cut at 2,000 UTF-16 code
   * units but not trimmed or validated. `null` when the raw term has no string
   * `datatype`. The SPARQL 1.1 JSON results format writes no `datatype` key for
   * a simple or a language-tagged literal, though RDF 1.1 types them
   * `xsd:string` and `rdf:langString`.
   */
  readonly datatype: string | null;
  /**
   * The literal's language tag (the raw term's `xml:lang`), such as `"en"`, as
   * the server sent it: cut at 40 UTF-16 code units but not trimmed,
   * case-normalised or validated. `null` when the raw term has no string
   * `xml:lang`; an empty `xml:lang` gives `""`, not `null`.
   */
  readonly language: string | null;
  /**
   * The {@link literalKind} of this term's `datatype` and `language`: any
   * non-`null` `language` (`""` included) makes it `"monolingualtext"`,
   * whatever the datatype; {@link LiteralKind} lists the rest of the mapping.
   */
  readonly kind: LiteralKind;
}

/** A blank node (`{ "type": "bnode" }`). */
export interface BlankNodeTerm {
  /** The discriminant: always `"bnode"`, for a raw term whose `type` is exactly `"bnode"`. */
  readonly _tag: "bnode";
  /**
   * The blank node's label as the server sent it, such as `"t42"`. The SPARQL
   * 1.1 JSON results format scopes a label to one response: the same label
   * twice in a response is the same node, but the label identifies nothing
   * outside it. Cut at 10,000 UTF-16 code units but not trimmed; `""` when the
   * raw `value` is absent or not a string.
   */
  readonly value: string;
}

/**
 * A term whose `type` this module does not recognise — the lenient degrade.
 * `type` matching is exact, so a differently cased `"URI"` lands here too.
 */
export interface UnknownTerm {
  /**
   * The discriminant: always `"unknown"`, for a raw term whose `type` is
   * absent, not a string, or a string other than `"uri"`, `"literal"`,
   * `"typed-literal"` and `"bnode"`.
   */
  readonly _tag: "unknown";
  /**
   * The raw term's `type`, cut at 200 UTF-16 code units but not trimmed;
   * `null` when it is absent or not a string.
   */
  readonly type: string | null;
  /**
   * The raw term's `value`, cut at 10,000 UTF-16 code units but not trimmed;
   * `null` when it is absent or not a string (an object or array included).
   */
  readonly value: string | null;
}

/** A single RDF term in a SPARQL result binding. */
export type SparqlTerm = UriTerm | LiteralTerm | BlankNodeTerm | UnknownTerm;

/**
 * A coarse classification of a typed literal, mapped back toward the
 * Wikibase datavalue vocabulary so a WDQS answer reads in the same terms as
 * a claim: `"time"` for `xsd:dateTime` or `xsd:date`, `"quantity"` for the
 * `xsd:` numeric datatypes, `"string"` for `xsd:string` / an untyped literal,
 * `"monolingualtext"` for a language-tagged literal, `"other"` for any other
 * datatype IRI.
 */
export type LiteralKind = "time" | "quantity" | "string" | "monolingualtext" | "other";

const XSD = "http://www.w3.org/2001/XMLSchema#";
const XSD_NUMERIC = HashSet.fromIterable(
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
 * regardless of datatype; `xsd:dateTime` and `xsd:date` are `"time"`; the
 * `xsd:` numeric family is `"quantity"`; `xsd:string` or no datatype is
 * `"string"`; anything else is `"other"`.
 */
export function literalKind(datatype: string | null, language: string | null): LiteralKind {
  if (language !== null) return "monolingualtext";
  if (datatype === null || datatype === `${XSD}string`) return "string";
  if (datatype === `${XSD}dateTime` || datatype === `${XSD}date`) return "time";
  if (HashSet.has(XSD_NUMERIC, datatype)) return "quantity";
  return "other";
}

// ── Lenient wire schema (Unknown-heavy) ──────────────────────────────────

const RawTerm = Schema.Struct({
  /**
   * The term's kind: `"uri"`, `"literal"` (or `"typed-literal"`, read the same
   * way) or `"bnode"`.
   */
  type: Schema.optional(Schema.Unknown),
  /** The term's value: the IRI, the literal's lexical form or the blank node's label. */
  value: Schema.optional(Schema.Unknown),
  /** A datatyped literal's datatype IRI. */
  datatype: Schema.optional(Schema.Unknown),
  /** A language-tagged literal's language tag. */
  "xml:lang": Schema.optional(Schema.Unknown),
});
type RawTerm = typeof RawTerm.Type;

/**
 * Lenient schema for the SPARQL 1.1 JSON results envelope: the decode step
 * {@link query} runs before {@link normaliseResults}. Every field is optional
 * and every leaf `Unknown`, so a partial, extended or future-shaped response
 * decodes, but a container of the wrong kind fails the decode, which
 * {@link query} reports as a `RequestFailed`: a body, `head`, `results`, row or
 * term that is not a JSON object (an array or `null` included), or a `vars` or
 * `bindings` that is not an array. Read the typed {@link SparqlResults} that
 * {@link normaliseResults} builds from it, not these fields.
 */
export const SparqlResultsResponse = Schema.Struct({
  /** The result header. */
  head: Schema.optional(
    Schema.Struct({
      /**
       * The query's variable names, in the order the server sent them (the
       * `SELECT` clause's order, except under `SELECT *`).
       */
      vars: Schema.optional(Schema.Array(Schema.Unknown)),
    }),
  ),
  /** A `SELECT` query's result set. */
  results: Schema.optional(
    Schema.Struct({
      /**
       * The result rows, each mapping a variable name to its term; a variable
       * a row leaves unbound is absent from it.
       */
      bindings: Schema.optional(Schema.Array(Schema.Record(Schema.String, RawTerm))),
    }),
  ),
  /**
   * An `ASK` query's answer, `true` or `false`, which the response carries in
   * place of `results`; {@link normaliseResults} reads it into
   * {@link SparqlResults.boolean}.
   */
  boolean: Schema.optional(Schema.Unknown),
});
export type SparqlResultsResponse = typeof SparqlResultsResponse.Type;

/** One decoded result row — variable name → typed term. */
export type SparqlBinding = Readonly<Record<string, SparqlTerm>>;

/** A decoded SPARQL result: a `SELECT` query's rows, or an `ASK` query's answer. */
export interface SparqlResults {
  /**
   * The `SELECT` variable names as the server sent them, in its order (the
   * `SELECT` clause's order, except under `SELECT *`): entries that are not
   * strings are dropped, and each is cut at 200 UTF-16 code units. Empty when
   * the response has no `head.vars`.
   */
  readonly vars: readonly string[];
  /**
   * The result rows; each maps a (possibly-partial) subset of `vars` to a
   * term. Empty for an `ASK` query.
   */
  readonly bindings: readonly SparqlBinding[];
  /**
   * An `ASK` query's answer; `null` for any other query, that is, when the
   * response's top-level `boolean` is absent or not a boolean.
   */
  readonly boolean: boolean | null;
}

// ── Normalisers ──────────────────────────────────────────────────────────

const MAX_TERM_LENGTH = 10_000;

/** Upper bound on an unrecognised term's `type` ({@link UnknownTerm.type}). */
const MAX_UNKNOWN_TYPE_LENGTH = 200;

function boundedValue(value: unknown): string | null {
  if (!Predicate.isString(value)) return null;
  return value.length > MAX_TERM_LENGTH ? value.slice(0, MAX_TERM_LENGTH) : value;
}

/** Normalises one raw term into the typed {@link SparqlTerm} union; never throws. */
export function normaliseTerm(raw: RawTerm): SparqlTerm {
  const type = Predicate.isString(raw.type) ? raw.type : null;
  const value = boundedValue(raw.value);
  if (type === "uri") return { _tag: "uri", value: value ?? "" };
  if (type === "bnode") return { _tag: "bnode", value: value ?? "" };
  if (type === "literal" || type === "typed-literal") {
    const datatype = Predicate.isString(raw.datatype) ? raw.datatype.slice(0, 2000) : null;
    const language = Predicate.isString(raw["xml:lang"]) ? raw["xml:lang"].slice(0, 40) : null;
    return {
      _tag: "literal",
      value: value ?? "",
      datatype,
      language,
      kind: literalKind(datatype, language),
    };
  }
  return { _tag: "unknown", type: type?.slice(0, MAX_UNKNOWN_TYPE_LENGTH) ?? null, value };
}

/** Normalises a SPARQL JSON results envelope into typed {@link SparqlResults}. */
export function normaliseResults(response: SparqlResultsResponse): SparqlResults {
  const vars = Arr.getSomes(
    Arr.map(response.head?.vars ?? [], (v) =>
      Predicate.isString(v) ? Option.some(v.slice(0, 200)) : Option.none(),
    ),
  );
  const bindings = Arr.map(response.results?.bindings ?? [], (row): SparqlBinding =>
    Rec.map(row, normaliseTerm),
  );
  const answer = Predicate.isBoolean(response.boolean) ? response.boolean : null;
  return { vars, bindings, boolean: answer };
}

// ── Query ────────────────────────────────────────────────────────────────

/** Upper bound on a SPARQL query string before it is even considered. */
export const MAX_QUERY_LENGTH = 50_000;

/** Options for {@link query}. */
export interface QueryOptions {
  /**
   * Allow a query with no `LIMIT` clause. Off by default — the whole point of
   * the helper is to make an unbounded query a deliberate, visible choice (set
   * this only for a query that is intrinsically bounded, e.g. a single `VALUES`
   * block or an `ASK`, whose answer is {@link SparqlResults.boolean}). See
   * {@link hasLimitClause}.
   */
  readonly allowUnbounded?: boolean;
  /** The WDQS host. Defaults to {@link WDQS_HOST}. */
  readonly host?: string;
}

/**
 * Runs a SPARQL query against WDQS and decodes the JSON results into typed
 * terms, or, for an `ASK`, its answer ({@link SparqlResults.boolean}). Enforces the LIMIT discipline: unless `allowUnbounded` is set, a
 * query with no `LIMIT` clause fails {@link InvalidRequest} before
 * any request is made. The query text is sent as a percent-encoded query
 * parameter (never interpolated into the path), over the shared client's UA
 * and retry etiquette; `format=json` is forced.
 */
export const query = Effect.fn("Sparql.query")(function* (
  sparql: string,
  options?: QueryOptions,
  retry?: RetryOptions,
) {
  if (!Predicate.isString(sparql) || Str.isEmpty(sparql.trim())) {
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
