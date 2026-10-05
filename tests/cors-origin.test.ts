/**
 * The Action API's anonymous-CORS parameter (issue #49): every `/w/api.php`
 * request carries exactly one `origin=*`, whichever surface sends it, and
 * REST (`/w/rest.php`) and WDQS requests carry none. Drives each surface
 * through the real `Core.wikimediaClientLayer` over a stubbed
 * `FetchHttpClient.Fetch` and reads the URLs that reach the wire; no live
 * network.
 *
 * @module tests/cors-origin
 */

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import { Action, Commons, Core, Reconciliation, Rest, Sparql, Wikidata } from "../src/index.ts";
import { runTest } from "./helpers/effect.ts";

/**
 * Runs `program` over the real client and a fetch stub that answers every
 * request with an empty JSON object, and returns the URLs it was asked for.
 */
const sentUrls = async <A, E>(
  program: Effect.Effect<A, E, Core.WikimediaClient | Reconciliation.WikidataLookup>,
): Promise<readonly URL[]> => {
  const urls: URL[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    urls.push(new URL(new Request(input, init).url));
    return Promise.resolve(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
  };
  const client = Core.wikimediaClientLayer.pipe(
    Layer.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
    ),
  );
  const layer = Reconciliation.wikidataLookupClientLayer.pipe(Layer.provideMerge(client));
  await runTest(program.pipe(Effect.provide(layer), Effect.exit));
  return urls;
};

/** Asserts `urls` holds `count` Action API URLs, each carrying exactly one `origin=*`. */
const expectAnonymousCors = (urls: readonly URL[], count: number) => {
  expect(urls).toHaveLength(count);
  for (const url of urls) {
    expect(url.pathname).toBe("/w/api.php");
    expect(url.searchParams.getAll("origin")).toEqual(["*"]);
  }
};

describe("Action API requests (/w/api.php)", () => {
  it("send origin=* from Action", async () => {
    expectAnonymousCors(
      await sentUrls(
        Effect.all([
          Action.getWikitext("en.wikipedia.org", "Douglas Adams"),
          Action.getPageMetadata("en.wikipedia.org", "Douglas Adams"),
          Action.search("en.wikipedia.org", "Douglas Adams"),
          Action.parsePage("en.wikipedia.org", "Douglas Adams"),
        ]),
      ),
      4,
    );
  });

  it("send origin=* from Commons", async () => {
    expectAnonymousCors(
      await sentUrls(Commons.getFileInfo("commons.wikimedia.org", "Example.jpg")),
      1,
    );
  });

  it("send origin=* from Wikidata", async () => {
    expectAnonymousCors(
      await sentUrls(
        Effect.all([
          Wikidata.getEntities("www.wikidata.org", ["Q42"]),
          Wikidata.searchEntities("www.wikidata.org", "Douglas Adams"),
        ]),
      ),
      2,
    );
  });

  it("send origin=* from Reconciliation", async () => {
    expectAnonymousCors(
      await sentUrls(
        Effect.gen(function* () {
          const lookup = yield* Reconciliation.WikidataLookup;
          yield* Effect.exit(lookup.searchByLabel("Douglas Adams"));
          yield* Effect.exit(lookup.searchByIdentifier({ property: "P214", value: "113230702" }));
          yield* Effect.exit(lookup.enrich("Q42"));
        }),
      ),
      3,
    );
  });

  it("send a caller-supplied origin in place of *, never alongside it", async () => {
    const urls = await sentUrls(
      Effect.gen(function* () {
        const client = yield* Core.WikimediaClient;
        yield* client.getText({
          host: "en.wikipedia.org",
          path: "/w/api.php",
          params: { action: "query", origin: "https://example.org" },
        });
      }),
    );
    expect(urls).toHaveLength(1);
    expect(urls[0]?.searchParams.getAll("origin")).toEqual(["https://example.org"]);
  });

  it("send no origin alongside a caller-supplied crossorigin, which MediaWiki would reject", async () => {
    const urls = await sentUrls(
      Effect.gen(function* () {
        const client = yield* Core.WikimediaClient;
        yield* client.getText({
          host: "en.wikipedia.org",
          path: "/w/api.php",
          params: { action: "query", crossorigin: "1" },
        });
      }),
    );
    expect(urls).toHaveLength(1);
    expect(urls[0]?.searchParams.has("origin")).toBe(false);
    expect(urls[0]?.searchParams.get("crossorigin")).toBe("1");
  });

  it("send origin=* on an Action API path spelled with a dot segment", async () => {
    const urls = await sentUrls(
      Effect.gen(function* () {
        const client = yield* Core.WikimediaClient;
        yield* client.getText({ host: "en.wikipedia.org", path: "/w/./api.php", params: {} });
      }),
    );
    expect(urls).toHaveLength(1);
    expect(urls[0]?.searchParams.getAll("origin")).toEqual(["*"]);
  });
});

describe("REST and WDQS requests", () => {
  it("carry no origin parameter", async () => {
    const urls = await sentUrls(
      Effect.all([
        Rest.getPageMetadata("en.wikipedia.org", "Douglas Adams"),
        Rest.getRevisionMetadata("en.wikipedia.org", 1),
        Rest.getParsedHtml("en.wikipedia.org", "Douglas Adams"),
        Rest.getRevisionHtml("en.wikipedia.org", 1),
        Sparql.query("SELECT ?item WHERE { ?item ?p ?o } LIMIT 1"),
      ]),
    );
    expect(urls.map((url) => url.pathname)).toEqual([
      "/w/rest.php/v1/page/Douglas_Adams",
      "/w/rest.php/v1/revision/1",
      "/w/rest.php/v1/page/Douglas_Adams/html",
      "/w/rest.php/v1/revision/1/html",
      Sparql.WDQS_PATH,
    ]);
    for (const url of urls) expect(url.searchParams.has("origin")).toBe(false);
  });
});
