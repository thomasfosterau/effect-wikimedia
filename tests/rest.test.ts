/**
 * Unit tests for the Rest surface (`src/rest.ts`): typed page/revision
 * metadata (JSON) and parsed HTML (`text/html`) for a title or revision.
 * The network is stubbed at `FetchHttpClient.Fetch` — no live network
 * anywhere in this suite.
 *
 * @module tests/rest
 */

import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import { FetchHttpClient } from "effect/http";
import { Core, Rest } from "../src/index.ts";
import { expectFailureInstanceOf, runTest } from "./helpers/effect.ts";

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
    return Arr.findFirst(Rec.keys(routes), (k) => request.url.includes(k)).pipe(
      Option.flatMap((key) => Rec.get(routes, key)),
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
  const fetchLayer = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  return { urls, layer: Core.wikimediaClientLayer.pipe(Layer.provide(fetchLayer)) };
};

/** Provides the stubbed client layer without running the effect — for `expectFailureInstanceOf`. */
const toEffect = <A, E>(
  layer: Layer.Layer<Core.WikimediaClient>,
  effect: Effect.Effect<A, E, Core.WikimediaClient>,
): Effect.Effect<A, E, never> => effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>;

const run = <A, E>(
  layer: Layer.Layer<Core.WikimediaClient>,
  effect: Effect.Effect<A, E, Core.WikimediaClient>,
) => runTest(toEffect(layer, effect));

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

describe("Rest.getPageMetadata", () => {
  it("extracts page identity metadata", async () => {
    const { urls, layer } = stubRouter({
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
    const result = await run(layer, Rest.getPageMetadata("en.wikipedia.org", "Douglas Adams"));
    expect(result).toEqual({
      pageId: 42,
      key: "Douglas_Adams",
      title: "Douglas Adams",
      contentModel: "wikitext",
      latestRevisionId: 987654,
      latestTimestamp: "2024-01-01T00:00:00Z",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    });
    expect(new URL(urls[0] ?? "").pathname).toBe("/w/rest.php/v1/page/Douglas_Adams/bare");
  });

  it("fails with RequestFailed on a REST 404 rather than decoding a synthetic empty page", async () => {
    const { layer } = stubRouter({});
    await expectFailureInstanceOf(
      toEffect(layer, Rest.getPageMetadata("en.wikipedia.org", "Nonexistent")),
      Core.RequestFailed,
    );
  });

  it("rejects a blank title before any request", async () => {
    const { urls, layer } = stubRouter({});
    await expectFailureInstanceOf(
      toEffect(layer, Rest.getPageMetadata("en.wikipedia.org", "   ")),
      Core.InvalidRequest,
    );
    expect(urls).toEqual([]);
  });

  it.each(RELATIVE_TITLES)(
    "rejects the relative-path title %j before any request",
    async (title) => {
      const { urls, layer } = stubRouter({});
      await expectFailureInstanceOf(
        toEffect(layer, Rest.getPageMetadata("en.wikipedia.org", title)),
        Core.InvalidRequest,
      );
      expect(urls).toEqual([]);
    },
  );

  it("requests a title that merely contains dots at its own path", async () => {
    const { urls, layer } = stubRouter({});
    const requestBoth = async (title: string) => {
      await expectFailureInstanceOf(
        toEffect(layer, Rest.getPageMetadata("en.wikipedia.org", title)),
        Core.RequestFailed,
      );
      await expectFailureInstanceOf(
        toEffect(layer, Rest.getParsedHtml("en.wikipedia.org", title)),
        Core.RequestFailed,
      );
    };
    await requestBoth("A.B");
    await requestBoth("...");
    expect(urls.map((url) => new URL(url).pathname)).toEqual([
      "/w/rest.php/v1/page/A.B/bare",
      "/w/rest.php/v1/page/A.B/html",
      "/w/rest.php/v1/page/.../bare",
      "/w/rest.php/v1/page/.../html",
    ]);
  });

  it.each(LONE_SURROGATE_TITLES)(
    "rejects the lone-surrogate title %j before any request",
    async (title) => {
      const { urls, layer } = stubRouter({});
      await expectFailureInstanceOf(
        toEffect(layer, Rest.getPageMetadata("en.wikipedia.org", title)),
        Core.InvalidRequest,
      );
      expect(urls).toEqual([]);
    },
  );

  // MediaWiki's default `$wgLegalTitleChars` never allows these (#165).
  it.each(["Foo<Bar", "Foo>Bar", "Foo[Bar", "Foo]Bar", "Foo{Bar", "Foo}Bar"])(
    "rejects the illegal-character title %j before any request",
    async (title) => {
      const { urls, layer } = stubRouter({});
      await expectFailureInstanceOf(
        toEffect(layer, Rest.getPageMetadata("en.wikipedia.org", title)),
        Core.InvalidRequest,
      );
      await expectFailureInstanceOf(
        toEffect(layer, Rest.getParsedHtml("en.wikipedia.org", title)),
        Core.InvalidRequest,
      );
      expect(urls).toEqual([]);
    },
  );

  it("requests a title with a valid surrogate pair at its percent-encoded path", async () => {
    const { urls, layer } = stubRouter({});
    await expectFailureInstanceOf(
      toEffect(layer, Rest.getPageMetadata("en.wikipedia.org", "Smile \u{1F600}")),
      Core.RequestFailed,
    );
    await expectFailureInstanceOf(
      toEffect(layer, Rest.getParsedHtml("en.wikipedia.org", "Smile \u{1F600}")),
      Core.RequestFailed,
    );
    expect(urls.map((url) => new URL(url).pathname)).toEqual([
      "/w/rest.php/v1/page/Smile_%F0%9F%98%80/bare",
      "/w/rest.php/v1/page/Smile_%F0%9F%98%80/html",
    ]);
  });
});

describe("Rest.getRevisionMetadata", () => {
  it("extracts revision identity metadata", async () => {
    const { urls, layer } = stubRouter({
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
    const result = await run(layer, Rest.getRevisionMetadata("en.wikipedia.org", 987654));
    expect(result).toEqual({
      revisionId: 987654,
      pageId: 42,
      pageTitle: "Douglas Adams",
      size: 54321,
      minor: false,
      timestamp: "2024-01-01T00:00:00Z",
      contentModel: "wikitext",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    });
    // The metadata-only variant, without the revision's wikitext (#148).
    expect(new URL(urls[0] ?? "").pathname).toBe("/w/rest.php/v1/revision/987654/bare");
  });

  it("rejects a non-positive revision id before any request", async () => {
    const { urls, layer } = stubRouter({});
    await expectFailureInstanceOf(
      toEffect(layer, Rest.getRevisionMetadata("en.wikipedia.org", -1)),
      Core.InvalidRequest,
    );
    expect(urls).toEqual([]);
  });
});

describe("Rest.getParsedHtml", () => {
  it("returns the raw HTML body for a title", async () => {
    const html = "<html><body><p>Douglas Adams was a writer.</p></body></html>";
    const { urls, layer } = stubRouter({
      "/page/Douglas_Adams/html": {
        status: 200,
        body: html,
        contentType: "text/html; charset=utf-8",
      },
    });
    const result = await run(layer, Rest.getParsedHtml("en.wikipedia.org", "Douglas Adams"));
    expect(result).toBe(html);
    expect(urls[0]).toContain("/w/rest.php/v1/page/Douglas_Adams/html");
  });

  it("fails with RequestFailed on a non-2xx status", async () => {
    const { layer } = stubRouter({});
    await expectFailureInstanceOf(
      toEffect(layer, Rest.getParsedHtml("en.wikipedia.org", "Nonexistent")),
      Core.RequestFailed,
    );
  });

  it.each(RELATIVE_TITLES)(
    "rejects the relative-path title %j before any request",
    async (title) => {
      const { urls, layer } = stubRouter({});
      await expectFailureInstanceOf(
        toEffect(layer, Rest.getParsedHtml("en.wikipedia.org", title)),
        Core.InvalidRequest,
      );
      expect(urls).toEqual([]);
    },
  );

  it.each(LONE_SURROGATE_TITLES)(
    "rejects the lone-surrogate title %j before any request",
    async (title) => {
      const { urls, layer } = stubRouter({});
      await expectFailureInstanceOf(
        toEffect(layer, Rest.getParsedHtml("en.wikipedia.org", title)),
        Core.InvalidRequest,
      );
      expect(urls).toEqual([]);
    },
  );
});

describe("Rest.getRevisionHtml", () => {
  it("returns the raw HTML body for a revision", async () => {
    const html = "<html><body><p>revision content</p></body></html>";
    const { layer } = stubRouter({
      "/revision/987654/html": { status: 200, body: html, contentType: "text/html; charset=utf-8" },
    });
    const result = await run(layer, Rest.getRevisionHtml("en.wikipedia.org", 987654));
    expect(result).toBe(html);
  });

  it("rejects a non-integer revision id before any request", async () => {
    const { urls, layer } = stubRouter({});
    await expectFailureInstanceOf(
      toEffect(layer, Rest.getRevisionHtml("en.wikipedia.org", 1.5)),
      Core.InvalidRequest,
    );
    expect(urls).toEqual([]);
  });
});
