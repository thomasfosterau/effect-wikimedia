/**
 * Shared client core for `@thomasfosterau/effect-wikimedia`: the
 * `HttpClient`-based service every HTTP surface module (`Action`, `Rest`,
 * `Commons`, `Wikidata`, `Sparql`) builds on, plus the cross-cutting
 * etiquette Wikimedia's API usage guidelines ask of every caller.
 *
 * The `HttpClient` layer is split into an injectable test layer and a
 * `FetchHttpClient` production layer, and it serves any Wikimedia project
 * host — Wikipedia, Wikidata, `*.wikimedia.org`, the sister projects
 * (Wiktionary, Wikisource, …), mediawiki.org and Wikifunctions — the host is
 * a **parameter** of every request, never a constant baked into the module.
 *
 * Etiquette this module owns so no surface module has to reimplement it:
 * - a polite `User-Agent`, and an `Api-User-Agent` with the same value, set
 *   on every request: the caller's own, set through {@link UserAgent}, or
 *   this package's neutral {@link USER_AGENT} (a browser may drop
 *   `User-Agent` but sends `Api-User-Agent`; see {@link UserAgent});
 * - the `maxlag` query parameter (bots/scripts are asked to send it so a
 *   lagged replica can decline cheaply rather than serving stale data);
 * - `origin=*` on every Action API (`/w/api.php`) request, so a page on
 *   another origin can read the response; MediaWiki then answers as an
 *   anonymous user (see {@link WikimediaRequest});
 * - `Retry-After` / `maxlag`-error backoff — a lagged or rate-limited
 *   response is retried after the server-requested delay, up to a bounded
 *   number of attempts, rather than either hammering the API or failing on
 *   the first transient signal; a delay longer than the caller's cap fails
 *   at once instead of retrying early.
 *
 * Untrusted-response discipline: every host and
 * path segment a caller supplies is validated before it reaches a URL
 * (SSRF / injection guard — see {@link normaliseWikimediaHost} /
 * {@link normaliseTitle}); responses decode through the lenient
 * `Unknown`-heavy schemas each surface module defines, never trusted
 * structurally until a pure normaliser has checked every field.
 *
 * @copyright Thomas Foster
 * @module
 */

import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { FetchHttpClient, HttpClient, HttpClientRequest, type HttpClientError } from "effect/http";

// ── Identity & etiquette constants ──────────────────────────────────────

/**
 * The default `User-Agent` and `Api-User-Agent` value this package sends
 * when the caller sets none through {@link UserAgent}: it names this package
 * and links its public npm page, and no consumer. Wikimedia's User-Agent policy
 * (https://meta.wikimedia.org/wiki/User-Agent_policy) asks every caller to
 * identify itself so abusive traffic can be contacted rather than
 * blanket-blocked, and an unidentified default `fetch` UA risks a hard block;
 * this default only identifies the library, so production callers should
 * provide their own UA with their contact details. It carries no version
 * number, because the build injects none and a hard-coded one drifts.
 */
export const USER_AGENT =
  "effect-wikimedia (+https://www.npmjs.com/package/@thomasfosterau/effect-wikimedia)";

/**
 * The value this package sends as both the `User-Agent` and the
 * `Api-User-Agent` header on every {@link WikimediaClient} request;
 * defaults to {@link USER_AGENT}. Provide your own, with your contact details,
 * as Wikimedia's User-Agent policy asks
 * (https://meta.wikimedia.org/wiki/User-Agent_policy) — for example
 * `"my-bot/1.2 (https://example.org/my-bot; bot@example.org) effect-wikimedia"`.
 *
 * Node sends both headers verbatim, as does any other server-side `fetch`
 * that doesn't restrict `User-Agent`; a Web Worker or Service Worker in a
 * browser follows the browser's rules. A browser may drop
 * `User-Agent`: the Fetch standard lets a page set it, but Chromium-based
 * browsers silently replace it with their own. Wikimedia asks browser
 * clients to identify themselves with `Api-User-Agent` instead
 * (https://www.mediawiki.org/wiki/API:Etiquette), which browsers send as
 * given, so that header carries this value to Wikimedia from a browser.
 * `Api-User-Agent` is not a CORS-safelisted header, so in a browser a
 * cross-origin request needs a CORS preflight (`OPTIONS`) first. The Action
 * API (with `origin=*`, which this package sends by default) and the REST API
 * allow the header in their preflight responses, and WDQS's nginx config
 * lists it too, though no live WDQS preflight has been checked.
 *
 * `Dumps.fromHttpRange` sends this value as `User-Agent` only. It is a
 * Node-only download from the dump host, which serves static files rather
 * than an API, and Node already sends `User-Agent` as given.
 *
 * {@link WikimediaClient} reads it once, when its layer is built;
 * `Dumps.fromHttpRange` reads it from the program's context when the stream
 * runs, unless its own `userAgent` option is set. To reach both from one
 * place, merge it into the layer
 * (`Layer.provideMerge(Layer.succeed(Core.UserAgent, ua))`) or provide it
 * outside the `Effect.provide` that builds the layer
 * (`Effect.provideService(Core.UserAgent, ua)`). `Layer.provide` reaches the
 * client only. A `provideService` the layer build doesn't see (one inside
 * `Effect.provide(layer)`, or per run on a `ManagedRuntime` made from the
 * layer) reaches the dump download only.
 */
export const UserAgent: Context.Reference<string> = Context.Reference<string>(
  "effect-wikimedia/UserAgent",
  { defaultValue: () => USER_AGENT },
);

/**
 * Default `maxlag` seconds sent on every request (the etiquette guide's
 * recommended default for bots/scripts). A replica lagged past this many
 * seconds declines the request outright (HTTP 200 with an
 * `error.code: "maxlag"` body, or occasionally a `5xx`) rather than serving
 * stale data — see {@link detectMaxlagSignal}. It is also the wait, in
 * seconds, a {@link RateLimited} carries when the response has no
 * `Retry-After` header in seconds.
 */
export const DEFAULT_MAXLAG_SECONDS = 5;

/**
 * The Action API path every `/w/api.php` request uses; {@link buildUrl}
 * keys the `origin=*` parameter on it, so a surface module that targets
 * this path gets anonymous CORS without having to remember to ask for it.
 */
const ACTION_API_PATH = "/w/api.php";

// ── Typed error family ───────────────────────────────────────────────────

/**
 * A bad input the caller supplied (a host, title, id, query or option),
 * rejected before any request is sent — fix the input, don't retry.
 */
export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("InvalidRequest", {
  /**
   * Which input was rejected. This package uses `"host"` (a host outside the
   * Wikimedia families {@link normaliseWikimediaHost} accepts), `"title"` and
   * `"filename"` (a page title or Commons filename {@link normaliseTitle}
   * rejects), `"revisionId"` (not a positive integer), `"entityId"` (not a
   * Wikidata entity id), `"query"` (a blank search or SPARQL query),
   * `"language"` and `"type"` (a malformed language code or entity type
   * for a Wikidata search), `"queryLength"` (a SPARQL query over the length limit) and
   * `"missingLimit"` (a SPARQL query with no `LIMIT` clause, sent without
   * `allowUnbounded`). Typed as `string`, so a caller of {@link requireTitle}
   * can pass its own.
   */
  kind: Schema.String,
  /**
   * The rejected input as the caller passed it, before trimming or
   * lower-casing; a `"revisionId"` number is converted with `String`, and a
   * `"filename"` has any leading `File:` prefix removed first. Two kinds carry
   * a stand-in instead: `"queryLength"` holds the query's length in UTF-16
   * code units, and `"missingLimit"` holds the query's first 120 code
   * units.
   */
  value: Schema.String,
}) {}

/** An upstream transport / decode failure (network, non-2xx, malformed body). Not retried. */
export class RequestFailed extends Schema.TaggedError<RequestFailed>()("RequestFailed", {
  /**
   * A human-readable account of the failure, for logs rather than parsing:
   * `wikimedia returned HTTP <status>` for a non-2xx status other than `429`
   * and `503`; `request failed: …` for a transport error or a body that
   * can't be read or isn't valid JSON; and
   * `wikimedia response did not match the expected shape: …` for a JSON
   * body the caller's schema rejects. The status code and the underlying
   * error are not kept as separate fields.
   */
  description: Schema.String,
}) {}

/**
 * The server declined the request as lagged (a `maxlag` error body) or
 * rate-limited (HTTP `429` or `503`, with or without `Retry-After`). Carries
 * the number of seconds to wait before retrying. {@link withMaxlagRetry}
 * handles this automatically; it only escapes to the caller once retries
 * are exhausted, or straight away when the server asks for a longer wait
 * than {@link RetryOptions.maxDelaySeconds} allows.
 */
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  /**
   * Seconds to wait before retrying: finite, non-negative, and possibly
   * fractional. For a `429`, a `503` or a `maxlag` error body alike it is the
   * response's `Retry-After` header value when that is a number of seconds
   * ({@link parseRetryAfterHeader}), and {@link DEFAULT_MAXLAG_SECONDS} when
   * the header is absent or an HTTP date. (MediaWiki answers a `maxlag` error
   * with `Retry-After` set to the larger of the request's `maxlag` parameter
   * and 5 seconds.) It is the server's figure, uncapped: when it exceeds
   * {@link RetryOptions.maxDelaySeconds}, {@link withMaxlagRetry} does not
   * retry and this error escapes as is. Once retries are exhausted, the error
   * that escapes carries the last attempt's value.
   */
  retryAfterSeconds: Schema.Finite,
}) {}

/** The typed error channel every {@link WikimediaClient} method fails on. */
export type WikimediaError = InvalidRequest | RequestFailed | RateLimited;

// ── Per-wiki addressing (host is a parameter, not a constant) ───────────

/**
 * Hosts allowed verbatim, in addition to the suffix-matched families below:
 * Wikidata's bare and `www` hosts, MediaWiki's own wiki (`www.mediawiki.org`),
 * Wikifunctions (`www.wikifunctions.org`), and multilingual Wikisource,
 * which lives on the bare `wikisource.org`. Each bare form is listed because
 * it redirects to, or is, a wiki in its own right.
 */
const ALLOWED_HOSTS: HashSet.HashSet<string> = HashSet.make(
  "wikidata.org",
  "www.wikidata.org",
  "mediawiki.org",
  "www.mediawiki.org",
  "wikifunctions.org",
  "www.wikifunctions.org",
  "wikisource.org",
);

/**
 * Host suffixes accepted for the per-wiki families: any language edition of
 * Wikipedia (`en.wikipedia.org`, `zh-yue.wikipedia.org`, …), any other
 * Wikimedia project host (`commons.wikimedia.org`, `meta.wikimedia.org`,
 * `species.wikimedia.org`, …), any Wikidata subdomain — notably
 * `query.wikidata.org`, the Wikidata Query Service (WDQS) SPARQL endpoint the
 * `Sparql` module targets — and any language edition of the sister projects
 * that run on their own second-level domain (`en.wiktionary.org`,
 * `de.wikivoyage.org`, `fr.wikisource.org`, …). A closed list of
 * Wikimedia-owned domains: third-party MediaWiki sites (Fandom and the like)
 * stay out, so the SSRF guard still pins every request to Wikimedia.
 */
const ALLOWED_HOST_SUFFIXES: readonly string[] = [
  ".wikipedia.org",
  ".wikimedia.org",
  ".wikidata.org",
  ".wiktionary.org",
  ".wikivoyage.org",
  ".wikisource.org",
  ".wikiquote.org",
  ".wikibooks.org",
  ".wikinews.org",
  ".wikiversity.org",
];

/** Upper bound on a host string before it is even pattern-checked. */
const MAX_HOST_LENGTH = 100;

/**
 * Validates and lower-cases an untrusted wiki host. Only Wikimedia-owned
 * hosts are accepted: a subdomain of `wikipedia.org`, `wikimedia.org`,
 * `wikidata.org` or a sister project's domain (`wiktionary.org`,
 * `wikivoyage.org`, `wikisource.org`, `wikiquote.org`, `wikibooks.org`,
 * `wikinews.org`, `wikiversity.org`), or exactly `wikidata.org`,
 * `www.wikidata.org`, `mediawiki.org`, `www.mediawiki.org`,
 * `wikifunctions.org`, `www.wikifunctions.org` or `wikisource.org`. This is
 * the SSRF guard: every request this package builds
 * targets `https://<validated host><fixed path>`, so a caller (or a value
 * threaded through from an untrusted source) can never redirect a request
 * to an arbitrary host. Returns `null` for anything else.
 */
export function normaliseWikimediaHost(raw: string): string | null {
  if (!Predicate.isString(raw)) return null;
  const cleaned = raw.trim().toLowerCase();
  if (Str.isEmpty(cleaned) || cleaned.length > MAX_HOST_LENGTH) return null;
  // Hostnames only: letters, digits, dot, hyphen. Rejects anything that
  // could smuggle a path, port, or credentials into the host position.
  if (!/^[a-z0-9.-]+$/.test(cleaned)) return null;
  if (HashSet.has(ALLOWED_HOSTS, cleaned)) return cleaned;
  return Arr.some(
    ALLOWED_HOST_SUFFIXES,
    (suffix) => cleaned.endsWith(suffix) && cleaned.length > suffix.length,
  )
    ? cleaned
    : null;
}

/** Upper bound on a MediaWiki title / filename before validation. */
export const MAX_TITLE_LENGTH = 512;

/**
 * Whether `title` is one of the relative-path forms MediaWiki's
 * `TitleParser` rejects (`title-invalid-relative`): exactly `.` or `..`, a
 * leading `./` or `../`, a `/./` or `/../` anywhere, or a trailing `/.` or
 * `/..`. `encodeURIComponent` leaves dots alone, so a bare `.` or `..` path
 * segment would otherwise be removed by `new URL`'s dot-segment
 * normalisation and the request would reach a different path.
 */
function isRelativePathTitle(title: string): boolean {
  return (
    title === "." ||
    title === ".." ||
    title.startsWith("./") ||
    title.startsWith("../") ||
    title.includes("/./") ||
    title.includes("/../") ||
    title.endsWith("/.") ||
    title.endsWith("/..")
  );
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * Whether `title` from code unit `index` on holds no control character and
 * no surrogate that isn't half of a high-low pair (a lone surrogate makes
 * `encodeURIComponent` throw). One pass over UTF-16 code units rather than
 * `isWellFormed` (ES2024) or a lookbehind regex (a parse-time SyntaxError
 * before Safari 16.4), so the module loads on any runtime the package
 * supports. Recursion depth is bounded by `MAX_TITLE_LENGTH`, which callers
 * check first.
 */
function hasSafeCodeUnits(title: string, index: number): boolean {
  if (index >= title.length) return true;
  const code = title.charCodeAt(index);
  if (code < 0x20 || code === 0x7f || isLowSurrogate(code)) return false;
  if (!isHighSurrogate(code)) return hasSafeCodeUnits(title, index + 1);
  // `charCodeAt` is NaN past the end, which is no low surrogate; a valid
  // pair skips its low half.
  return isLowSurrogate(title.charCodeAt(index + 1)) && hasSafeCodeUnits(title, index + 2);
}

/**
 * Validates and canonicalises an untrusted MediaWiki title (a page title or
 * a `File:`-namespaced filename): trims, collapses internal whitespace to a
 * single underscore (MediaWiki's canonical title form), bounds length, and
 * rejects control characters, a lone UTF-16 surrogate (which makes
 * `encodeURIComponent` throw `URIError`; a valid surrogate pair such as an
 * emoji is kept), the `|`/`#` that could inject an extra query clause or a
 * fragment, the `<`, `>`, `[`, `]`, `{` and `}` that MediaWiki's default
 * `$wgLegalTitleChars` never allows (such a title names no page, so asking
 * would only spend a request), and MediaWiki's relative-path titles (`.`,
 * `..`, a leading `./` or `../`, a `/./` or `/../` anywhere, a trailing `/.`
 * or `/..`), which `new URL` would otherwise resolve into a different path. The result is still placed through `encodeURIComponent` wherever it
 * lands (a query parameter or a REST path segment) — this validation is the
 * belt to that braces. Returns `null` for unusable input.
 *
 * This is a string-level check, not full MediaWiki title parsing: it does
 * not decode `%XX` sequences, reject `~~~` or apply a wiki's own
 * `$wgLegalTitleChars`, and it knows no wiki's namespaces, so it applies the relative-path rule to the whole
 * string where MediaWiki applies it after removing a namespace prefix
 * (MediaWiki rejects `Talk:../x`; this accepts it, and as `:` encodes to
 * `%3A` the path is unchanged). A caller that strips a prefix itself, as
 * `Commons` strips `File:`, passes the stripped title. Titles that merely
 * contain dots (`Mr._Smith`, `A.B`, `...`) stay valid.
 */
export function normaliseTitle(raw: string): string | null {
  if (!Predicate.isString(raw)) return null;
  const collapsed = raw.trim().replace(/\s+/g, "_");
  if (Str.isEmpty(collapsed) || collapsed.length > MAX_TITLE_LENGTH) return null;
  if (!hasSafeCodeUnits(collapsed, 0)) return null;
  if (/[|#<>[\]{}]/.test(collapsed)) return null;
  if (isRelativePathTitle(collapsed)) return null;
  return collapsed;
}

/**
 * Validates a title/filename and fails {@link InvalidRequest} for anything
 * {@link normaliseTitle} rejects (blank, too long, control characters, a
 * lone UTF-16 surrogate, `|`, `#`, `<`, `>`, `[`, `]`, `{` or `}`, or a relative-path title such as `.` or
 * `..`), before any request is sent — the `yield*`-able form of {@link normaliseTitle} every surface
 * module's request-building functions start with. `kind` names the field in
 * the resulting error (`"title"` for a page title, `"filename"` for a
 * Commons file).
 */
export function requireTitle(value: string, kind = "title"): Effect.Effect<string, InvalidRequest> {
  const validated = normaliseTitle(value);
  if (validated === null || validated.length > MAX_TITLE_LENGTH) {
    return Effect.fail(new InvalidRequest({ kind, value }));
  }
  return Effect.succeed(validated);
}

/**
 * Validates a positive integer revision id and fails {@link InvalidRequest}
 * for anything else — the `yield*`-able form the Rest surface's
 * revision-keyed functions start with.
 */
export function requireRevisionId(revisionId: number): Effect.Effect<number, InvalidRequest> {
  if (!Number.isInteger(revisionId) || revisionId <= 0) {
    return Effect.fail(new InvalidRequest({ kind: "revisionId", value: String(revisionId) }));
  }
  return Effect.succeed(revisionId);
}

// ── Shared response-field sanitisers ─────────────────────────────────────

/** Upper bound on a free-text field copied from an untrusted response body. */
export const MAX_TEXT_FIELD_LENGTH = 4000;

/** Trims and length-clamps an untrusted free-text value; `null` for anything unusable. */
export function sanitiseText(value: unknown): string | null {
  if (!Predicate.isString(value)) return null;
  const trimmed = value.trim();
  return Str.isEmpty(trimmed) ? null : trimmed.slice(0, MAX_TEXT_FIELD_LENGTH);
}

/** A non-negative integer within a sane bound, or `null` for anything else. */
export function toNonNegativeInt(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  if (!Predicate.isNumber(value) || !Number.isFinite(value)) return null;
  const int = Math.trunc(value);
  return int >= 0 && int <= max ? int : null;
}

// ── Maxlag / retry-after etiquette ───────────────────────────────────────

/**
 * Parses an HTTP `Retry-After` header value. Only the integer-seconds form
 * is supported (the HTTP-date form is rare from Wikimedia and not needed by
 * this package); returns `null` for anything else, including a missing
 * header.
 */
export function parseRetryAfterHeader(value: string | undefined | null): number | null {
  if (!Predicate.isString(value)) return null;
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const seconds = Number(trimmed);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * Detects the Action API's in-body maxlag signal: a `200 OK` response whose
 * JSON body is `{ error: { code: "maxlag", ... } }` (the REST/Parsoid surface
 * signals lag via HTTP status instead — see {@link parseRetryAfterHeader}).
 * Returns the etiquette-recommended backoff in seconds
 * ({@link DEFAULT_MAXLAG_SECONDS}) when detected, or `null` when the body
 * carries no maxlag signal. It reads only the body: MediaWiki also sends a
 * `Retry-After` header with this error (the larger of the request's `maxlag`
 * parameter and 5 seconds), and {@link WikimediaClient} waits for that header's
 * value when it is a number of seconds (failing instead of retrying when it
 * exceeds {@link RetryOptions.maxDelaySeconds}), using this function's figure
 * only when the header is absent or an HTTP date.
 */
export function detectMaxlagSignal(body: unknown): number | null {
  if (!Predicate.isObjectOrArray(body) || !Predicate.hasProperty(body, "error")) return null;
  const error = body.error;
  if (!Predicate.isObjectOrArray(error) || !Predicate.hasProperty(error, "code")) return null;
  return error.code === "maxlag" ? DEFAULT_MAXLAG_SECONDS : null;
}

/** Bounds how many extra attempts / how long a single wait can be for {@link withMaxlagRetry}. */
export interface RetryOptions {
  /**
   * Extra attempts after the first, made only after a {@link RateLimited}
   * failure; `0` (or less) disables retrying. {@link DEFAULT_RETRY_OPTIONS}
   * sets 3.
   */
  readonly maxRetries: number;
  /**
   * Upper bound, in seconds, on any single wait. A {@link RateLimited} whose
   * {@link RateLimited.retryAfterSeconds} is at most this is waited out in
   * full and retried; one asking for longer fails at once, with no wait and
   * no retry, so no request goes out before the server allows it. The waits
   * for one request therefore total at most `maxRetries × maxDelaySeconds`
   * (a function that splits its work into several requests gives each its
   * own retries). {@link DEFAULT_RETRY_OPTIONS} sets 30.
   */
  readonly maxDelaySeconds: number;
}

/** The etiquette guide's default: a few retries, capped at a short wait each. */
export const DEFAULT_RETRY_OPTIONS: RetryOptions = { maxRetries: 3, maxDelaySeconds: 30 };

/**
 * Retries `attempt` on {@link RateLimited}, sleeping the server-requested
 * delay between attempts, up to `options.maxRetries` extra attempts. Once
 * retries are exhausted, the last {@link RateLimited} error propagates to the
 * caller; so does one asking for a longer wait than `options.maxDelaySeconds`,
 * straight away, rather than retrying sooner than the server allows. Any other failure
 * (`InvalidRequest`, `RequestFailed`) is never retried — those are not
 * transient.
 */
export function withMaxlagRetry<A, R>(
  attempt: Effect.Effect<A, WikimediaError, R>,
  options: RetryOptions = DEFAULT_RETRY_OPTIONS,
): Effect.Effect<A, WikimediaError, R> {
  const loop = (remaining: number): Effect.Effect<A, WikimediaError, R> =>
    attempt.pipe(
      Effect.catchTag("RateLimited", (error) => {
        if (remaining <= 0 || error.retryAfterSeconds > options.maxDelaySeconds) {
          return Effect.fail(error);
        }
        return Effect.sleep(Duration.seconds(error.retryAfterSeconds)).pipe(
          Effect.andThen(loop(remaining - 1)),
        );
      }),
    );
  return loop(options.maxRetries);
}

// ── HTTP plumbing ─────────────────────────────────────────────────────

/**
 * One request against a validated per-wiki host and a fixed API path.
 *
 * A request whose `path` resolves to `"/w/api.php"` (the Action API) is sent
 * with `origin=*` added to its query string. That is MediaWiki's anonymous
 * CORS mode: without an `origin` parameter the Action API sends no
 * `Access-Control-*` headers, so a browser page on another origin couldn't
 * read the response. In exchange MediaWiki answers as an anonymous user
 * whatever credentials arrive, and marks the response
 * `MediaWiki-Login-Suppressed: true`. It ignores the session cookies a
 * same-origin on-wiki gadget would send, and it ignores an `Authorization`
 * header injected through `HttpClient.mapRequest`. Every Action API call
 * the `Action`, `Commons`, `Wikidata` and `Reconciliation` surfaces make
 * is therefore anonymous; their limits are already the anonymous ones.
 * REST (`/w/rest.php`) and WDQS requests are left unchanged, since both
 * send CORS headers without the parameter.
 *
 * An `origin` the caller puts in `params` is sent as given, in place of
 * `*`, never alongside it. A `crossorigin` there (MediaWiki's authenticated
 * CORS mode) suppresses `origin=*` too, since MediaWiki rejects a request
 * carrying both with HTTP 403.
 */
export interface WikimediaRequest {
  /** The wiki host, e.g. `"en.wikipedia.org"` — validated by {@link normaliseWikimediaHost}. */
  readonly host: string;
  /**
   * The fixed API path, e.g. `"/w/api.php"` or `"/w/rest.php/v1/page/Douglas_Adams"`;
   * one that resolves to `"/w/api.php"` adds `origin=*` to the query string.
   */
  readonly path: string;
  /**
   * Query parameters; percent-encoded by `URLSearchParams`, never interpolated
   * into the path. An `origin` here replaces the `origin=*` the Action API path
   * otherwise gets, and a `crossorigin` here suppresses it. A lone UTF-16
   * surrogate in a value is sent as U+FFFD (`URLSearchParams` replaces it, and
   * never throws), unlike in a title, which {@link normaliseTitle} rejects.
   */
  readonly params?: Record<string, string>;
  /**
   * Seconds to send as `maxlag`, or `null` to omit the parameter entirely
   * (some REST endpoints don't accept it). Defaults to
   * {@link DEFAULT_MAXLAG_SECONDS}.
   */
  readonly maxlagSeconds?: number | null;
}

/**
 * Builds the request URL for an already-validated {@link WikimediaRequest}.
 * `host` must already have passed {@link normaliseWikimediaHost} — this
 * function does not re-validate it, so every call site validates first and
 * fails with {@link InvalidRequest} before reaching here.
 *
 * Adds `origin=*` here, on the Action API path, rather than in each surface
 * module, because every request passes through this one function: a future
 * surface that calls `/w/api.php` can't forget it.
 */
function buildUrl(request: WikimediaRequest): string {
  const url = new URL(`https://${request.host}${request.path}`);
  const search = new URLSearchParams(request.params ?? {});
  const maxlag =
    request.maxlagSeconds === undefined ? DEFAULT_MAXLAG_SECONDS : request.maxlagSeconds;
  if (maxlag !== null) search.set("maxlag", String(maxlag));
  if (url.pathname === ACTION_API_PATH && !search.has("origin") && !search.has("crossorigin")) {
    search.set("origin", "*");
  }
  url.search = search.toString();
  return url.toString();
}

/**
 * The seconds a {@link RateLimited} response asks the client to wait, given
 * its `Retry-After` header: the header's value when that is a number of
 * seconds, otherwise {@link DEFAULT_MAXLAG_SECONDS}. Shared by the
 * `429` / `503` path and the `maxlag` error-body path, so both honour the
 * server's figure the same way.
 */
function retryAfterSeconds(retryAfterHeader: string | undefined): number {
  return parseRetryAfterHeader(retryAfterHeader) ?? DEFAULT_MAXLAG_SECONDS;
}

function describeHttpError(error: HttpClientError.HttpClientError): string {
  return error.reason._tag === "StatusCodeError"
    ? `wikimedia returned HTTP ${error.reason.response.status}`
    : `request failed: ${String(error)}`;
}

/**
 * Shared client contract every HTTP surface module (`Action`, `Rest`,
 * `Commons`, `Wikidata`, `Sparql`) depends on. `getJson` decodes a JSON body
 * through a caller-supplied lenient schema; `getText` reads a raw text body (the REST/Parsoid HTML
 * endpoints return `text/html`, not JSON). Both apply the UA policy, the
 * `maxlag` parameter, the Action API's `origin=*` (which makes those
 * requests anonymous; see {@link WikimediaRequest}), and
 * {@link withMaxlagRetry} automatically — callers
 * never see a transient maxlag/rate-limit signal unless retries exhaust.
 */
export class WikimediaClient extends Context.Service<
  WikimediaClient,
  {
    /**
     * Sends a GET for `request` and decodes the JSON body through `schema`.
     * Fails with {@link InvalidRequest} for a host outside the allowed
     * families, {@link RateLimited} for a `429` / `503` or a `maxlag` error
     * body once `retry` (default {@link DEFAULT_RETRY_OPTIONS}) is
     * exhausted, and {@link RequestFailed} for any other non-2xx status, a
     * transport error, or a body that does not match `schema`.
     */
    readonly getJson: <S extends Schema.Top>(
      request: WikimediaRequest,
      schema: S,
      retry?: RetryOptions,
    ) => Effect.Effect<S["Type"], WikimediaError, S["DecodingServices"]>;
    /**
     * Sends a GET for `request` and returns the raw body as text, undecoded
     * (the REST/Parsoid HTML endpoints answer `text/html`). Fails with
     * {@link InvalidRequest} for a host outside the allowed families,
     * {@link RateLimited} for a `429` / `503` once `retry` (default
     * {@link DEFAULT_RETRY_OPTIONS}) is exhausted, and {@link RequestFailed}
     * for any other non-2xx status or a transport error.
     */
    readonly getText: (
      request: WikimediaRequest,
      retry?: RetryOptions,
    ) => Effect.Effect<string, WikimediaError>;
  }
>()("effect-wikimedia/Client") {}

/**
 * Normalises `request.host`, failing with {@link InvalidRequest} for a host
 * outside the allowed Wikimedia families.
 */
const validated = (request: WikimediaRequest): Effect.Effect<WikimediaRequest, InvalidRequest> => {
  const host = normaliseWikimediaHost(request.host);
  if (host === null) return Effect.fail(new InvalidRequest({ kind: "host", value: request.host }));
  return Effect.succeed({ ...request, host });
};

/**
 * Builds the {@link WikimediaClient} service over an `HttpClient`, sending
 * the {@link UserAgent} in context at build time as both `User-Agent` and
 * `Api-User-Agent`. Wrapped by
 * {@link wikimediaClientLayer} (tests drive with a stubbed client) and
 * {@link wikimediaLayer} (production, over `FetchHttpClient`); not exported
 * because both layers live in this module.
 */
const makeWikimediaClient = Effect.fnUntraced(function* () {
  const baseClient = yield* HttpClient.HttpClient;
  const userAgent = yield* UserAgent;
  const client = baseClient.pipe(
    HttpClient.mapRequest((req) =>
      req.pipe(
        // Chromium drops `User-Agent` on `fetch` but sends `Api-User-Agent`,
        // the header Wikimedia's API etiquette asks browser clients to use.
        HttpClientRequest.setHeaders({ "user-agent": userAgent, "api-user-agent": userAgent }),
        HttpClientRequest.acceptJson,
      ),
    ),
  );

  /**
   * Validates the request, runs one attempt, and classifies the response:
   * a `429`/`503` becomes {@link RateLimited}, any other non-2xx becomes
   * {@link RequestFailed}. Shared by {@link getJsonOnce} and
   * {@link getTextOnce} so the status-classification logic exists once.
   */
  const respond = (request: WikimediaRequest) =>
    Effect.gen(function* () {
      const validRequest = yield* validated(request);
      const response = yield* client
        .get(buildUrl(validRequest))
        .pipe(
          Effect.catchTag("HttpClientError", (error) =>
            Effect.fail(new RequestFailed({ description: describeHttpError(error) })),
          ),
        );
      if (response.status === 429 || response.status === 503) {
        return yield* new RateLimited({
          retryAfterSeconds: retryAfterSeconds(response.headers["retry-after"]),
        });
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* new RequestFailed({
          description: `wikimedia returned HTTP ${response.status}`,
        });
      }
      return response;
    });

  const getJsonOnce = <S extends Schema.Top>(
    request: WikimediaRequest,
    schema: S,
  ): Effect.Effect<S["Type"], WikimediaError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const response = yield* respond(request);
      const body = yield* response.json.pipe(
        Effect.catchTag("HttpClientError", (error) =>
          Effect.fail(new RequestFailed({ description: describeHttpError(error) })),
        ),
      );
      if (detectMaxlagSignal(body) !== null)
        return yield* new RateLimited({
          retryAfterSeconds: retryAfterSeconds(response.headers["retry-after"]),
        });
      return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
        Effect.catchTag("SchemaError", (error) =>
          Effect.fail(
            new RequestFailed({
              description: `wikimedia response did not match the expected shape: ${String(error)}`,
            }),
          ),
        ),
      );
    });

  const getTextOnce = (request: WikimediaRequest): Effect.Effect<string, WikimediaError> =>
    Effect.gen(function* () {
      const response = yield* respond(request);
      return yield* response.text.pipe(
        Effect.catchTag("HttpClientError", (error) =>
          Effect.fail(new RequestFailed({ description: describeHttpError(error) })),
        ),
      );
    });

  const getJson = <S extends Schema.Top>(
    request: WikimediaRequest,
    schema: S,
    retry?: RetryOptions,
  ): Effect.Effect<S["Type"], WikimediaError, S["DecodingServices"]> =>
    withMaxlagRetry(getJsonOnce(request, schema), retry);

  const getText = (
    request: WikimediaRequest,
    retry?: RetryOptions,
  ): Effect.Effect<string, WikimediaError> => withMaxlagRetry(getTextOnce(request), retry);

  return { getJson, getText } as const;
});

/**
 * {@link WikimediaClient} layer over whatever `HttpClient` is in context.
 * The production graph supplies `FetchHttpClient` (see
 * {@link wikimediaLayer}); a test supplies a stubbed fetch under the same
 * `FetchHttpClient` slot. Sets the `User-Agent` and `Api-User-Agent`
 * headers to the {@link UserAgent} in context when the layer is built
 * ({@link USER_AGENT} if none is provided).
 */
export const wikimediaClientLayer: Layer.Layer<WikimediaClient, never, HttpClient.HttpClient> =
  Layer.effect(WikimediaClient)(makeWikimediaClient());

/**
 * Production {@link WikimediaClient} layer, backed by the global `fetch` via
 * `FetchHttpClient`. Sets the `User-Agent` and `Api-User-Agent` headers to
 * the {@link UserAgent} in context when the layer is built; set yours with
 * `Core.wikimediaLayer.pipe(Layer.provideMerge(Layer.succeed(Core.UserAgent, ua)))`
 * (see {@link UserAgent} for which form reaches `Dumps.fromHttpRange` too).
 */
export const wikimediaLayer: Layer.Layer<WikimediaClient> = wikimediaClientLayer.pipe(
  Layer.provide(FetchHttpClient.layer),
);
