/**
 * Unit tests for the Commons surface (`src/commons.ts`): `Special:FilePath`
 * URL construction and file info lookup. The network is stubbed at
 * `FetchHttpClient.Fetch` — no live network anywhere in this suite.
 *
 * @module tests/commons
 */

import { it, layer } from "@effect/vitest";
import { assertInstanceOf } from "@effect/vitest/utils";
import { describe, expect } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import { FetchHttpClient } from "effect/http";
import { Commons, Core } from "../src/index.ts";

// ── FilePath URL construction ───────────────────────────────────────────

describe("filePathUrl", () => {
  it("builds the Special:FilePath URL for a bare filename, canonicalising spaces to underscores", () => {
    expect(Option.getOrNull(Commons.filePathUrl("Douglas adams portrait.jpg"))).toBe(
      "https://commons.wikimedia.org/wiki/Special:FilePath/Douglas_adams_portrait.jpg",
    );
  });

  it("strips a leading File: prefix", () => {
    expect(Option.getOrNull(Commons.filePathUrl("File:Douglas adams portrait.jpg"))).toBe(
      "https://commons.wikimedia.org/wiki/Special:FilePath/Douglas_adams_portrait.jpg",
    );
  });

  it("appends a validated width for a thumbnail request", () => {
    const url = Option.getOrNull(Commons.filePathUrl("Example.jpg", { width: 300 }));
    expect(url).toBe("https://commons.wikimedia.org/wiki/Special:FilePath/Example.jpg?width=300");
  });

  it("rejects a width outside sane bounds", () => {
    expect(Option.getOrNull(Commons.filePathUrl("Example.jpg", { width: 0 }))).toBeNull();
    expect(Option.getOrNull(Commons.filePathUrl("Example.jpg", { width: 1.5 }))).toBeNull();
    expect(Option.getOrNull(Commons.filePathUrl("Example.jpg", { width: 1_000_000 }))).toBeNull();
  });

  it("rejects a filename that would inject a query clause or fragment", () => {
    expect(Option.getOrNull(Commons.filePathUrl("Foo|Bar.jpg"))).toBeNull();
    expect(Option.getOrNull(Commons.filePathUrl("Foo#Bar.jpg"))).toBeNull();
  });

  it.each([".", "..", "File:..", "file:.", "./Foo.jpg", "Foo/../Bar.jpg", "Foo/.."])(
    "rejects the relative-path filename %j, with or without the File: prefix",
    (filename) => {
      expect(Option.getOrNull(Commons.filePathUrl(filename)), filename).toBeNull();
    },
  );

  it.each(["Foo\uD800Bar.jpg", "File:Foo\uDC00Bar.jpg", "\uD83D.jpg"])(
    "rejects a filename with a lone UTF-16 surrogate (%j)",
    (filename) => {
      expect(Option.getOrNull(Commons.filePathUrl(filename))).toBeNull();
    },
  );

  it("keeps a filename with a valid surrogate pair", () => {
    expect(Option.getOrNull(Commons.filePathUrl("Smile \u{1F600}.jpg"))).toBe(
      "https://commons.wikimedia.org/wiki/Special:FilePath/Smile_%F0%9F%98%80.jpg",
    );
  });

  it("keeps a filename that merely contains dots", () => {
    expect(Option.getOrNull(Commons.filePathUrl("Mr. Smith.jpg"))).toBe(
      "https://commons.wikimedia.org/wiki/Special:FilePath/Mr._Smith.jpg",
    );
    expect(Option.getOrNull(Commons.filePathUrl("..."))).toBe(
      "https://commons.wikimedia.org/wiki/Special:FilePath/...",
    );
  });

  it("rejects blank input", () => {
    expect(Option.getOrNull(Commons.filePathUrl(""))).toBeNull();
    expect(Option.getOrNull(Commons.filePathUrl("   "))).toBeNull();
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
    return Arr.findFirst(R.keys(routes), (k) => request.url.includes(k)).pipe(
      Option.flatMap((key) => R.get(routes, key)),
      Option.match({
        onNone: () => Response.json({}, { status: 200 }),
        onSome: (route) => Response.json(route.body, { status: route.status }),
      }),
    );
  };
  return { urls, provideFetch: Effect.provideService(FetchHttpClient.Fetch, fetch) };
};

layer(Core.wikimediaLayer)("Commons.getFileInfo", (it) => {
  it.effect("extracts URL, dimensions, MIME, and size", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubRouter({
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
      const result = yield* Commons.getFileInfo(
        "commons.wikimedia.org",
        "Douglas adams portrait.jpg",
      ).pipe(provideFetch);
      expect(result).toEqual(
        Option.some({
          title: "File:Douglas adams portrait.jpg",
          url: Option.some("https://upload.wikimedia.org/wikipedia/commons/d/douglas.jpg"),
          descriptionUrl: Option.some(
            "https://commons.wikimedia.org/wiki/File:Douglas_adams_portrait.jpg",
          ),
          width: Option.some(800),
          height: Option.some(600),
          mime: Option.some("image/jpeg"),
          size: Option.some(123456),
        }),
      );
      expect(urls[0]).toContain("titles=File%3ADouglas_adams_portrait.jpg");
    }),
  );

  it.effect("drops a media URL on a host outside the allowed family", () =>
    Effect.gen(function* () {
      const { provideFetch } = stubRouter({
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
      const result = yield* Commons.getFileInfo("commons.wikimedia.org", "Example.jpg").pipe(
        provideFetch,
      );
      expect(Option.flatMap(result, (info) => info.url)).toEqual(Option.none());
      expect(Option.isSome(result)).toBe(true);
    }),
  );

  it.effect("succeeds with None when the file does not exist upstream", () =>
    Effect.gen(function* () {
      const { provideFetch } = stubRouter({
        "prop=imageinfo": {
          status: 200,
          body: {
            query: { pages: { "-1": { ns: 6, title: "File:Nonexistent.jpg", missing: "" } } },
          },
        },
      });
      expect(
        yield* Commons.getFileInfo("commons.wikimedia.org", "Nonexistent.jpg").pipe(provideFetch),
      ).toEqual(Option.none());
    }),
  );

  it.effect("rejects a blank filename before any request", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubRouter({});
      assertInstanceOf(
        yield* Effect.flip(Commons.getFileInfo("commons.wikimedia.org", "   ").pipe(provideFetch)),
        Core.InvalidRequest,
      );
      expect(urls).toEqual([]);
    }),
  );

  it.effect.each([".", "..", "File:..", "../Foo.jpg"])(
    "rejects the relative-path filename %j before any request",
    (filename) =>
      Effect.gen(function* () {
        const { urls, provideFetch } = stubRouter({});
        assertInstanceOf(
          yield* Effect.flip(
            Commons.getFileInfo("commons.wikimedia.org", filename).pipe(provideFetch),
          ),
          Core.InvalidRequest,
        );
        expect(urls).toEqual([]);
      }),
  );

  it.effect.each(["Foo\uD800Bar.jpg", "File:Foo\uDC00Bar.jpg"])(
    "rejects the lone-surrogate filename %j before any request",
    (filename) =>
      Effect.gen(function* () {
        const { urls, provideFetch } = stubRouter({});
        assertInstanceOf(
          yield* Effect.flip(
            Commons.getFileInfo("commons.wikimedia.org", filename).pipe(provideFetch),
          ),
          Core.InvalidRequest,
        );
        expect(urls).toEqual([]);
      }),
  );
});
