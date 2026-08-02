/**
 * @copyright Thomas Foster
 *
 * The **Action** surface: MediaWiki's `action=query` / `action=parse`
 * endpoints (`/w/api.php`) — page wikitext, page metadata, search, and the
 * `parse` endpoint's typed sections / links / categories / templates.
 *
 * Imports only {@link "./core"} — never `Rest` or `Commons` — so a consumer
 * that imports only `Action` from the package barrel never pulls those
 * modules' code into a bundle.
 *
 * Untrusted-response discipline (mirrors wikidata): every schema below is
 * deliberately lenient (fields optional, values left `Unknown` where their
 * shape varies) so a partial or unexpected payload decodes rather than
 * throwing; the normalisers next to each schema then extract and sanitise
 * only the fields this module trusts. A hostile or malformed response can
 * at worst yield fewer / no results, never an injection.
 *
 * @module action
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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
  contentmodel: Schema.optional(Schema.Unknown),
  // The Action API's wikitext slot content key is the literal `"*"`.
  "*": Schema.optional(Schema.Unknown),
});

const Revision = Schema.Struct({
  revid: Schema.optional(Schema.Unknown),
  timestamp: Schema.optional(Schema.Unknown),
  slots: Schema.optional(Schema.Struct({ main: Schema.optional(RevisionSlot) })),
});

const WikitextPage = Schema.Struct({
  pageid: Schema.optional(Schema.Unknown),
  title: Schema.optional(Schema.Unknown),
  missing: Schema.optional(Schema.Unknown),
  revisions: Schema.optional(Schema.Array(Revision)),
});

/** Lenient schema for the `action=query&prop=revisions&rvslots=main` response envelope. */
export const WikitextResponse = Schema.Struct({
  query: Schema.optional(
    Schema.Struct({
      pages: Schema.optional(Schema.Record(Schema.String, WikitextPage)),
    }),
  ),
});
export type WikitextResponse = typeof WikitextResponse.Type;

/** A page's current (or requested) wikitext, plus the identifying revision. */
export interface WikitextResult {
  readonly pageId: number | null;
  readonly title: string;
  readonly revisionId: number | null;
  readonly timestamp: string | null;
  readonly wikitext: string;
}

/** Normalises a `WikitextResponse` for the requested `title`; `null` on a missing page or no wikitext. */
export function normaliseWikitext(
  response: WikitextResponse,
  title: string,
): WikitextResult | null {
  const pages = Object.values(response.query?.pages ?? {});
  const page = pages.find((p) => p.missing === undefined && p.revisions !== undefined);
  if (page === undefined) return null;
  const revision = page.revisions?.[0];
  const wikitext = revision?.slots?.main?.["*"];
  if (typeof wikitext !== "string") return null;
  return {
    pageId: toNonNegativeInt(page.pageid),
    title: sanitiseText(page.title) ?? title,
    revisionId: toNonNegativeInt(revision?.revid),
    timestamp: typeof revision?.timestamp === "string" ? revision.timestamp.slice(0, 40) : null,
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
  pageid: Schema.optional(Schema.Unknown),
  title: Schema.optional(Schema.Unknown),
  missing: Schema.optional(Schema.Unknown),
  contentmodel: Schema.optional(Schema.Unknown),
  pagelanguage: Schema.optional(Schema.Unknown),
  touched: Schema.optional(Schema.Unknown),
  lastrevid: Schema.optional(Schema.Unknown),
  length: Schema.optional(Schema.Unknown),
  fullurl: Schema.optional(Schema.Unknown),
});

/** Lenient schema for the `action=query&prop=info` response envelope. */
export const PageMetadataResponse = Schema.Struct({
  query: Schema.optional(
    Schema.Struct({
      pages: Schema.optional(Schema.Record(Schema.String, MetadataPage)),
    }),
  ),
});
export type PageMetadataResponse = typeof PageMetadataResponse.Type;

/** A page's identity and bookkeeping metadata. */
export interface PageMetadata {
  readonly pageId: number | null;
  readonly title: string;
  readonly contentModel: string | null;
  readonly language: string | null;
  readonly touched: string | null;
  readonly lastRevisionId: number | null;
  readonly length: number | null;
  readonly fullUrl: string | null;
}

/** A URL string, re-validated as `https:` before being trusted, or `null`. */
function toHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Normalises a `PageMetadataResponse` for the requested `title`; `null` when the page is missing. */
export function normalisePageMetadata(
  response: PageMetadataResponse,
  title: string,
): PageMetadata | null {
  const pages = Object.values(response.query?.pages ?? {});
  const page = pages.find((p) => p.missing === undefined);
  if (page === undefined) return null;
  return {
    pageId: toNonNegativeInt(page.pageid),
    title: sanitiseText(page.title) ?? title,
    contentModel: sanitiseText(page.contentmodel),
    language: sanitiseText(page.pagelanguage),
    touched: typeof page.touched === "string" ? page.touched.slice(0, 40) : null,
    lastRevisionId: toNonNegativeInt(page.lastrevid),
    length: toNonNegativeInt(page.length, 100_000_000),
    fullUrl: toHttpsUrl(page.fullurl),
  };
}

/** Fetches a page's identity/bookkeeping metadata. Returns `null` when the page does not exist upstream. */
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
  pageid: Schema.optional(Schema.Unknown),
  title: Schema.optional(Schema.Unknown),
  snippet: Schema.optional(Schema.Unknown),
  wordcount: Schema.optional(Schema.Unknown),
});

/** Lenient schema for the `action=query&list=search` response envelope. */
export const SearchResponse = Schema.Struct({
  query: Schema.optional(
    Schema.Struct({
      search: Schema.optional(Schema.Array(SearchHit)),
    }),
  ),
});
export type SearchResponse = typeof SearchResponse.Type;

/** One search hit, with its HTML-snippet excerpt (Wikimedia wraps matches in `<span class="searchmatch">`). */
export interface SearchResult {
  readonly pageId: number | null;
  readonly title: string;
  readonly snippet: string | null;
  readonly wordCount: number | null;
}

/** Normalises a `SearchResponse`, bounding the result count and dropping unusably-titled hits. */
export function normaliseSearch(response: SearchResponse): readonly SearchResult[] {
  const out: SearchResult[] = [];
  for (const hit of response.query?.search ?? []) {
    if (out.length >= MAX_SEARCH_RESULTS) break;
    const title = sanitiseText(hit.title);
    if (title === null) continue;
    out.push({
      pageId: toNonNegativeInt(hit.pageid),
      title,
      snippet: sanitiseText(hit.snippet),
      wordCount: toNonNegativeInt(hit.wordcount),
    });
  }
  return out;
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
  toclevel: Schema.optional(Schema.Unknown),
  level: Schema.optional(Schema.Unknown),
  line: Schema.optional(Schema.Unknown),
  anchor: Schema.optional(Schema.Unknown),
});

/** A link/category/template entry keyed by the wikitext `"*"` (page-title) convention. */
const TitledEntry = Schema.Struct({
  "*": Schema.optional(Schema.Unknown),
});

const ParseResult = Schema.Struct({
  title: Schema.optional(Schema.Unknown),
  pageid: Schema.optional(Schema.Unknown),
  sections: Schema.optional(Schema.Array(ParseSection)),
  links: Schema.optional(Schema.Array(TitledEntry)),
  categories: Schema.optional(Schema.Array(TitledEntry)),
  templates: Schema.optional(Schema.Array(TitledEntry)),
});

/** Lenient schema for the `action=parse` response envelope. */
export const ParseResponse = Schema.Struct({
  parse: Schema.optional(ParseResult),
});
export type ParseResponse = typeof ParseResponse.Type;

/** One section heading from a parsed page. */
export interface ParsedSection {
  readonly level: number | null;
  readonly title: string;
  readonly anchor: string | null;
}

/** A parsed page's structural outline — headings, outgoing links, categories, and transcluded templates. */
export interface ParsedPage {
  readonly pageId: number | null;
  readonly title: string;
  readonly sections: readonly ParsedSection[];
  readonly links: readonly string[];
  readonly categories: readonly string[];
  readonly templates: readonly string[];
}

/** Cap on how many entries any single list field (sections/links/categories/templates) keeps. */
export const MAX_PARSE_ENTRIES = 500;

function titledEntries(
  entries: readonly { readonly "*"?: unknown }[] | undefined,
): readonly string[] {
  const out: string[] = [];
  for (const entry of entries ?? []) {
    if (out.length >= MAX_PARSE_ENTRIES) break;
    const title = sanitiseText(entry["*"]);
    if (title !== null) out.push(title);
  }
  return out;
}

/** Normalises a `ParseResponse`; `null` when the endpoint returned no `parse` result (page missing). */
export function normaliseParse(response: ParseResponse, title: string): ParsedPage | null {
  const parsed = response.parse;
  if (parsed === undefined) return null;
  const sections: ParsedSection[] = [];
  for (const section of parsed.sections ?? []) {
    if (sections.length >= MAX_PARSE_ENTRIES) break;
    const sectionTitle = sanitiseText(section.line);
    if (sectionTitle === null) continue;
    sections.push({
      level: toNonNegativeInt(
        typeof section.level === "string" ? Number(section.level) : section.level,
        20,
      ),
      title: sectionTitle,
      anchor: sanitiseText(section.anchor),
    });
  }
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
