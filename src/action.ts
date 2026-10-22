/**
 * The **Action** surface: MediaWiki's `action=query` / `action=parse`
 * endpoints (`/w/api.php`) — page wikitext, page metadata, search, and the
 * `parse` endpoint's typed sections / links / categories / templates.
 *
 * Requests are anonymous: `Core` sends every `/w/api.php` request with
 * `origin=*`, so a browser page on another origin can read the response,
 * and MediaWiki then ignores any session cookies or `Authorization` header
 * (see {@link WikimediaRequest}).
 *
 * Imports only {@link Core} — never `Rest` or `Commons` — so a consumer
 * that imports only `Action` from the package barrel never pulls those
 * modules' code into a bundle.
 *
 * Untrusted-response discipline: every schema below is
 * deliberately lenient (fields optional, values left `Unknown` where their
 * shape varies) so a partial or unexpected payload decodes rather than
 * throwing; the normalisers next to each schema then extract, trim and
 * length-cap only the fields this module trusts. A hostile or malformed
 * response can at worst yield fewer / no results, never an injection into a
 * request.
 * Two result fields are HTML as the wiki sent it, trimmed and length-capped
 * but not sanitised: {@link SearchResult.snippet} and
 * {@link ParsedSection.title}. Escape or sanitise them before putting them
 * into a page.
 *
 * The four `*Response` schemas are those raw wire shapes, the decode step
 * before each `normalise*` function. Read the typed results the normalisers
 * build ({@link WikitextResult}, {@link PageMetadata},
 * {@link SearchResult}, {@link ParsedPage}), not the raw fields.
 *
 * @copyright Thomas Foster
 * @module
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  DEFAULT_RETRY_OPTIONS,
  InvalidRequest,
  requireTitle,
  type RetryOptions,
  sanitiseText,
  toNonNegativeInt,
  type WikimediaRequest,
  WikimediaClient,
} from "./core.ts";

/** Builds the fixed-path `/w/api.php` request for a given `action` and its params. */
function actionRequest(
  host: string,
  action: string,
  params: Record<string, string>,
): WikimediaRequest {
  return { host, path: "/w/api.php", params: { action, format: "json", ...params } };
}

// ── Wikitext (action=query&prop=revisions) ───────────────────────────────

const RevisionSlot = Schema.Struct({
  /** The slot's content model (`"wikitext"`, `"Scribunto"`, …); not read. */
  contentmodel: Schema.optional(Schema.Unknown),
  // The Action API's wikitext slot content key is the literal `"*"`.
  /** The slot's content; absent when the revision's text is hidden. */
  "*": Schema.optional(Schema.Unknown),
});

const Revision = Schema.Struct({
  /** The revision ID. */
  revid: Schema.optional(Schema.Unknown),
  /** When the revision was saved, as an ISO 8601 UTC string. */
  timestamp: Schema.optional(Schema.Unknown),
  /** The revision's content slots; only `main` is requested. */
  slots: Schema.optional(
    Schema.Struct({
      /** The main slot, which holds the page's wikitext. */
      main: Schema.optional(RevisionSlot),
    }),
  ),
});

const WikitextPage = Schema.Struct({
  /** The page ID; absent for a missing, invalid or special title. */
  pageid: Schema.optional(Schema.Unknown),
  /** The page title, in prefixed display form. */
  title: Schema.optional(Schema.Unknown),
  /** Present (as `""`) when the page does not exist. */
  missing: Schema.optional(Schema.Unknown),
  /** The latest revision, as a one-element array; absent for a missing page. */
  revisions: Schema.optional(Schema.Array(Revision)),
});

/**
 * Lenient schema for the `action=query&prop=revisions&rvslots=main` response
 * envelope: the decode step {@link getWikitext} runs before
 * {@link normaliseWikitext}. Every field is optional and every leaf `Unknown`,
 * so a partial, extended or future-shaped response decodes, but a container of
 * the wrong kind (such as a list that is not an array, or `null` where an
 * object is expected) fails the decode, which {@link getWikitext} reports as a
 * `RequestFailed`. Read the typed {@link WikitextResult} that
 * {@link normaliseWikitext} builds from it, not these fields.
 */
export const WikitextResponse = Schema.Struct({
  /** The query result; absent on an error response. */
  query: Schema.optional(
    Schema.Struct({
      /** The requested pages, keyed by page ID (a negative number for a missing, invalid or special title). */
      pages: Schema.optional(Schema.Record(Schema.String, WikitextPage)),
    }),
  ),
});
export type WikitextResponse = typeof WikitextResponse.Type;

/** A page's current wikitext (its main slot), with the page and revision it came from. */
export interface WikitextResult {
  /**
   * The page's MediaWiki page ID (`pageid`), which stays the same when the page
   * is renamed. `null` if the response's `pageid` is absent or isn't a
   * non-negative number up to `Number.MAX_SAFE_INTEGER`; a fraction is
   * truncated.
   */
  readonly pageId: number | null;
  /**
   * The page's title as MediaWiki reports it: prefixed display form, with
   * spaces rather than underscores, after the wiki's normalisation (such as
   * an upper-case first letter). If the response has no usable title, it is
   * the title as requested after validation, with whitespace runs replaced
   * by `_`.
   */
  readonly title: string;
  /**
   * The ID (`revid`) of the revision the wikitext was read from: the page's
   * latest revision at request time. `null` if the response's `revid` is absent
   * or isn't a non-negative number up to `Number.MAX_SAFE_INTEGER`; a fraction
   * is truncated.
   */
  readonly revisionId: number | null;
  /**
   * When that revision was saved, as the API sent it: an ISO 8601 UTC
   * string such as `2024-01-22T09:15:00Z`. It is cut to 40 characters but
   * not parsed or validated. `null` if the response has no string
   * `timestamp`.
   */
  readonly timestamp: string | null;
  /**
   * The revision's main-slot content, exactly as the API sent it: not
   * trimmed or length-capped, and possibly empty. It is returned whatever
   * the page's content model, so a Lua module or a JSON page yields its
   * source. Redirects are not followed: a redirect page yields its own
   * `#REDIRECT [[…]]` text.
   */
  readonly wikitext: string;
}

/** Normalises a `WikitextResponse` for the requested `title`; `null` on a missing page or no wikitext. */
export function normaliseWikitext(
  response: WikitextResponse,
  title: string,
): WikitextResult | null {
  const pages = Rec.values(response.query?.pages ?? {});
  const page = pages.find((p) => p.missing === undefined && p.revisions !== undefined);
  if (page === undefined) return null;
  const revision = page.revisions?.[0];
  const wikitext = revision?.slots?.main?.["*"];
  if (!Predicate.isString(wikitext)) return null;
  return {
    pageId: toNonNegativeInt(page.pageid),
    title: sanitiseText(page.title) ?? title,
    revisionId: toNonNegativeInt(revision?.revid),
    timestamp: Predicate.isString(revision?.timestamp) ? revision.timestamp.slice(0, 40) : null,
    wikitext,
  };
}

/**
 * Fetches a page's current wikitext (`rvprop=content`, main slot) via the
 * Action API. Returns `null` when the page does not exist upstream.
 */
export const getWikitext = Effect.fn("Action.getWikitext")(function* (
  host: string,
  title: string,
  retry?: RetryOptions,
) {
  const validTitle = yield* requireTitle(title);
  const client = yield* WikimediaClient;
  const response = yield* client.getJson(
    actionRequest(host, "query", {
      titles: validTitle,
      prop: "revisions",
      rvprop: "ids|timestamp|content",
      rvslots: "main",
    }),
    WikitextResponse,
    retry ?? DEFAULT_RETRY_OPTIONS,
  );
  return normaliseWikitext(response, validTitle);
});

// ── Page metadata (action=query&prop=info) ───────────────────────────────

const MetadataPage = Schema.Struct({
  /** The page ID; absent for a missing, invalid or special title. */
  pageid: Schema.optional(Schema.Unknown),
  /** The page title, in prefixed display form. */
  title: Schema.optional(Schema.Unknown),
  /** Present (as `""`) when the page does not exist. */
  missing: Schema.optional(Schema.Unknown),
  /** Present (as `""`) when MediaWiki rejects the title; the entry then has `invalidreason`. */
  invalid: Schema.optional(Schema.Unknown),
  /** Present (as `""`) for a `Special:` or `Media:` title, which names no stored page. */
  special: Schema.optional(Schema.Unknown),
  /** The page's content model. */
  contentmodel: Schema.optional(Schema.Unknown),
  /** MediaWiki's code for the page's content language. */
  pagelanguage: Schema.optional(Schema.Unknown),
  /** When the page was last touched, as an ISO 8601 UTC string. */
  touched: Schema.optional(Schema.Unknown),
  /** The ID of the page's latest revision. */
  lastrevid: Schema.optional(Schema.Unknown),
  /** The latest revision's size in bytes. */
  length: Schema.optional(Schema.Unknown),
  /**
   * The page's full URL (`fullurl`, requested with `inprop=url`); not
   * MediaWiki's separate `canonicalurl`.
   */
  fullurl: Schema.optional(Schema.Unknown),
});

/**
 * Lenient schema for the `action=query&prop=info` response envelope: the decode
 * step {@link getPageMetadata} runs before {@link normalisePageMetadata}. Every
 * field is optional and every leaf `Unknown`, so a partial, extended or
 * future-shaped response decodes, but a container of the wrong kind (such as a
 * list that is not an array, or `null` where an object is expected) fails the
 * decode, which {@link getPageMetadata} reports as a `RequestFailed`. Read the
 * typed {@link PageMetadata} that {@link normalisePageMetadata} builds from it,
 * not these fields.
 */
export const PageMetadataResponse = Schema.Struct({
  /** The query result; absent on an error response. */
  query: Schema.optional(
    Schema.Struct({
      /** The requested pages, keyed by page ID (a negative number for a missing, invalid or special title). */
      pages: Schema.optional(Schema.Record(Schema.String, MetadataPage)),
    }),
  ),
});
export type PageMetadataResponse = typeof PageMetadataResponse.Type;

/**
 * A page's identity and bookkeeping metadata, from `prop=info&inprop=url`.
 * Every field except `title` is `null` when the response lacks it or it
 * fails its check.
 */
export interface PageMetadata {
  /**
   * The page's MediaWiki page ID (`pageid`), which stays the same when the page
   * is renamed. `null` if the response's `pageid` is absent or isn't a
   * non-negative number up to `Number.MAX_SAFE_INTEGER`; a fraction is
   * truncated.
   */
  readonly pageId: number | null;
  /**
   * The page's title as MediaWiki reports it: prefixed display form, with
   * spaces rather than underscores, after the wiki's normalisation (such as
   * an upper-case first letter). If the response has no usable title, it is
   * the title as requested after validation, with whitespace runs replaced
   * by `_`.
   */
  readonly title: string;
  /**
   * The page's content model (`contentmodel`), which says how its source is
   * interpreted: `wikitext` for most pages, or another model such as
   * `Scribunto` (a Lua module), `json`, `css` or `javascript`.
   */
  readonly contentModel: string | null;
  /**
   * MediaWiki's code for the page's content language (`pagelanguage`), such
   * as `en`. It is MediaWiki's own code, which is not always a BCP 47 tag.
   * It is usually the wiki's content language.
   */
  readonly language: string | null;
  /**
   * When the page was last touched (`touched`), as the API sent it: an ISO
   * 8601 UTC string such as `2024-01-22T09:15:00Z`, cut to 40 characters
   * but not parsed or validated. MediaWiki updates it on an edit and also
   * whenever the page's cached rendering is invalidated (a purge, or an edit
   * to a template it uses), so it can be later than the latest revision.
   */
  readonly touched: string | null;
  /** The ID (`lastrevid`) of the page's latest revision. */
  readonly lastRevisionId: number | null;
  /**
   * The size of the latest revision's content (`length`), in bytes of its
   * UTF-8 encoding, not characters. `null` above 100,000,000.
   */
  readonly length: number | null;
  /**
   * The page's full URL (`fullurl`, not MediaWiki's separate `canonicalurl`) as
   * the queried wiki builds it, such as
   * `https://en.wikipedia.org/wiki/Douglas_Adams`. It is re-parsed with `URL`
   * and returned in that serialisation; `null` unless it is an absolute
   * `https:` URL of at most 2000 characters.
   */
  readonly fullUrl: string | null;
}

/** A URL string, re-validated as `https:` before being trusted, or `null`. */
function toHttpsUrl(value: unknown): string | null {
  if (!Predicate.isString(value) || Str.isEmpty(value) || value.length > 2000) return null;
  return parseUrl(value).pipe(
    Option.filter((parsed) => parsed.protocol === "https:"),
    Option.map((parsed) => parsed.toString()),
    Option.getOrNull,
  );
}

/** `new URL(value)`, or `None` when it throws on an unparseable URL. */
const parseUrl = Option.liftThrowable((value: string) => new URL(value));

/**
 * Normalises a `PageMetadataResponse` for the requested `title`. Returns
 * `null` when the response has no entry for a stored page: every entry is
 * flagged `missing`, `invalid` (a title MediaWiki rejects) or `special` (a
 * `Special:` or `Media:` title), or there are no entries.
 */
export function normalisePageMetadata(
  response: PageMetadataResponse,
  title: string,
): PageMetadata | null {
  const pages = Rec.values(response.query?.pages ?? {});
  const page = pages.find(
    (p) => p.missing === undefined && p.invalid === undefined && p.special === undefined,
  );
  if (page === undefined) return null;
  return {
    pageId: toNonNegativeInt(page.pageid),
    title: sanitiseText(page.title) ?? title,
    contentModel: sanitiseText(page.contentmodel),
    language: sanitiseText(page.pagelanguage),
    touched: Predicate.isString(page.touched) ? page.touched.slice(0, 40) : null,
    lastRevisionId: toNonNegativeInt(page.lastrevid),
    length: toNonNegativeInt(page.length, 100_000_000),
    fullUrl: toHttpsUrl(page.fullurl),
  };
}

/**
 * Fetches a page's identity and bookkeeping metadata via the Action API's
 * `prop=info`. Returns `null` when the title names no stored page upstream:
 * the page does not exist, MediaWiki rejects the title as invalid (for
 * example `Talk:../Foo`, a relative path after the namespace prefix, which
 * {@link Core.requireTitle} lets through), it is a `Special:` or `Media:` title, existing or not, or it is
 * an interwiki title (`fr:Foo` on an English wiki), which the API reports
 * under `query.interwiki` with no page entry.
 * Fails with {@link InvalidRequest}, before any request is sent, for an
 * invalid host or a title {@link Core.requireTitle} rejects;
 * {@link Core.RateLimited} for a `429` / `503` or a `maxlag` error once
 * `retry` (default {@link Core.DEFAULT_RETRY_OPTIONS}) is exhausted; and
 * {@link Core.RequestFailed} for any other non-2xx status, a transport error
 * or a response that does not decode.
 */
export const getPageMetadata = Effect.fn("Action.getPageMetadata")(function* (
  host: string,
  title: string,
  retry?: RetryOptions,
) {
  const validTitle = yield* requireTitle(title);
  const client = yield* WikimediaClient;
  const response = yield* client.getJson(
    actionRequest(host, "query", { titles: validTitle, prop: "info", inprop: "url" }),
    PageMetadataResponse,
    retry ?? DEFAULT_RETRY_OPTIONS,
  );
  return normalisePageMetadata(response, validTitle);
});

// ── Search (action=query&list=search) ────────────────────────────────────

/** Cap on how many search results a single call returns. */
export const MAX_SEARCH_RESULTS = 50;

const SearchHit = Schema.Struct({
  /** The matching page's ID. */
  pageid: Schema.optional(Schema.Unknown),
  /** The matching page's title, in prefixed display form. */
  title: Schema.optional(Schema.Unknown),
  /** An HTML excerpt around the match. */
  snippet: Schema.optional(Schema.Unknown),
  /** The page's word count. */
  wordcount: Schema.optional(Schema.Unknown),
});

/**
 * Lenient schema for the `action=query&list=search` response envelope: the
 * decode step {@link search} runs before {@link normaliseSearch}. Every field
 * is optional and every leaf `Unknown`, so a partial, extended or future-shaped
 * response decodes, but a container of the wrong kind (such as a list that is
 * not an array, or `null` where an object is expected) fails the decode, which
 * {@link search} reports as a `RequestFailed`. Read the typed
 * {@link SearchResult}s that {@link normaliseSearch} builds from it, not these
 * fields.
 */
export const SearchResponse = Schema.Struct({
  /** The query result; absent on an error response. */
  query: Schema.optional(
    Schema.Struct({
      /** The hits, in the search engine's relevance order. */
      search: Schema.optional(Schema.Array(SearchHit)),
    }),
  ),
});
export type SearchResponse = typeof SearchResponse.Type;

/** One search hit, with its HTML-snippet excerpt (Wikimedia wraps matches in `<span class="searchmatch">`). */
export interface SearchResult {
  /**
   * The matching page's MediaWiki page ID (`pageid`). `null` if the hit's
   * `pageid` is absent or isn't a non-negative number up to
   * `Number.MAX_SAFE_INTEGER`; a fraction is truncated.
   */
  readonly pageId: number | null;
  /**
   * The matching page's title as MediaWiki reports it: prefixed display
   * form, with spaces rather than underscores. Trimmed, and never empty: a
   * hit without a usable title is dropped from the results.
   */
  readonly title: string;
  /**
   * An excerpt of the page's text around the match, as HTML: matched terms
   * are wrapped in `<span class="searchmatch">`. It is trimmed and capped at
   * {@link Core.MAX_TEXT_FIELD_LENGTH} UTF-16 code units but not sanitised, so
   * escape or sanitise it before putting it into a page. `null` if the
   * excerpt is absent or empty.
   */
  readonly snippet: string | null;
  /** The number of words in the page (`wordcount`), as the search index counts them. */
  readonly wordCount: number | null;
}

/** Normalises a `SearchResponse`, bounding the result count and dropping unusably-titled hits. */
export function normaliseSearch(response: SearchResponse): readonly SearchResult[] {
  const results = Arr.getSomes(
    Arr.map(response.query?.search ?? [], (hit) =>
      Option.map(Option.fromNullOr(sanitiseText(hit.title)), (title): SearchResult => ({
        pageId: toNonNegativeInt(hit.pageid),
        title,
        snippet: sanitiseText(hit.snippet),
        wordCount: toNonNegativeInt(hit.wordcount),
      })),
    ),
  );
  return Arr.take(results, MAX_SEARCH_RESULTS);
}

/** Options for {@link search}. */
export interface SearchOptions {
  /** Max results, bounded by {@link MAX_SEARCH_RESULTS}. Defaults to 10. */
  readonly limit?: number;
}

/** Full-text searches a wiki via `list=search`. An empty upstream result is an empty list, not an error. */
export const search = Effect.fn("Action.search")(function* (
  host: string,
  query: string,
  options?: SearchOptions,
  retry?: RetryOptions,
) {
  const cleanedQuery = sanitiseText(query);
  if (cleanedQuery === null) return yield* new InvalidRequest({ kind: "query", value: query });
  const limit = Math.min(Math.max(options?.limit ?? 10, 1), MAX_SEARCH_RESULTS);
  const client = yield* WikimediaClient;
  const response = yield* client.getJson(
    actionRequest(host, "query", {
      list: "search",
      srsearch: cleanedQuery,
      srlimit: String(limit),
    }),
    SearchResponse,
    retry ?? DEFAULT_RETRY_OPTIONS,
  );
  return normaliseSearch(response);
});

// ── Parse (action=parse) ─────────────────────────────────────────────────

const ParseSection = Schema.Struct({
  /** The heading's nesting depth in the table of contents; not read. */
  toclevel: Schema.optional(Schema.Unknown),
  /** The heading level, as a numeric string (`"2"` for `== x ==`). */
  level: Schema.optional(Schema.Unknown),
  /** The heading's text, as HTML. */
  line: Schema.optional(Schema.Unknown),
  /** The heading's fragment ID. */
  anchor: Schema.optional(Schema.Unknown),
});

/** A link/category/template entry keyed by the wikitext `"*"` (page-title) convention. */
const TitledEntry = Schema.Struct({
  /** The entry's title (a category's in database form, without its prefix). */
  "*": Schema.optional(Schema.Unknown),
});

const ParseResult = Schema.Struct({
  /** The parsed page's title, in prefixed display form. */
  title: Schema.optional(Schema.Unknown),
  /** The parsed page's ID. */
  pageid: Schema.optional(Schema.Unknown),
  /** The page's section headings, in document order. */
  sections: Schema.optional(Schema.Array(ParseSection)),
  /** The wiki pages the page links to. */
  links: Schema.optional(Schema.Array(TitledEntry)),
  /** The categories the page is in. */
  categories: Schema.optional(Schema.Array(TitledEntry)),
  /** The pages transcluded while parsing. */
  templates: Schema.optional(Schema.Array(TitledEntry)),
});

/**
 * Lenient schema for the `action=parse` response envelope: the decode step
 * {@link parsePage} runs before {@link normaliseParse}. Every field is optional
 * and every leaf `Unknown`, so a partial, extended or future-shaped response
 * decodes, but a container of the wrong kind (such as a list that is not an
 * array, or `null` where an object is expected) fails the decode, which
 * {@link parsePage} reports as a `RequestFailed`. Read the typed
 * {@link ParsedPage} that {@link normaliseParse} builds from it, not these
 * fields.
 */
export const ParseResponse = Schema.Struct({
  /** The parse result; absent on an error response, such as for a missing page. */
  parse: Schema.optional(ParseResult),
});
export type ParseResponse = typeof ParseResponse.Type;

/** One section heading from a parsed page. */
export interface ParsedSection {
  /**
   * The heading's level: the number of `=` around it in wikitext, so `2` for
   * `== Life ==`, or the `<hN>` number of an HTML heading. `null` unless the
   * response's `level` is a number, or a numeric string, from 0 to 20; a
   * fraction is truncated, and an empty string reads as `0`.
   */
  readonly level: number | null;
  /**
   * The heading's text as HTML (the API's `line`), not wikitext: MediaWiki
   * renders it and keeps only some inline tags (such as `<i>`, `<b>`,
   * `<sup>`, `<sub>` and `<span>`). It is trimmed and capped at
   * {@link Core.MAX_TEXT_FIELD_LENGTH} UTF-16 code units but not sanitised, so
   * escape or sanitise it before putting it into a page. Never empty: a
   * section without a usable heading is dropped.
   */
  readonly title: string;
  /**
   * The heading's fragment ID (`anchor`), for linking to the section as
   * `#anchor`, such as `Early_life`. MediaWiki makes it unique within the
   * page, adding `_2`, `_3` and so on to repeated headings. `null` if the
   * response has none.
   */
  readonly anchor: string | null;
}

/** A parsed page's structural outline — headings, outgoing links, categories, and transcluded templates. */
export interface ParsedPage {
  /**
   * The parsed page's MediaWiki page ID (`pageid`). `null` if the response's
   * `pageid` is absent or isn't a non-negative number up to
   * `Number.MAX_SAFE_INTEGER`; a fraction is truncated.
   */
  readonly pageId: number | null;
  /**
   * The parsed page's title as MediaWiki reports it: prefixed display form,
   * with spaces rather than underscores. Redirects are not followed, so for a
   * redirect page this is the redirect's own title. If the response has no
   * usable title, it is the title as requested after validation, with
   * whitespace runs replaced by `_`.
   */
  readonly title: string;
  /**
   * The page's section headings in document order, including those a
   * transcluded page contributes. A heading without usable text is skipped,
   * and at most {@link MAX_PARSE_ENTRIES} are kept.
   */
  readonly sections: readonly ParsedSection[];
  /**
   * The titles of the wiki pages the rendered page links to (`links`), prefixed
   * and with spaces, such as `Help:Contents`. They include links added by
   * transcluded templates and links to pages that don't exist. Interwiki and
   * interlanguage links, category assignments, file embeds (`[[File:…]]`) and
   * `Special:` links are not included. In the API's order, which groups them by
   * namespace rather than following the page, at most
   * {@link MAX_PARSE_ENTRIES}.
   */
  readonly links: readonly string[];
  /**
   * The categories the page is in (`categories`), including hidden ones and
   * those added by templates. Each is the category's name in database form:
   * no `Category:` prefix, and underscores rather than spaces, such as
   * `English_novelists`. In the API's order, at most
   * {@link MAX_PARSE_ENTRIES}.
   */
  readonly categories: readonly string[];
  /**
   * The titles of the pages transcluded while parsing (`templates`), directly
   * or through other templates, prefixed and with spaces, such as
   * `Template:Infobox writer`. They include modules a template invokes
   * (`Module:` pages) and pages that don't exist. In the API's order, which
   * groups them by namespace rather than following the page, at most
   * {@link MAX_PARSE_ENTRIES}.
   */
  readonly templates: readonly string[];
}

/** Cap on how many entries any single list field (sections/links/categories/templates) keeps. */
export const MAX_PARSE_ENTRIES = 500;

function titledEntries(
  entries: readonly { readonly "*"?: unknown }[] | undefined,
): readonly string[] {
  const titles = Arr.getSomes(
    Arr.map(entries ?? [], (entry) => Option.fromNullOr(sanitiseText(entry["*"]))),
  );
  return Arr.take(titles, MAX_PARSE_ENTRIES);
}

/** Normalises a `ParseResponse`; `null` when the endpoint returned no `parse` result (page missing). */
export function normaliseParse(response: ParseResponse, title: string): ParsedPage | null {
  const parsed = response.parse;
  if (parsed === undefined) return null;
  const sections = Arr.take(
    Arr.getSomes(
      Arr.map(parsed.sections ?? [], (section) =>
        Option.map(
          Option.fromNullOr(sanitiseText(section.line)),
          (sectionTitle): ParsedSection => ({
            level: toNonNegativeInt(
              Predicate.isString(section.level) ? Number(section.level) : section.level,
              20,
            ),
            title: sectionTitle,
            anchor: sanitiseText(section.anchor),
          }),
        ),
      ),
    ),
    MAX_PARSE_ENTRIES,
  );
  return {
    pageId: toNonNegativeInt(parsed.pageid),
    title: sanitiseText(parsed.title) ?? title,
    sections,
    links: titledEntries(parsed.links),
    categories: titledEntries(parsed.categories),
    templates: titledEntries(parsed.templates),
  };
}

/**
 * Parses a page via `action=parse`, returning its section outline, outgoing
 * links, categories, and transcluded templates. Returns `null` when the
 * page does not exist upstream (the endpoint answers an `error` body with
 * no `parse` key, which decodes cleanly under the lenient schema).
 */
export const parsePage = Effect.fn("Action.parsePage")(function* (
  host: string,
  title: string,
  retry?: RetryOptions,
) {
  const validTitle = yield* requireTitle(title);
  const client = yield* WikimediaClient;
  const response = yield* client.getJson(
    actionRequest(host, "parse", { page: validTitle, prop: "sections|links|categories|templates" }),
    ParseResponse,
    retry ?? DEFAULT_RETRY_OPTIONS,
  );
  return normaliseParse(response, validTitle);
});
