/**
 * Unit tests for the Commons surface (`src/commons.ts`): `Special:FilePath`
 * URL construction and file info lookup. The network is stubbed at
 * `FetchHttpClient.Fetch` — no live network anywhere in this suite.
 *
 * @module tests/commons
 */

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import { Commons, Core } from "@thomasfosterau/effect-wikimedia";
import { expectFailureInstanceOf, runTest } from "@test-helpers/effect";

// ── FilePath URL construction ───────────────────────────────────────────

describe("filePathUrl", () => {
  it("builds the Special:FilePath URL for a bare filename, canonicalising spaces to underscores", () => {
    expect(Commons.filePathUrl("Douglas adams portrait.jpg")).toBe(
      "https://commons.wikimedia.org/wiki/Special:FilePath/Douglas_adams_portrait.jpg",
    );
  });

  it("strips a leading File: prefix", () => {
    expect(Commons.filePathUrl("File:Douglas adams portrait.jpg")).toBe(
      "https://commons.wikimedia.org/wiki/Special:FilePath/Douglas_adams_portrait.jpg",
    );
  });

  it("appends a validated width for a thumbnail request", () => {
    const url = Commons.filePathUrl("Example.jpg", { width: 300 });
    expect(url).toBe("https://commons.wikimedia.org/wiki/Special:FilePath/Example.jpg?width=300");
  });

  it("rejects a width outside sane bounds", () => {
    expect(Commons.filePathUrl("Example.jpg", { width: 0 })).toBeNull();
    expect(Commons.filePathUrl("Example.jpg", { width: 1.5 })).toBeNull();
    expect(Commons.filePathUrl("Example.jpg", { width: 1_000_000 })).toBeNull();
  });

  it("rejects a filename that would inject a query clause or fragment", () => {
    expect(Commons.filePathUrl("Foo|Bar.jpg")).toBeNull();
    expect(Commons.filePathUrl("Foo#Bar.jpg")).toBeNull();
  });

  it("rejects blank input", () => {
    expect(Commons.filePathUrl("")).toBeNull();
    expect(Commons.filePathUrl("   ")).toBeNull();
  });
});

// ── File info (Action API imageinfo) ─────────────────────────────────────

interface StubRoute {
  readonly status: number;
  readonly body: unknown;
}

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

describe("Commons.getFileInfo", () => {
  it("extracts URL, dimensions, MIME, and size", async () => {
    const { urls, layer } = stubRouter({
      "prop=imageinfo": {
        status: 200,
        body: {
          query: {
            pages: {
              "555": {
                pageid: 555,
                title: "File:Douglas adams portrait.jpg",
                imageinfo: [
                  {
                    url: "https://upload.wikimedia.org/wikipedia/commons/d/douglas.jpg",
                    descriptionurl:
                      "https://commons.wikimedia.org/wiki/File:Douglas_adams_portrait.jpg",
                    width: 800,
                    height: 600,
                    mime: "image/jpeg",
                    size: 123456,
                  },
                ],
              },
            },
          },
        },
      },
    });
    const result = await run(
      layer,
      Commons.getFileInfo("commons.wikimedia.org", "Douglas adams portrait.jpg"),
    );
    expect(result).toEqual({
      title: "File:Douglas adams portrait.jpg",
      url: "https://upload.wikimedia.org/wikipedia/commons/d/douglas.jpg",
      descriptionUrl: "https://commons.wikimedia.org/wiki/File:Douglas_adams_portrait.jpg",
      width: 800,
      height: 600,
      mime: "image/jpeg",
      size: 123456,
    });
    expect(urls[0]).toContain("titles=File%3ADouglas_adams_portrait.jpg");
  });

  it("drops a media URL on a host outside the allowed family", async () => {
    const { layer } = stubRouter({
      "prop=imageinfo": {
        status: 200,
        body: {
          query: {
            pages: {
              "555": {
                pageid: 555,
                title: "File:Example.jpg",
                imageinfo: [{ url: "https://evil.example.com/steal.jpg" }],
              },
            },
          },
        },
      },
    });
    const result = await run(layer, Commons.getFileInfo("commons.wikimedia.org", "Example.jpg"));
    expect(result?.url).toBeNull();
  });

  it("returns null when the file does not exist upstream", async () => {
    const { layer } = stubRouter({
      "prop=imageinfo": {
        status: 200,
        body: { query: { pages: { "-1": { ns: 6, title: "File:Nonexistent.jpg", missing: "" } } } },
      },
    });
    expect(
      await run(layer, Commons.getFileInfo("commons.wikimedia.org", "Nonexistent.jpg")),
    ).toBeNull();
  });

  it("rejects a blank filename before any request", async () => {
    const { urls, layer } = stubRouter({});
    await expectFailureInstanceOf(
      toEffect(layer, Commons.getFileInfo("commons.wikimedia.org", "   ")),
      Core.InvalidRequest,
    );
    expect(urls).toEqual([]);
  });
});
