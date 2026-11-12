/**
 * Integration-style acceptance test (issue #1063): fetches wikitext
 * (Action), parsed HTML (Rest), and a Commons file URL for a real title —
 * "Douglas Adams" — end to end through the package barrel, against
 * responses recorded from the real Wikimedia APIs
 * (`tests/fixtures/douglas-adams.json`). The network is stubbed at
 * `FetchHttpClient.Fetch`; there is no live network anywhere in this suite
 * or in CI.
 *
 * @module tests/wikitext-html-commons
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { layer } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import { Action, Commons, Core, Rest } from "../src/index.ts";

const fixturesPath = fileURLToPath(new URL("./fixtures/douglas-adams.json", import.meta.url));
const fixtures = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      wikitext: Schema.Unknown,
      restPageMetadata: Schema.Unknown,
      restParsedHtml: Schema.String,
      commonsFileInfo: Schema.Unknown,
    }),
  ),
)(readFileSync(fixturesPath, "utf-8"));

/** Routes each stubbed call by a distinguishing substring of its request URL. */
const fetch: typeof globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = request.url;
  if (url.includes("action=query") && url.includes("prop=revisions")) {
    return Response.json(fixtures.wikitext);
  }
  if (url.includes("prop=imageinfo")) {
    return Response.json(fixtures.commonsFileInfo);
  }
  if (url.includes("/w/rest.php/v1/page/Douglas_Adams/html")) {
    return new Response(fixtures.restParsedHtml, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (url.includes("/w/rest.php/v1/page/Douglas_Adams/bare")) {
    return Response.json(fixtures.restPageMetadata);
  }
  return new Response("not found", { status: 404 });
};

/** The real client over the fixture-backed stub above, shared by every test in this file. */
const clientLayer = Core.wikimediaClientLayer.pipe(
  Layer.provide(
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
  ),
);

layer(clientLayer)("wikitext + parsed HTML + Commons file URL for a real title", (it) => {
  it.effect("fetches Douglas Adams's wikitext via Action", () =>
    Effect.gen(function* () {
      const result = Option.getOrElse(
        yield* Action.getWikitext("en.wikipedia.org", "Douglas Adams"),
        () => expect.unreachable("no wikitext"),
      );
      expect(result.title).toBe("Douglas Adams");
      expect(result.revisionId).toEqual(Option.some(1198166957));
      expect(result.wikitext).toContain("Douglas Noel Adams");
      expect(result.wikitext).toContain("[[Category:English novelists]]");
    }),
  );

  it.effect("fetches Douglas Adams's parsed HTML via Rest, matching the wikitext's revision", () =>
    Effect.gen(function* () {
      const [wikitext, metadata, html] = yield* Effect.all(
        [
          Action.getWikitext("en.wikipedia.org", "Douglas Adams"),
          Rest.getPageMetadata("en.wikipedia.org", "Douglas Adams"),
          Rest.getParsedHtml("en.wikipedia.org", "Douglas Adams"),
        ],
        { concurrency: 1 },
      );
      expect(html).toContain("<b>Douglas Noel Adams</b>");
      expect(html).toContain('<h2 id="Life">Life</h2>');
      // The REST metadata's latest revision matches the Action wikitext's revision — one consistent page.
      expect(Option.isSome(metadata.latestRevisionId)).toBe(true);
      expect(metadata.latestRevisionId).toEqual(
        Option.flatMap(wikitext, (page) => page.revisionId),
      );
    }),
  );

  it.effect("builds Douglas Adams's Commons portrait file URL and fetches its file info", () =>
    Effect.gen(function* () {
      const filename = "Douglas adams portrait cropped.jpg";
      const url = Commons.filePathUrl(filename);
      expect(Option.getOrNull(url)).toBe(
        "https://commons.wikimedia.org/wiki/Special:FilePath/Douglas_adams_portrait_cropped.jpg",
      );

      const info = Option.getOrNull(yield* Commons.getFileInfo("commons.wikimedia.org", filename));
      expect(info === null ? null : Option.getOrNull(info.url)).toBe(
        "https://upload.wikimedia.org/wikipedia/commons/d/d1/Douglas_adams_portrait_cropped.jpg",
      );
      expect(info?.width).toEqual(Option.some(1200));
      expect(info?.mime).toEqual(Option.some("image/jpeg"));
    }),
  );
});
