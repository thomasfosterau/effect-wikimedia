/**
 * @copyright Thomas Foster
 *
 * Shared client core for `@thomasfosterau/effect-wikimedia`: the
 * `HttpClient`-based service every surface module (`Action`, `Rest`,
 * `Commons`) builds on, plus the cross-cutting etiquette Wikimedia's API
 * usage guidelines ask of every caller.
 *
 * Generalises `packages/wikidata/src/lookup.ts`'s `HttpClient`-layer split
 * (injectable test layer + `FetchHttpClient` production layer), polite-UA,
 * and lenient-decode discipline from one fixed Wikidata endpoint to any
 * `*.wikipedia.org` / `wikidata.org` / `*.wikimedia.org` host — the host is
 * a **parameter** of every request, never a constant baked into the module.
 *
 * Etiquette this module owns so no surface module has to reimplement it:
 * - a polite `User-Agent` identifying the caller, applied to every request;
 * - the `maxlag` query parameter (bots/scripts are asked to send it so a
 *   lagged replica can decline cheaply rather than serving stale data);
 * - `Retry-After` / `maxlag`-error backoff — a lagged or rate-limited
 *   response is retried with the server-requested delay, capped, up to a
 *   bounded number of attempts, rather than either hammering the API or
 *   failing on the first transient signal.
 *
 * Untrusted-response discipline (mirrors wikidata/biblio): every host and
 * path segment a caller supplies is validated before it reaches a URL
 * (SSRF / injection guard — see {@link normaliseWikimediaHost} /
 * {@link normaliseTitle}); responses decode through the lenient
 * `Unknown`-heavy schemas each surface module defines, never trusted
 * structurally until a pure normaliser has checked every field.
 *
 * Zero website-internal dependencies: this module (and the package as a
 * whole) imports only `effect`, so it can be extracted to its own
 * repository/npm package with no source changes — see
 * `docs/decisions/effect-wikimedia-as-the-wikimedia-client-toolkit.md`.
 *
 * @module core
 */

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
} from "effect/unstable/http";

// ── Identity & etiquette constants ──────────────────────────────────────

/**
 * A polite User-Agent, applied to every outgoing request. Wikimedia's API
 * etiquette (https://meta.wikimedia.org/wiki/User-Agent_policy) asks every
 * caller to identify itself so abusive traffic can be contacted rather than
 * blanket-blocked; an unidentified default `fetch` UA risks a hard block.
 */
export const USER_AGENT =
  "effect-wikimedia/0.0.0 (+https://github.com/thomasfosterau/website; mailto:me@thomasfoster.au)";

/**
 * Default `maxlag` seconds sent on every request (the etiquette guide's
 * recommended default for bots/scripts). A replica lagged past this many
 * seconds declines the request outright (HTTP 200 with an
 * `error.code: "maxlag"` body, or occasionally a `5xx`) rather than serving
 * stale data — see {@link detectMaxlagSignal}.
 */
export const DEFAULT_MAXLAG_SECONDS = 5;

// ── Typed error family ───────────────────────────────────────────────────

/** A bad input the caller supplied (host or path segment) — fix the input, don't retry. */
export class InvalidRequest extends Schema.TaggedErrorClass<InvalidRequest>()("InvalidRequest", {
  kind: Schema.String,
  value: Schema.String,
}) {}

/** An upstream transport / decode failure (network, non-2xx, malformed body). */
export class RequestFailed extends Schema.TaggedErrorClass<RequestFailed>()("RequestFailed", {
  description: Schema.String,
}) {}

/**
 * The server declined the request as lagged (`maxlag`) or rate-limited
 * (`429`/`503` + `Retry-After`). Carries the number of seconds the server
 * asked the caller to wait before retrying. {@link withMaxlagRetry} handles
 * this automatically; it only escapes to the caller once retries are
 * exhausted.
 */
export class RateLimited extends Schema.TaggedErrorClass<RateLimited>()("RateLimited", {
  retryAfterSeconds: Schema.Finite,
}) {}

/** The typed error channel every {@link WikimediaClient} method fails on. */
export type WikimediaError = InvalidRequest | RequestFailed | RateLimited;

// ── Per-wiki addressing (host is a parameter, not a constant) ───────────

/** Hosts allowed verbatim, in addition to the suffix-matched families below. */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["wikidata.org", "www.wikidata.org"]);

/**
 * Host suffixes accepted for the per-wiki families: any language edition of
 * Wikipedia (`en.wikipedia.org`, `zh-yue.wikipedia.org`, …), any other
 * Wikimedia project host (`commons.wikimedia.org`, `meta.wikimedia.org`, …),
 * and any Wikidata subdomain — notably `query.wikidata.org`, the Wikidata
 * Query Service (WDQS) SPARQL endpoint the {@link "./sparql"} module targets.
 */
const ALLOWED_HOST_SUFFIXES: readonly string[] = [
  ".wikipedia.org",
  ".wikimedia.org",
  ".wikidata.org",
];

/** Upper bound on a host string before it is even pattern-checked. */
const MAX_HOST_LENGTH = 100;

/**
 * Validates and lower-cases an untrusted wiki host. Only exact matches
 * against {@link ALLOWED_HOSTS} or a subdomain of {@link ALLOWED_HOST_SUFFIXES}
 * are accepted — this is the SSRF guard: every request this package builds
 * targets `https://<validated host><fixed path>`, so a caller (or a value
 * threaded through from an untrusted source) can never redirect a request
 * to an arbitrary host. Returns `null` for anything else.
 */
export function normaliseWikimediaHost(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().toLowerCase();
  if (cleaned.length === 0 || cleaned.length > MAX_HOST_LENGTH) return null;
  // Hostnames only: letters, digits, dot, hyphen. Rejects anything that
  // could smuggle a path, port, or credentials into the host position.
  if (!/^[a-z0-9.-]+$/.test(cleaned)) return null;
  if (ALLOWED_HOSTS.has(cleaned)) return cleaned;
  for (const suffix of ALLOWED_HOST_SUFFIXES) {
    if (cleaned.endsWith(suffix) && cleaned.length > suffix.length) return cleaned;
  }
  return null;
}

/** Upper bound on a MediaWiki title / filename before validation. */
export const MAX_TITLE_LENGTH = 512;

/**
 * Validates and canonicalises an untrusted MediaWiki title (a page title or
 * a `File:`-namespaced filename): trims, collapses internal whitespace to a
 * single underscore (MediaWiki's canonical title form), bounds length, and
 * rejects control characters and the `|`/`#` that could inject an extra
 * query clause or a fragment. The result is still placed through
 * `encodeURIComponent` wherever it lands (a query parameter or a REST path
 * segment) — this validation is the belt to that braces. Returns `null` for
 * unusable input.
 */
export function normaliseTitle(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const collapsed = raw.trim().replace(/\s+/g, "_");
  if (collapsed.length === 0 || collapsed.length > MAX_TITLE_LENGTH) return null;
  for (let i = 0; i < collapsed.length; i++) {
    const code = collapsed.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  if (/[|#]/.test(collapsed)) return null;
  return collapsed;
}

/**
 * Validates a title/filename and fails {@link InvalidRequest} for anything
 * unusable — the `yield*`-able form of {@link normaliseTitle} every surface
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
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, MAX_TEXT_FIELD_LENGTH);
}

/** A non-negative integer within a sane bound, or `null` for anything else. */
export function toNonNegativeInt(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
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
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const seconds = Number(trimmed);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * Detects the Action API's in-body maxlag signal: a `200 OK` response whose
 * JSON body is `{ error: { code: "maxlag", ... } }` (the REST/Parsoid
 * surface signals lag via HTTP status instead — see
 * {@link parseRetryAfterHeader}). Returns the etiquette-recommended backoff
 * ({@link DEFAULT_MAXLAG_SECONDS}) when detected — the Action API does not
 * send a `Retry-After` header alongside this body — or `null` when the body
 * carries no maxlag signal.
 */
export function detectMaxlagSignal(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return code === "maxlag" ? DEFAULT_MAXLAG_SECONDS : null;
}

/** Bounds how many extra attempts / how long a single wait can be for {@link withMaxlagRetry}. */
export interface RetryOptions {
  /** Extra attempts after the first, once a {@link RateLimited} signal is seen. */
  readonly maxRetries: number;
  /** Upper bound on any single wait, regardless of what the server asked for. */
  readonly maxDelaySeconds: number;
}

/** The etiquette guide's default: a few retries, capped at a short wait each. */
export const DEFAULT_RETRY_OPTIONS: RetryOptions = { maxRetries: 3, maxDelaySeconds: 30 };

/**
 * Retries `attempt` on {@link RateLimited}, sleeping the server-requested
 * delay (capped at `options.maxDelaySeconds`) between attempts, up to
 * `options.maxRetries` extra attempts. Once retries are exhausted, the last
 * {@link RateLimited} error propagates to the caller. Any other failure
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
        if (remaining <= 0) return Effect.fail(error);
        const delaySeconds = Math.min(error.retryAfterSeconds, options.maxDelaySeconds);
        return Effect.sleep(Duration.seconds(delaySeconds)).pipe(
          Effect.andThen(loop(remaining - 1)),
        );
      }),
    );
  return loop(options.maxRetries);
}

// ── HTTP plumbing ─────────────────────────────────────────────────────

/** One request against a validated per-wiki host and a fixed API path. */
export interface WikimediaRequest {
  /** The wiki host, e.g. `"en.wikipedia.org"` — validated by {@link normaliseWikimediaHost}. */
  readonly host: string;
  /** The fixed API path, e.g. `"/w/api.php"` or `"/w/rest.php/v1/page/Douglas_Adams"`. */
  readonly path: string;
  /** Query parameters; percent-encoded by `URLSearchParams`, never interpolated into the path. */
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
 */
function buildUrl(request: WikimediaRequest): string {
  const url = new URL(`https://${request.host}${request.path}`);
  const search = new URLSearchParams(request.params ?? {});
  const maxlag =
    request.maxlagSeconds === undefined ? DEFAULT_MAXLAG_SECONDS : request.maxlagSeconds;
  if (maxlag !== null) search.set("maxlag", String(maxlag));
  url.search = search.toString();
  return url.toString();
}

function describeHttpError(error: HttpClientError.HttpClientError): string {
  return error.reason._tag === "StatusCodeError"
    ? `wikimedia returned HTTP ${error.reason.response.status}`
    : `request failed: ${String(error)}`;
}

/**
 * Shared client contract every surface module (`Action`, `Rest`, `Commons`)
 * depends on. `getJson` decodes a JSON body through a caller-supplied
 * lenient schema; `getText` reads a raw text body (the REST/Parsoid HTML
 * endpoints return `text/html`, not JSON). Both apply the UA policy, the
 * `maxlag` parameter, and {@link withMaxlagRetry} automatically — callers
 * never see a transient maxlag/rate-limit signal unless retries exhaust.
 */
export class WikimediaClient extends Context.Service<
  WikimediaClient,
  {
    readonly getJson: <S extends Schema.Top>(
      request: WikimediaRequest,
      schema: S,
      retry?: RetryOptions,
    ) => Effect.Effect<S["Type"], WikimediaError, S["DecodingServices"]>;
    readonly getText: (
      request: WikimediaRequest,
      retry?: RetryOptions,
    ) => Effect.Effect<string, WikimediaError>;
  }
>()("effect-wikimedia/Client") {}

/**
 * Builds the {@link WikimediaClient} service over an `HttpClient`. Wrapped
 * by {@link wikimediaClientLayer} (tests drive with a stubbed client) and
 * {@link wikimediaLayer} (production, over `FetchHttpClient`); not exported
 * because both layers live in this module.
 */
const makeWikimediaClient = Effect.fnUntraced(function* () {
  const baseClient = yield* HttpClient.HttpClient;
  const client = baseClient.pipe(
    HttpClient.mapRequest((req) =>
      req.pipe(HttpClientRequest.setHeader("user-agent", USER_AGENT), HttpClientRequest.acceptJson),
    ),
  );

  const validated = (
    request: WikimediaRequest,
  ): Effect.Effect<WikimediaRequest, InvalidRequest> => {
    const host = normaliseWikimediaHost(request.host);
    if (host === null)
      return Effect.fail(new InvalidRequest({ kind: "host", value: request.host }));
    return Effect.succeed({ ...request, host });
  };

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
        const retryAfterSeconds =
          parseRetryAfterHeader(response.headers["retry-after"]) ?? DEFAULT_MAXLAG_SECONDS;
        return yield* new RateLimited({ retryAfterSeconds });
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
      const maxlagSeconds = detectMaxlagSignal(body);
      if (maxlagSeconds !== null)
        return yield* new RateLimited({ retryAfterSeconds: maxlagSeconds });
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
 * `FetchHttpClient` slot.
 */
export const wikimediaClientLayer: Layer.Layer<WikimediaClient, never, HttpClient.HttpClient> =
  Layer.effect(WikimediaClient)(makeWikimediaClient());

/** Production {@link WikimediaClient} layer, backed by the global `fetch` via `FetchHttpClient`. */
export const wikimediaLayer: Layer.Layer<WikimediaClient> = wikimediaClientLayer.pipe(
  Layer.provide(FetchHttpClient.layer),
);
