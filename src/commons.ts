/**
 * The **Commons** surface: Wikimedia Commons file info and stable
 * `Special:FilePath` URL construction.
 *
 * `getFileInfo` requests are anonymous: `Core` sends every `/w/api.php` request with
 * `origin=*`, so a browser page on another origin can read the response,
 * and MediaWiki then ignores any session cookies or `Authorization` header
 * (see {@link Core.WikimediaRequest}).
 *
 * Imports only {@link Core} — never `Action` or `Rest` — so a consumer
 * that imports only `Commons` from the package barrel never pulls those
 * modules' code into a bundle.
 *
 * @copyright Thomas Foster
 * @module
 */

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Str from "effect/String";
import * as Schema from "effect/Schema";
import {
  DEFAULT_RETRY_OPTIONS,
  lenientField,
  normaliseTitle,
  requireTitle,
  type RetryOptions,
  toNonNegativeInt,
  WikimediaClient,
} from "./core.ts";

// ── FilePath URL construction ───────────────────────────────────────────

/** Cap on a thumbnail width request, defensive against an absurd caller value. */
export const MAX_THUMBNAIL_WIDTH = 10_000;

/** Options for {@link filePathUrl}. */
export interface FilePathOptions {
  /** Request a thumbnail of this pixel width instead of the full-size original. */
  readonly width?: number;
}

/**
 * Builds a Commons file's stable `Special:FilePath` URL. `filename` is the
 * bare filename (with or without a leading `File:` prefix — either is
 * accepted and normalised away) and is validated by {@link normaliseTitle}
 * before being percent-encoded into the fixed `commons.wikimedia.org` host,
 * so a hostile filename can never redirect the URL elsewhere. Returns
 * `None` for unusable input, matching `Reconciliation.normaliseCommonsImage`,
 * including a lone UTF-16 surrogate (which would make `encodeURIComponent`
 * throw) and a relative-path filename such as `..` (checked after the
 * `File:` prefix is removed) that would otherwise resolve to another path.
 *
 * `Special:FilePath` redirects to the actual media URL, and — given
 * `?width=`, an integer bounded by {@link MAX_THUMBNAIL_WIDTH} — to a
 * generated thumbnail instead of the original.
 */
export function filePathUrl(filename: string, options?: FilePathOptions): Option.Option<string> {
  const title = normaliseTitle(filename.replace(/^File:/i, ""));
  if (title === null) return Option.none();
  const url = new URL(
    `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(title)}`,
  );
  if (options?.width !== undefined) {
    if (
      !Number.isInteger(options.width) ||
      options.width <= 0 ||
      options.width > MAX_THUMBNAIL_WIDTH
    ) {
      return Option.none();
    }
    url.searchParams.set("width", String(options.width));
  }
  return Option.some(url.toString());
}

// ── File info (Action API imageinfo) ────────────────────────────────────

/** Lenient schema for one `imageinfo` entry. */
const ImageInfoEntry = Schema.Struct({
  /** The file's direct URL, which {@link FileInfo.url} re-validates. */
  url: lenientField(Schema.String),
  /** The file description page's URL, which {@link FileInfo.descriptionUrl} re-validates. */
  descriptionurl: lenientField(Schema.String),
  /** The width in pixels. */
  width: Schema.optional(Schema.Unknown),
  /** The height in pixels. */
  height: Schema.optional(Schema.Unknown),
  /** The MIME type. */
  mime: lenientField(Schema.String),
  /** The size in bytes. */
  size: Schema.optional(Schema.Unknown),
});
type ImageInfoEntry = typeof ImageInfoEntry.Type;

/** Lenient schema for one `query.pages[*]` entry carrying `imageinfo`. */
const FileInfoPage = Schema.Struct({
  title: Schema.optional(Schema.Unknown),
  missing: Schema.optional(Schema.Unknown),
  imageinfo: Schema.optional(Schema.Array(ImageInfoEntry)),
});
type FileInfoPage = typeof FileInfoPage.Type;

/** Lenient schema for the `action=query&prop=imageinfo` response envelope. */
const FileInfoResponse = Schema.Struct({
  query: Schema.optional(
    Schema.Struct({
      pages: Schema.optional(Schema.Record(Schema.String, FileInfoPage)),
    }),
  ),
});
type FileInfoResponse = typeof FileInfoResponse.Type;

/** File metadata for a Commons (or other-wiki-local) media file. */
export interface FileInfo {
  /** The canonical `File:`-namespaced title. */
  readonly title: string;
  /** The direct media URL. */
  readonly url: Option.Option<string>;
  /** The `File:` description page URL. */
  readonly descriptionUrl: Option.Option<string>;
  /** Pixel width, when known. */
  readonly width: Option.Option<number>;
  /** Pixel height, when known. */
  readonly height: Option.Option<number>;
  /** The MIME type, e.g. `"image/jpeg"`. */
  readonly mime: Option.Option<string>;
  /** File size in bytes, when known. */
  readonly size: Option.Option<number>;
}

/** `new URL(value)`, or `None` when it throws on an unparseable URL. */
const parseUrl = Option.liftThrowable((value: string) => new URL(value));

/** Whether `url` is `https:` on one of the hosts Commons media is served from. */
function isMediaUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === "https:" &&
    (host === "upload.wikimedia.org" ||
      host.endsWith(".wikipedia.org") ||
      host.endsWith(".wikimedia.org"))
  );
}

/** A URL string re-validated against a fixed allowed-host set, or `None`. */
function toWikimediaMediaUrl(value: string | undefined): Option.Option<string> {
  const candidate =
    value !== undefined && Str.isNonEmpty(value) && value.length <= 2000
      ? parseUrl(value)
      : Option.none();
  return Option.map(Option.filter(candidate, isMediaUrl), (url) => url.toString());
}

/** A `FileInfoPage` carrying a real title that Wikimedia didn't flag as missing. */
function isUsableFilePage(page: FileInfoPage): boolean {
  return P.isString(page.title) && page.missing === undefined;
}

function normaliseFileInfo(response: FileInfoResponse, title: string): Option.Option<FileInfo> {
  const page = R.values(response.query?.pages ?? {}).find(isUsableFilePage);
  if (page === undefined) return Option.none();
  const entry: ImageInfoEntry = page.imageinfo?.[0] ?? {};
  return Option.some({
    title: P.isString(page.title) ? page.title : title,
    url: toWikimediaMediaUrl(entry.url),
    descriptionUrl: toWikimediaMediaUrl(entry.descriptionurl),
    width: Option.fromNullOr(toNonNegativeInt(entry.width, 100_000)),
    height: Option.fromNullOr(toNonNegativeInt(entry.height, 100_000)),
    mime: Option.map(Option.fromUndefinedOr(entry.mime), (mime) => mime.slice(0, 100)),
    size: Option.fromNullOr(toNonNegativeInt(entry.size, 10_000_000_000)),
  });
}

/**
 * Fetches file metadata (direct URL, description-page URL, dimensions,
 * MIME type, size) for a Commons (or other-wiki-local) media file, via the
 * Action API's `imageinfo` prop. `filename` accepts a bare filename or a
 * `File:`-prefixed title; `host` is typically `"commons.wikimedia.org"` but
 * any validated Wikimedia host works (files can be local to a wiki).
 * Succeeds with `None` when no such file exists upstream. Fails with
 * `InvalidRequest`, before any request is sent, for an invalid host or a
 * filename `normaliseTitle` rejects once the `File:` prefix is removed
 * (including a lone UTF-16 surrogate and the relative-path forms `.` and
 * `..`).
 */
export const getFileInfo = Effect.fn("Commons.getFileInfo")(function* (
  host: string,
  filename: string,
  retry?: RetryOptions,
) {
  const title = yield* requireTitle(filename.replace(/^File:/i, ""), "filename");
  const client = yield* WikimediaClient;
  const response = yield* client.getJson(
    {
      host,
      path: "/w/api.php",
      params: {
        action: "query",
        titles: `File:${title}`,
        prop: "imageinfo",
        iiprop: "url|size|mime",
        format: "json",
      },
    },
    FileInfoResponse,
    retry ?? DEFAULT_RETRY_OPTIONS,
  );
  return normaliseFileInfo(response, title);
});
