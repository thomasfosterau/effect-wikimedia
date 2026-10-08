/**
 * The **Rest** surface: the Core REST API / Parsoid endpoints
 * (`/w/rest.php/v1/...`) — typed page and revision metadata, and parsed
 * HTML for a title or revision.
 *
 * Imports only {@link "./core"} — never `Action` or `Commons` — so a
 * consumer that imports only `Rest` from the package barrel never pulls
 * those modules' code into a bundle.
 *
 * The `/html` endpoints answer `text/html`, not JSON — {@link WikimediaClient.getText}
 * reads the raw body rather than decoding it through a schema; there is
 * nothing to validate beyond the transport-level checks {@link "./core"}
 * already applies (status, UA, maxlag/retry).
 *
 * @copyright Thomas Foster
 * @module rest
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  DEFAULT_RETRY_OPTIONS,
  requireRevisionId,
  requireTitle,
  type RetryOptions,
  sanitiseText,
  toNonNegativeInt,
  WikimediaClient,
} from "./core.ts";

// ── Page / revision metadata (JSON) ──────────────────────────────────────

const License = Schema.Struct({
  url: Schema.optional(Schema.Unknown),
  title: Schema.optional(Schema.Unknown),
});

const LatestRevision = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
  timestamp: Schema.optional(Schema.Unknown),
});

/** Lenient schema for `GET /w/rest.php/v1/page/{title}`. */
export const PageMetadataResponse = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
  key: Schema.optional(Schema.Unknown),
  title: Schema.optional(Schema.Unknown),
  content_model: Schema.optional(Schema.Unknown),
  latest: Schema.optional(LatestRevision),
  license: Schema.optional(License),
  html_url: Schema.optional(Schema.Unknown),
});
export type PageMetadataResponse = typeof PageMetadataResponse.Type;

/** Lenient schema for `GET /w/rest.php/v1/revision/{id}`. */
export const RevisionMetadataResponse = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
  size: Schema.optional(Schema.Unknown),
  minor: Schema.optional(Schema.Unknown),
  timestamp: Schema.optional(Schema.Unknown),
  content_model: Schema.optional(Schema.Unknown),
  page: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.Unknown),
      key: Schema.optional(Schema.Unknown),
      title: Schema.optional(Schema.Unknown),
    }),
  ),
  license: Schema.optional(License),
});
export type RevisionMetadataResponse = typeof RevisionMetadataResponse.Type;

/** A page's REST-surface identity metadata. */
export interface PageMetadata {
  readonly pageId: number | null;
  readonly key: string | null;
  readonly title: string;
  readonly contentModel: string | null;
  readonly latestRevisionId: number | null;
  readonly latestTimestamp: string | null;
  readonly licenseUrl: string | null;
}

/** A revision's REST-surface identity metadata. */
export interface RevisionMetadata {
  readonly revisionId: number;
  readonly pageId: number | null;
  readonly pageTitle: string | null;
  readonly size: number | null;
  readonly minor: boolean | null;
  readonly timestamp: string | null;
  readonly contentModel: string | null;
  readonly licenseUrl: string | null;
}

/** Normalises a `PageMetadataResponse`. Never `null` — a REST 404 surfaces as `RequestFailed` before decoding gets here. */
export function normalisePageMetadata(response: PageMetadataResponse, title: string): PageMetadata {
  return {
    pageId: toNonNegativeInt(response.id),
    key: sanitiseText(response.key),
    title: sanitiseText(response.title) ?? title,
    contentModel: sanitiseText(response.content_model),
    latestRevisionId: toNonNegativeInt(response.latest?.id),
    latestTimestamp:
      typeof response.latest?.timestamp === "string"
        ? response.latest.timestamp.slice(0, 40)
        : null,
    licenseUrl: sanitiseText(response.license?.url),
  };
}

/** Normalises a `RevisionMetadataResponse` for the requested `revisionId`. */
export function normaliseRevisionMetadata(
  response: RevisionMetadataResponse,
  revisionId: number,
): RevisionMetadata {
  return {
    revisionId: toNonNegativeInt(response.id) ?? revisionId,
    pageId: toNonNegativeInt(response.page?.id),
    pageTitle: sanitiseText(response.page?.title),
    size: toNonNegativeInt(response.size, 100_000_000),
    minor: typeof response.minor === "boolean" ? response.minor : null,
    timestamp: typeof response.timestamp === "string" ? response.timestamp.slice(0, 40) : null,
    contentModel: sanitiseText(response.content_model),
    licenseUrl: sanitiseText(response.license?.url),
  };
}

/**
 * Fetches a page's REST-surface metadata via `GET /w/rest.php/v1/page/{title}`.
 * Fails with `InvalidRequest`, before any request is sent, for a title
 * `normaliseTitle` rejects, including a lone UTF-16 surrogate (which would
 * make `encodeURIComponent` throw) and the relative-path titles `.` and `..`
 * that would otherwise reach a different REST path.
 */
export const getPageMetadata = Effect.fn("Rest.getPageMetadata")(function* (
  host: string,
  title: string,
  retry?: RetryOptions,
) {
  const validTitle = yield* requireTitle(title);
  const client = yield* WikimediaClient;
  const response = yield* client.getJson(
    { host, path: `/w/rest.php/v1/page/${encodeURIComponent(validTitle)}`, maxlagSeconds: null },
    PageMetadataResponse,
    retry ?? DEFAULT_RETRY_OPTIONS,
  );
  return normalisePageMetadata(response, validTitle);
});

/** Fetches a revision's REST-surface metadata via `GET /w/rest.php/v1/revision/{id}`. */
export const getRevisionMetadata = Effect.fn("Rest.getRevisionMetadata")(function* (
  host: string,
  revisionId: number,
  retry?: RetryOptions,
) {
  const validId = yield* requireRevisionId(revisionId);
  const client = yield* WikimediaClient;
  const response = yield* client.getJson(
    { host, path: `/w/rest.php/v1/revision/${validId}`, maxlagSeconds: null },
    RevisionMetadataResponse,
    retry ?? DEFAULT_RETRY_OPTIONS,
  );
  return normaliseRevisionMetadata(response, validId);
});

// ── Parsed HTML (Parsoid, text/html) ─────────────────────────────────────

/**
 * Fetches a title's current parsed HTML via `GET /w/rest.php/v1/page/{title}/html`.
 * Fails with `InvalidRequest`, before any request is sent, for a title
 * `normaliseTitle` rejects, including a lone UTF-16 surrogate (which would
 * make `encodeURIComponent` throw) and the relative-path titles `.` and `..`
 * that would otherwise reach a different REST path.
 */
export const getParsedHtml = Effect.fn("Rest.getParsedHtml")(function* (
  host: string,
  title: string,
  retry?: RetryOptions,
) {
  const validTitle = yield* requireTitle(title);
  const client = yield* WikimediaClient;
  return yield* client.getText(
    {
      host,
      path: `/w/rest.php/v1/page/${encodeURIComponent(validTitle)}/html`,
      maxlagSeconds: null,
    },
    retry ?? DEFAULT_RETRY_OPTIONS,
  );
});

/** Fetches a specific revision's parsed HTML via `GET /w/rest.php/v1/revision/{id}/html`. */
export const getRevisionHtml = Effect.fn("Rest.getRevisionHtml")(function* (
  host: string,
  revisionId: number,
  retry?: RetryOptions,
) {
  const validId = yield* requireRevisionId(revisionId);
  const client = yield* WikimediaClient;
  return yield* client.getText(
    { host, path: `/w/rest.php/v1/revision/${validId}/html`, maxlagSeconds: null },
    retry ?? DEFAULT_RETRY_OPTIONS,
  );
});
