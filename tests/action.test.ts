/**
 * Unit tests for the Action surface (`src/action.ts`): wikitext fetch, page
 * metadata, search, and `parse` (sections/links/categories/templates). The
 * network is stubbed at `FetchHttpClient.Fetch` — no live network anywhere
 * in this suite.
 *
 * @module tests/action
 */

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import { Action, Core } from "../src/index.ts";
import { expectFailureInstanceOf, runTest } from "./helpers/effect.ts";

interface StubRoute {
  readonly status: number;
  readonly body: unknown;
}

/** Routes by the first key that is a substring of the request URL — query param order isn't deterministic. */
const stubRouter = (routes: Record<string, StubRoute>) => {
  const urls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    urls.push(request.url);
    const key = Object.keys(routes).find((k) => request.url.includes(k));
    const route = key ? routes[key] : undefined;
    if (!route) {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { "content-type": "application/json" },
    });
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

describe("Action.getWikitext", () => {
  it("extracts the main slot's wikitext, revision id, and timestamp", async () => {
    const { urls, layer } = stubRouter({
      "action=query": {
        status: 200,
        body: {
          query: {
            pages: {
              "42": {
                pageid: 42,
                title: "Douglas Adams",
                revisions: [
                  {
                    revid: 987654,
                    timestamp: "2024-01-01T00:00:00Z",
                    slots: {
                      main: { contentmodel: "wikitext", "*": "'''Douglas Adams''' was a writer." },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    });
    const result = await run(layer, Action.getWikitext("en.wikipedia.org", "Douglas Adams"));
    expect(result).toEqual({
      pageId: 42,
      title: "Douglas Adams",
      revisionId: 987654,
      timestamp: "2024-01-01T00:00:00Z",
      wikitext: "'''Douglas Adams''' was a writer.",
    });
    expect(urls[0]).toContain("action=query");
    expect(urls[0]).toContain("rvslots=main");
    expect(urls[0]).toContain("titles=Douglas_Adams");
  });

  it("returns null for a missing page", async () => {
    const { layer } = stubRouter({
      "action=query": {
        status: 200,
        body: { query: { pages: { "-1": { ns: 0, title: "Nonexistent", missing: "" } } } },
      },
    });
    const result = await run(layer, Action.getWikitext("en.wikipedia.org", "Nonexistent"));
    expect(result).toBeNull();
  });

  it("rejects a blank title before any request", async () => {
    const { urls, layer } = stubRouter({});
    await expectFailureInstanceOf(
      toEffect(layer, Action.getWikitext("en.wikipedia.org", "   ")),
      Core.InvalidRequest,
    );
    expect(urls).toEqual([]);
  });

  it.each([".", "..", "../Foo", "Foo/.."])(
    "rejects the relative-path title %j before any request",
    async (title) => {
      const { urls, layer } = stubRouter({});
      await expectFailureInstanceOf(
        toEffect(layer, Action.getWikitext("en.wikipedia.org", title)),
        Core.InvalidRequest,
      );
      expect(urls).toEqual([]);
    },
  );

  it("rejects an invalid host before any request", async () => {
    const { urls, layer } = stubRouter({});
    await expectFailureInstanceOf(
      toEffect(layer, Action.getWikitext("evil.example.com", "Douglas Adams")),
      Core.InvalidRequest,
    );
    expect(urls).toEqual([]);
  });
});

describe("Action.getPageMetadata", () => {
  it("extracts identity and bookkeeping fields", async () => {
    const { layer } = stubRouter({
      "prop=info": {
        status: 200,
        body: {
          query: {
            pages: {
              "42": {
                pageid: 42,
                title: "Douglas Adams",
                contentmodel: "wikitext",
                pagelanguage: "en",
                touched: "2024-01-01T00:00:00Z",
                lastrevid: 987654,
                length: 54321,
                fullurl: "https://en.wikipedia.org/wiki/Douglas_Adams",
              },
            },
          },
        },
      },
    });
    const result = await run(layer, Action.getPageMetadata("en.wikipedia.org", "Douglas Adams"));
    expect(result).toEqual({
      pageId: 42,
      title: "Douglas Adams",
      contentModel: "wikitext",
      language: "en",
      touched: "2024-01-01T00:00:00Z",
      lastRevisionId: 987654,
      length: 54321,
      fullUrl: "https://en.wikipedia.org/wiki/Douglas_Adams",
    });
  });

  it("drops a non-https fullurl rather than trusting it", async () => {
    const { layer } = stubRouter({
      "prop=info": {
        status: 200,
        body: {
          query: { pages: { "42": { pageid: 42, title: "X", fullurl: "javascript:alert(1)" } } },
        },
      },
    });
    const result = await run(layer, Action.getPageMetadata("en.wikipedia.org", "X"));
    expect(result?.fullUrl).toBeNull();
  });

  it("returns null for a missing page", async () => {
    const { layer } = stubRouter({
      "prop=info": { status: 200, body: { query: { pages: { "-1": { missing: "" } } } } },
    });
    expect(await run(layer, Action.getPageMetadata("en.wikipedia.org", "Nonexistent"))).toBeNull();
  });
});

describe("Action.search", () => {
  it("parses hits and collapses the result to the requested limit", async () => {
    const { urls, layer } = stubRouter({
      "list=search": {
        status: 200,
        body: {
          query: {
            search: [
              {
                pageid: 42,
                title: "Douglas Adams",
                snippet: "<span>Douglas</span> Adams",
                wordcount: 3000,
              },
            ],
          },
        },
      },
    });
    const result = await run(
      layer,
      Action.search("en.wikipedia.org", "Douglas Adams", { limit: 5 }),
    );
    expect(result).toEqual([
      {
        pageId: 42,
        title: "Douglas Adams",
        snippet: "<span>Douglas</span> Adams",
        wordCount: 3000,
      },
    ]);
    expect(urls[0]).toContain("srlimit=5");
  });

  it("returns an empty list when there are no matches (not an error)", async () => {
    const { layer } = stubRouter({
      "list=search": { status: 200, body: { query: { search: [] } } },
    });
    expect(await run(layer, Action.search("en.wikipedia.org", "zzz"))).toEqual([]);
  });

  it("rejects a blank query before any request", async () => {
    const { urls, layer } = stubRouter({});
    await expectFailureInstanceOf(
      toEffect(layer, Action.search("en.wikipedia.org", "   ")),
      Core.InvalidRequest,
    );
    expect(urls).toEqual([]);
  });
});

describe("Action.parsePage", () => {
  it("extracts sections, links, categories, and templates", async () => {
    const { layer } = stubRouter({
      "action=parse": {
        status: 200,
        body: {
          parse: {
            title: "Douglas Adams",
            pageid: 42,
            sections: [{ toclevel: 1, level: "2", line: "Life", anchor: "Life" }],
            links: [{ ns: 0, "*": "The Hitchhiker's Guide to the Galaxy" }],
            categories: [{ sortkey: "", "*": "English novelists" }],
            templates: [{ ns: 10, "*": "Infobox writer" }],
          },
        },
      },
    });
    const result = await run(layer, Action.parsePage("en.wikipedia.org", "Douglas Adams"));
    expect(result).toEqual({
      pageId: 42,
      title: "Douglas Adams",
      sections: [{ level: 2, title: "Life", anchor: "Life" }],
      links: ["The Hitchhiker's Guide to the Galaxy"],
      categories: ["English novelists"],
      templates: ["Infobox writer"],
    });
  });

  it("returns null when the endpoint has no parse result", async () => {
    const { layer } = stubRouter({
      "action=parse": { status: 200, body: { error: { code: "missingtitle" } } },
    });
    expect(await run(layer, Action.parsePage("en.wikipedia.org", "Nonexistent"))).toBeNull();
  });
});
