/**
 * The **Rest** surface: the Core REST API / Parsoid endpoints
 * (`/w/rest.php/v1/...`) — typed page and revision metadata, and parsed
 * HTML for a title or revision.
 *
 * Imports only {@link Core} — never `Action` or `Commons` — so a
 * consumer that imports only `Rest` from the package barrel never pulls
 * those modules' code into a bundle.
 *
 * The `/html` endpoints answer `text/html`, not JSON — {@link WikimediaClient}'s `getText`
 * reads the raw body rather than decoding it through a schema; there is
 * nothing to validate beyond the transport-level checks {@link Core}
 * already applies (status, UA, maxlag/retry).
 *
 * @copyright Thomas Foster
 * @module
 */

import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
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
  /** The license's URL (MediaWiki's `$wgRightsUrl`). */
  url: Schema.optional(Schema.Unknown),
  /** The license's display name (MediaWiki's `$wgRightsText`); not read. */
  title: Schema.optional(Schema.Unknown),
});

const LatestRevision = Schema.Struct({
  /** The id of the page's latest revision. */
  id: Schema.optional(Schema.Unknown),
  /** When the latest revision was saved, as an ISO 8601 UTC timestamp (`"2024-01-01T00:00:00Z"`). */
  timestamp: Schema.optional(Schema.Unknown),
});

/**
 * Lenient schema for `GET /w/rest.php/v1/page/{title}`: the decode step
 * {@link getPageMetadata} runs before {@link normalisePageMetadata}. Every
 * field is optional and every leaf `Unknown`, so a partial, extended or
 * future-shaped response decodes, but a container of the wrong kind (a `latest`
 * or `license` that is not an object, `null` included) fails the decode, which
 * {@link getPageMetadata} reports as a `RequestFailed`. Read the typed
 * {@link PageMetadata} that {@link normalisePageMetadata} builds from it, not
 * these fields.
 */
export const PageMetadataResponse = Schema.Struct({
  /** The page id. */
  id: Schema.optional(Schema.Unknown),
  /**
   * The title in database-key form, with underscores for spaces and no
   * percent-encoding (`"Douglas_Adams"`).
   */
  key: Schema.optional(Schema.Unknown),
  /** The title in display form, with spaces (`"Douglas Adams"`). */
  title: Schema.optional(Schema.Unknown),
  /** The content model of the page's latest revision (`"wikitext"`, `"json"`, …). */
  content_model: Schema.optional(Schema.Unknown),
  /** The page's latest revision: its id and when it was saved. */
  latest: Schema.optional(LatestRevision),
  /** The wiki's content license, which is site-wide rather than per page. */
  license: Schema.optional(License),
  /**
   * The URL of the page's `/html` endpoint; not read. MediaWiki 1.47 and later
   * (including Wikimedia's wikis) send it on `/page/{title}` whenever the HTML
   * isn't inlined; earlier versions sent it only on `/page/{title}/bare`.
   */
  html_url: Schema.optional(Schema.Unknown),
});
export type PageMetadataResponse = typeof PageMetadataResponse.Type;

/**
 * Lenient schema for `GET /w/rest.php/v1/revision/{id}`: the decode step
 * {@link getRevisionMetadata} runs before {@link normaliseRevisionMetadata}.
 * Every field is optional and every leaf `Unknown`, so a partial, extended or
 * future-shaped response decodes, but a container of the wrong kind (a `page`
 * or `license` that is not an object, `null` included) fails the decode, which
 * {@link getRevisionMetadata} reports as a `RequestFailed`. Read the typed
 * {@link RevisionMetadata} that {@link normaliseRevisionMetadata} builds from
 * it, not these fields.
 */
export const RevisionMetadataResponse = Schema.Struct({
  /** The revision id. */
  id: Schema.optional(Schema.Unknown),
  /** The size of the revision's content, in bytes. */
  size: Schema.optional(Schema.Unknown),
  /** `true` when the editor marked the edit as minor. */
  minor: Schema.optional(Schema.Unknown),
  /** When the revision was saved, as an ISO 8601 UTC timestamp (`"2024-01-01T00:00:00Z"`). */
  timestamp: Schema.optional(Schema.Unknown),
  /** The revision's content model (`"wikitext"`, `"json"`, …). */
  content_model: Schema.optional(Schema.Unknown),
  /** The page the revision belongs to. */
  page: Schema.optional(
    Schema.Struct({
      /** The page id. */
      id: Schema.optional(Schema.Unknown),
      /** The page's current title in database-key form, with underscores for spaces; not read. */
      key: Schema.optional(Schema.Unknown),
      /** The page's current title in display form, with spaces. */
      title: Schema.optional(Schema.Unknown),
    }),
  ),
  /** The wiki's content license, which is site-wide rather than per revision. */
  license: Schema.optional(License),
});
export type RevisionMetadataResponse = typeof RevisionMetadataResponse.Type;

/** A page's REST-surface identity metadata. */
export interface PageMetadata {
  /**
   * MediaWiki's page id; `null` when the response has none, or it is negative,
   * not a finite number or above `Number.MAX_SAFE_INTEGER`. A fractional value
   * is truncated.
   */
  readonly pageId: number | null;
  /**
   * The title in database-key form, with underscores for spaces and any
   * namespace prefix (`"Douglas_Adams"`, `"Talk:Douglas_Adams"`), trimmed and
   * cut at {@link Core.MAX_TEXT_FIELD_LENGTH} UTF-16 code units; `null` when
   * absent or empty.
   */
  readonly key: string | null;
  /**
   * The title in display form, with spaces and any namespace prefix
   * (`"Douglas Adams"`), trimmed and cut at {@link Core.MAX_TEXT_FIELD_LENGTH}
   * UTF-16 code units. Never empty when it comes from {@link getPageMetadata}: when the
   * response has no usable title it is the `title` passed to
   * {@link normalisePageMetadata}, which {@link getPageMetadata} sets to the
   * requested title, trimmed and with each run of whitespace replaced by an
   * underscore (`"Douglas_Adams"`).
   */
  readonly title: string;
  /**
   * The content model of the page's latest revision, such as `"wikitext"`,
   * `"json"`, `"javascript"`, `"css"` or `"Scribunto"`, trimmed; `null` when
   * absent or empty.
   */
  readonly contentModel: string | null;
  /**
   * The id of the page's latest revision; `null` when the response has none, or
   * it is negative, not a finite number or above `Number.MAX_SAFE_INTEGER`. A
   * fractional value is truncated.
   */
  readonly latestRevisionId: number | null;
  /**
   * When the page's latest revision was saved, as MediaWiki's ISO 8601 UTC
   * timestamp (`"2024-01-01T00:00:00Z"`), cut at 40 characters but not
   * trimmed, parsed or validated. `null` when absent or not a string.
   */
  readonly latestTimestamp: string | null;
  /**
   * The URL of the wiki's content license (on most Wikimedia wikis a CC BY-SA
   * 4.0 URL such as `"https://creativecommons.org/licenses/by-sa/4.0/deed.en"`;
   * Wikinews uses CC BY), trimmed but not validated as a URL or checked for its
   * scheme, so check that it is `https:` before using it as a link; `null` when
   * absent or empty. The license is the wiki's site-wide one, not specific to
   * the page.
   */
  readonly licenseUrl: string | null;
}

/** A revision's REST-surface identity metadata. */
export interface RevisionMetadata {
  /**
   * The revision id the response reports, or the `revisionId` passed to
   * {@link normaliseRevisionMetadata} when the response has none, or it is
   * negative, not a finite number or above `Number.MAX_SAFE_INTEGER`. A
   * fractional value is truncated.
   */
  readonly revisionId: number;
  /**
   * The id of the page the revision belongs to; `null` when the response has
   * none, or it is negative, not a finite number or above
   * `Number.MAX_SAFE_INTEGER`. A fractional value is truncated.
   */
  readonly pageId: number | null;
  /**
   * The title of the page the revision belongs to, in display form with spaces
   * and any namespace prefix (`"Douglas Adams"`), trimmed and cut at
   * {@link Core.MAX_TEXT_FIELD_LENGTH} UTF-16 code units; `null` when absent or
   * empty. It is the page's current title, which differs from its title at the
   * time of the edit if the page has since been moved.
   */
  readonly pageTitle: string | null;
  /**
   * The size of the revision's content, in bytes; `null` when absent,
   * negative, not a finite number or over 100,000,000. A fractional value
   * is truncated.
   */
  readonly size: number | null;
  /**
   * `true` when the editor marked the edit as minor, `false` when not;
   * `null` when absent or not a boolean.
   */
  readonly minor: boolean | null;
  /**
   * When the revision was saved, as MediaWiki's ISO 8601 UTC timestamp
   * (`"2024-01-01T00:00:00Z"`), cut at 40 characters but not trimmed,
   * parsed or validated. `null` when absent or not a string.
   */
  readonly timestamp: string | null;
  /**
   * The revision's content model, such as `"wikitext"`, `"json"`,
   * `"javascript"`, `"css"` or `"Scribunto"`, trimmed; `null` when absent or
   * empty.
   */
  readonly contentModel: string | null;
  /**
   * The URL of the wiki's content license (on most Wikimedia wikis a CC BY-SA
   * 4.0 URL such as `"https://creativecommons.org/licenses/by-sa/4.0/deed.en"`;
   * Wikinews uses CC BY), trimmed but not validated as a URL or checked for its
   * scheme, so check that it is `https:` before using it as a link; `null` when
   * absent or empty. The license is the wiki's site-wide one, not specific to
   * the revision.
   */
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
    latestTimestamp: Predicate.isString(response.latest?.timestamp)
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
    minor: Predicate.isBoolean(response.minor) ? response.minor : null,
    timestamp: Predicate.isString(response.timestamp) ? response.timestamp.slice(0, 40) : null,
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
