/**
 * @copyright Thomas Foster
 *
 * The **Commons** surface: Wikimedia Commons file info and stable
 * `Special:FilePath` URL construction. Subsumes the `normaliseCommonsImage`
 * logic previously duplicated in `packages/wikidata/src/candidate.ts` —
 * that package will depend on this one instead (issue #1067).
 *
 * Imports only {@link "./core"} — never `Action` or `Rest` — so a consumer
 * that imports only `Commons` from the package barrel never pulls those
 * modules' code into a bundle.
 *
 * @module commons
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  DEFAULT_RETRY_OPTIONS,
  normaliseTitle,
  requireTitle,
  type RetryOptions,
  toNonNegativeInt,
  WikimediaClient,
} from "./core";

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
 * `null` for unusable input, matching wikidata's `normaliseCommonsImage`.
 *
 * `Special:FilePath` redirects to the actual media URL, and — given
 * `?width=`, an integer bounded by {@link MAX_THUMBNAIL_WIDTH} — to a
 * generated thumbnail instead of the original.
 */
export function filePathUrl(filename: string, options?: FilePathOptions): string | null {
  const title = normaliseTitle(filename.replace(/^File:/i, ""));
  if (title === null) return null;
  const url = new URL(
    `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(title)}`,
  );
  if (options?.width !== undefined) {
    if (
      !Number.isInteger(options.width) ||
      options.width <= 0 ||
      options.width > MAX_THUMBNAIL_WIDTH
    ) {
      return null;
    }
    url.searchParams.set("width", String(options.width));
  }
  return url.toString();
}

// ── File info (Action API imageinfo) ────────────────────────────────────

/** Lenient schema for one `imageinfo` entry. */
const ImageInfoEntry = Schema.Struct({
  url: Schema.optional(Schema.Unknown),
  descriptionurl: Schema.optional(Schema.Unknown),
  width: Schema.optional(Schema.Unknown),
  height: Schema.optional(Schema.Unknown),
  mime: Schema.optional(Schema.Unknown),
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
  readonly url: string | null;
  /** The `File:` description page URL. */
  readonly descriptionUrl: string | null;
  /** Pixel width, when known. */
  readonly width: number | null;
  /** Pixel height, when known. */
  readonly height: number | null;
  /** The MIME type, e.g. `"image/jpeg"`. */
  readonly mime: string | null;
  /** File size in bytes, when known. */
  readonly size: number | null;
}

/** A URL string re-validated against a fixed allowed-host set, or `null`. */
function toWikimediaMediaUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if (
    host === "upload.wikimedia.org" ||
    host.endsWith(".wikipedia.org") ||
    host.endsWith(".wikimedia.org")
  ) {
    return parsed.toString();
  }
  return null;
}

/** A `FileInfoPage` carrying a real title that Wikimedia didn't flag as missing. */
function isUsableFilePage(page: FileInfoPage): boolean {
  return typeof page.title === "string" && page.missing === undefined;
}

function normaliseFileInfo(response: FileInfoResponse, title: string): FileInfo | null {
  const page = Object.values(response.query?.pages ?? {}).find(isUsableFilePage);
  if (page === undefined) return null;
  const entry: ImageInfoEntry = page.imageinfo?.[0] ?? {};
  return {
    title: typeof page.title === "string" ? page.title : title,
    url: toWikimediaMediaUrl(entry.url),
    descriptionUrl: toWikimediaMediaUrl(entry.descriptionurl),
    width: toNonNegativeInt(entry.width, 100_000),
    height: toNonNegativeInt(entry.height, 100_000),
    mime: typeof entry.mime === "string" ? entry.mime.slice(0, 100) : null,
    size: toNonNegativeInt(entry.size, 10_000_000_000),
  };
}

/**
 * Fetches file metadata (direct URL, description-page URL, dimensions,
 * MIME type, size) for a Commons (or other-wiki-local) media file, via the
 * Action API's `imageinfo` prop. `filename` accepts a bare filename or a
 * `File:`-prefixed title; `host` is typically `"commons.wikimedia.org"` but
 * any validated Wikimedia host works (files can be local to a wiki).
 * Returns `null` when no such file exists upstream.
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
