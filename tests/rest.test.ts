/**
 * Unit tests for the Rest surface (`src/rest.ts`): typed page/revision
 * metadata (JSON) and parsed HTML (`text/html`) for a title or revision.
 * The network is stubbed at `FetchHttpClient.Fetch` — no live network
 * anywhere in this suite.
 *
 * @module tests/rest
 */

import { layer } from "@effect/vitest";
import { assertInstanceOf } from "@effect/vitest/utils";
import { expect } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import { FetchHttpClient } from "effect/http";
import { Core, Rest } from "../src/index.ts";

interface StubRoute {
  readonly status: number;
  readonly body: unknown;
  readonly contentType?: string;
}

const stubRouter = (routes: Record<string, StubRoute>) => {
  const urls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    urls.push(request.url);
    return Arr.findFirst(R.keys(routes), (k) => request.url.includes(k)).pipe(
      Option.flatMap((key) => R.get(routes, key)),
      Option.match({
        onNone: () => new Response("", { status: 404 }),
        onSome: (route) => {
          const contentType = route.contentType ?? "application/json";
          return contentType === "application/json"
            ? Response.json(route.body, { status: route.status })
            : new Response(String(route.body), {
                status: route.status,
                headers: { "content-type": contentType },
              });
        },
      }),
    );
  };
  return { urls, provideFetch: Effect.provideService(FetchHttpClient.Fetch, fetch) };
};

/**
 * MediaWiki's relative-path title forms (`TitleParser`'s
 * `title-invalid-relative`). Unrejected, `.` and `..` are removed by
 * `new URL`'s dot-segment normalisation: `getPageMetadata("..")` requests
 * `/w/rest.php/v1/bare` and `getParsedHtml(".")` requests `/w/rest.php/v1/page/html`.
 */
const RELATIVE_TITLES = [
  ".",
  "..",
  " .. ",
  "./Foo",
  "../Foo",
  "Foo/./Bar",
  "Foo/../Bar",
  "Foo/.",
  "Foo/..",
];

/**
 * Titles carrying a lone UTF-16 surrogate. Unrejected, `encodeURIComponent`
 * throws `URIError` while the REST path is built, which surfaces as a defect
 * rather than the typed `InvalidRequest`.
 */
const LONE_SURROGATE_TITLES = ["Foo\uD800Bar", "Foo\uDC00Bar", "\uD83D", "\uDE00\uD83D"];

layer(Core.wikimediaLayer)("Rest.getPageMetadata", (it) => {
  it.effect("extracts page identity metadata", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubRouter({
        "/page/Douglas_Adams": {
          status: 200,
          body: {
            id: 42,
            key: "Douglas_Adams",
            title: "Douglas Adams",
            content_model: "wikitext",
            latest: { id: 987654, timestamp: "2024-01-01T00:00:00Z" },
            license: {
              url: "https://creativecommons.org/licenses/by-sa/4.0/",
              title: "CC BY-SA 4.0",
            },
            html_url: "https://en.wikipedia.org/w/rest.php/v1/page/Douglas_Adams/html",
          },
        },
      });
      const result = yield* Rest.getPageMetadata("en.wikipedia.org", "Douglas Adams").pipe(
        provideFetch,
      );
      expect(result).toEqual({
        pageId: Option.some(42),
        key: Option.some("Douglas_Adams"),
        title: "Douglas Adams",
        contentModel: Option.some("wikitext"),
        latestRevisionId: Option.some(987654),
        latestTimestamp: Option.some("2024-01-01T00:00:00Z"),
        licenseUrl: Option.some("https://creativecommons.org/licenses/by-sa/4.0/"),
      });
      expect(new URL(urls[0] ?? "").pathname).toBe("/w/rest.php/v1/page/Douglas_Adams/bare");
    }),
  );

  it.effect(
    "fails with RequestFailed on a REST 404 rather than decoding a synthetic empty page",
    () =>
      Effect.gen(function* () {
        const { provideFetch } = stubRouter({});
        assertInstanceOf(
          yield* Effect.flip(
            Rest.getPageMetadata("en.wikipedia.org", "Nonexistent").pipe(provideFetch),
          ),
          Core.RequestFailed,
        );
      }),
  );

  it.effect("rejects a blank title before any request", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubRouter({});
      assertInstanceOf(
        yield* Effect.flip(Rest.getPageMetadata("en.wikipedia.org", "   ").pipe(provideFetch)),
        Core.InvalidRequest,
      );
      expect(urls).toEqual([]);
    }),
  );

  it.effect.each(RELATIVE_TITLES)(
    "rejects the relative-path title %j before any request",
    (title) =>
      Effect.gen(function* () {
        const { urls, provideFetch } = stubRouter({});
        assertInstanceOf(
          yield* Effect.flip(Rest.getPageMetadata("en.wikipedia.org", title).pipe(provideFetch)),
          Core.InvalidRequest,
        );
        expect(urls).toEqual([]);
      }),
  );

  it.effect("requests a title that merely contains dots at its own path", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubRouter({});
      const requestBoth = (title: string) =>
        Effect.gen(function* () {
          assertInstanceOf(
            yield* Effect.flip(Rest.getPageMetadata("en.wikipedia.org", title).pipe(provideFetch)),
            Core.RequestFailed,
          );
          assertInstanceOf(
            yield* Effect.flip(Rest.getParsedHtml("en.wikipedia.org", title).pipe(provideFetch)),
            Core.RequestFailed,
          );
        });
      yield* requestBoth("A.B");
      yield* requestBoth("...");
      expect(urls.map((url) => new URL(url).pathname)).toEqual([
        "/w/rest.php/v1/page/A.B/bare",
        "/w/rest.php/v1/page/A.B/html",
        "/w/rest.php/v1/page/.../bare",
        "/w/rest.php/v1/page/.../html",
      ]);
    }),
  );

  it.effect.each(LONE_SURROGATE_TITLES)(
    "rejects the lone-surrogate title %j before any request",
    (title) =>
      Effect.gen(function* () {
        const { urls, provideFetch } = stubRouter({});
        assertInstanceOf(
          yield* Effect.flip(Rest.getPageMetadata("en.wikipedia.org", title).pipe(provideFetch)),
          Core.InvalidRequest,
        );
        expect(urls).toEqual([]);
      }),
  );

  // MediaWiki's default `$wgLegalTitleChars` never allows these (#165).
  it.effect.each(["Foo<Bar", "Foo>Bar", "Foo[Bar", "Foo]Bar", "Foo{Bar", "Foo}Bar"])(
    "rejects the illegal-character title %j before any request",
    (title) =>
      Effect.gen(function* () {
        const { urls, provideFetch } = stubRouter({});
        assertInstanceOf(
          yield* Effect.flip(Rest.getPageMetadata("en.wikipedia.org", title).pipe(provideFetch)),
          Core.InvalidRequest,
        );
        assertInstanceOf(
          yield* Effect.flip(Rest.getParsedHtml("en.wikipedia.org", title).pipe(provideFetch)),
          Core.InvalidRequest,
        );
        expect(urls).toEqual([]);
      }),
  );

  it.effect("requests a title with a valid surrogate pair at its percent-encoded path", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubRouter({});
      assertInstanceOf(
        yield* Effect.flip(
          Rest.getPageMetadata("en.wikipedia.org", "Smile \u{1F600}").pipe(provideFetch),
        ),
        Core.RequestFailed,
      );
      assertInstanceOf(
        yield* Effect.flip(
          Rest.getParsedHtml("en.wikipedia.org", "Smile \u{1F600}").pipe(provideFetch),
        ),
        Core.RequestFailed,
      );
      expect(urls.map((url) => new URL(url).pathname)).toEqual([
        "/w/rest.php/v1/page/Smile_%F0%9F%98%80/bare",
        "/w/rest.php/v1/page/Smile_%F0%9F%98%80/html",
      ]);
    }),
  );
});

layer(Core.wikimediaLayer)("Rest.getRevisionMetadata", (it) => {
  it.effect("extracts revision identity metadata", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubRouter({
        "/revision/987654/bare": {
          status: 200,
          body: {
            id: 987654,
            size: 54321,
            minor: false,
            timestamp: "2024-01-01T00:00:00Z",
            content_model: "wikitext",
            page: { id: 42, key: "Douglas_Adams", title: "Douglas Adams" },
            license: { url: "https://creativecommons.org/licenses/by-sa/4.0/" },
          },
        },
      });
      const result = yield* Rest.getRevisionMetadata("en.wikipedia.org", 987654).pipe(provideFetch);
      expect(result).toEqual({
        revisionId: 987654,
        pageId: Option.some(42),
        pageTitle: Option.some("Douglas Adams"),
        size: Option.some(54321),
        minor: Option.some(false),
        timestamp: Option.some("2024-01-01T00:00:00Z"),
        contentModel: Option.some("wikitext"),
        licenseUrl: Option.some("https://creativecommons.org/licenses/by-sa/4.0/"),
      });
      // The metadata-only variant, without the revision's wikitext (#148).
      expect(new URL(urls[0] ?? "").pathname).toBe("/w/rest.php/v1/revision/987654/bare");
    }),
  );

  it.effect("rejects a non-positive revision id before any request", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubRouter({});
      assertInstanceOf(
        yield* Effect.flip(Rest.getRevisionMetadata("en.wikipedia.org", -1).pipe(provideFetch)),
        Core.InvalidRequest,
      );
      expect(urls).toEqual([]);
    }),
  );
});

layer(Core.wikimediaLayer)("Rest.getParsedHtml", (it) => {
  it.effect("returns the raw HTML body for a title", () =>
    Effect.gen(function* () {
      const html = "<html><body><p>Douglas Adams was a writer.</p></body></html>";
      const { urls, provideFetch } = stubRouter({
        "/page/Douglas_Adams/html": {
          status: 200,
          body: html,
          contentType: "text/html; charset=utf-8",
        },
      });
      const result = yield* Rest.getParsedHtml("en.wikipedia.org", "Douglas Adams").pipe(
        provideFetch,
      );
      expect(result).toBe(html);
      expect(urls[0]).toContain("/w/rest.php/v1/page/Douglas_Adams/html");
    }),
  );

  it.effect("fails with RequestFailed on a non-2xx status", () =>
    Effect.gen(function* () {
      const { provideFetch } = stubRouter({});
      assertInstanceOf(
        yield* Effect.flip(
          Rest.getParsedHtml("en.wikipedia.org", "Nonexistent").pipe(provideFetch),
        ),
        Core.RequestFailed,
      );
    }),
  );

  it.effect.each(RELATIVE_TITLES)(
    "rejects the relative-path title %j before any request",
    (title) =>
      Effect.gen(function* () {
        const { urls, provideFetch } = stubRouter({});
        assertInstanceOf(
          yield* Effect.flip(Rest.getParsedHtml("en.wikipedia.org", title).pipe(provideFetch)),
          Core.InvalidRequest,
        );
        expect(urls).toEqual([]);
      }),
  );

  it.effect.each(LONE_SURROGATE_TITLES)(
    "rejects the lone-surrogate title %j before any request",
    (title) =>
      Effect.gen(function* () {
        const { urls, provideFetch } = stubRouter({});
        assertInstanceOf(
          yield* Effect.flip(Rest.getParsedHtml("en.wikipedia.org", title).pipe(provideFetch)),
          Core.InvalidRequest,
        );
        expect(urls).toEqual([]);
      }),
  );
});

layer(Core.wikimediaLayer)("Rest.getRevisionHtml", (it) => {
  it.effect("returns the raw HTML body for a revision", () =>
    Effect.gen(function* () {
      const html = "<html><body><p>revision content</p></body></html>";
      const { provideFetch } = stubRouter({
        "/revision/987654/html": {
          status: 200,
          body: html,
          contentType: "text/html; charset=utf-8",
        },
      });
      const result = yield* Rest.getRevisionHtml("en.wikipedia.org", 987654).pipe(provideFetch);
      expect(result).toBe(html);
    }),
  );

  it.effect("rejects a non-integer revision id before any request", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubRouter({});
      assertInstanceOf(
        yield* Effect.flip(Rest.getRevisionHtml("en.wikipedia.org", 1.5).pipe(provideFetch)),
        Core.InvalidRequest,
      );
      expect(urls).toEqual([]);
    }),
  );
});
