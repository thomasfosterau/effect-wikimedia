/**
 * Unit tests for the Action surface (`src/action.ts`): wikitext fetch, page
 * metadata, search, and `parse` (sections/links/categories/templates). The
 * network is stubbed at `FetchHttpClient.Fetch` — no live network anywhere
 * in this suite.
 *
 * @module tests/action
 */

import { layer } from "@effect/vitest";
import { assertInstanceOf } from "@effect/vitest/utils";
import { expect } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import { FetchHttpClient } from "effect/http";
import { Action, Core, Wikitext } from "../src/index.ts";

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

layer(Core.wikimediaLayer)("Action.getWikitext", (it) => {
  it.effect("extracts the main slot's wikitext, revision id, and timestamp", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubRouter({
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
                        main: {
                          contentmodel: "wikitext",
                          "*": "'''Douglas Adams''' was a writer.",
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      });
      const result = yield* Action.getWikitext("en.wikipedia.org", "Douglas Adams").pipe(
        provideFetch,
      );
      expect(result).toEqual(
        Option.some({
          pageId: Option.some(42),
          title: "Douglas Adams",
          revisionId: Option.some(987654),
          timestamp: Option.some("2024-01-01T00:00:00Z"),
          wikitext: "'''Douglas Adams''' was a writer.",
        }),
      );
      expect(urls[0]).toContain("action=query");
      expect(urls[0]).toContain("rvslots=main");
      expect(urls[0]).toContain("titles=Douglas_Adams");
    }),
  );

  it.effect("returns None for a missing page", () =>
    Effect.gen(function* () {
      const { provideFetch } = stubRouter({
        "action=query": {
          status: 200,
          body: { query: { pages: { "-1": { ns: 0, title: "Nonexistent", missing: "" } } } },
        },
      });
      const result = yield* Action.getWikitext("en.wikipedia.org", "Nonexistent").pipe(
        provideFetch,
      );
      expect(result).toEqual(Option.none());
    }),
  );

  it.effect("rejects a blank title before any request", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubRouter({});
      assertInstanceOf(
        yield* Effect.flip(Action.getWikitext("en.wikipedia.org", "   ").pipe(provideFetch)),
        Core.InvalidRequest,
      );
      expect(urls).toEqual([]);
    }),
  );

  it.effect.each([".", "..", "../Foo", "Foo/.."])(
    "rejects the relative-path title %j before any request",
    (title) =>
      Effect.gen(function* () {
        const { urls, provideFetch } = stubRouter({});
        assertInstanceOf(
          yield* Effect.flip(Action.getWikitext("en.wikipedia.org", title).pipe(provideFetch)),
          Core.InvalidRequest,
        );
        expect(urls).toEqual([]);
      }),
  );

  // Unrejected, `URLSearchParams` replaces the surrogate with U+FFFD and the
  // request asks for a different title.
  it.effect.each(["Foo\uD800Bar", "Foo\uDC00Bar"])(
    "rejects the lone-surrogate title %j before any request, from every title-taking function",
    (title) =>
      Effect.gen(function* () {
        const { urls, provideFetch } = stubRouter({});
        assertInstanceOf(
          yield* Effect.flip(Action.getWikitext("en.wikipedia.org", title).pipe(provideFetch)),
          Core.InvalidRequest,
        );
        assertInstanceOf(
          yield* Effect.flip(Action.getPageMetadata("en.wikipedia.org", title).pipe(provideFetch)),
          Core.InvalidRequest,
        );
        assertInstanceOf(
          yield* Effect.flip(Action.parsePage("en.wikipedia.org", title).pipe(provideFetch)),
          Core.InvalidRequest,
        );
        expect(urls).toEqual([]);
      }),
  );

  // MediaWiki's default `$wgLegalTitleChars` never allows these (#165).
  it.effect.each(["Foo<Bar", "Foo>Bar", "Foo[Bar", "Foo]Bar", "Foo{Bar", "Foo}Bar"])(
    "rejects the illegal-character title %j before any request, from every title-taking function",
    (title) =>
      Effect.gen(function* () {
        const { urls, provideFetch } = stubRouter({});
        assertInstanceOf(
          yield* Effect.flip(Action.getWikitext("en.wikipedia.org", title).pipe(provideFetch)),
          Core.InvalidRequest,
        );
        assertInstanceOf(
          yield* Effect.flip(Action.getPageMetadata("en.wikipedia.org", title).pipe(provideFetch)),
          Core.InvalidRequest,
        );
        assertInstanceOf(
          yield* Effect.flip(Action.parsePage("en.wikipedia.org", title).pipe(provideFetch)),
          Core.InvalidRequest,
        );
        expect(urls).toEqual([]);
      }),
  );

  it.effect("reaches a sister-project host such as Wiktionary", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubRouter({
        "action=query": {
          status: 200,
          body: {
            query: {
              pages: {
                "7": {
                  pageid: 7,
                  title: "cat",
                  revisions: [
                    {
                      revid: 123,
                      timestamp: "2024-01-01T00:00:00Z",
                      slots: { main: { contentmodel: "wikitext", "*": "==English==" } },
                    },
                  ],
                },
              },
            },
          },
        },
      });
      const result = yield* Action.getWikitext("en.wiktionary.org", "cat").pipe(provideFetch);
      expect(Option.map(result, (page) => page.wikitext)).toEqual(Option.some("==English=="));
      expect(urls[0]).toMatch(/^https:\/\/en\.wiktionary\.org\/w\/api\.php\?/);
    }),
  );

  it.effect("rejects an invalid host before any request", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubRouter({});
      assertInstanceOf(
        yield* Effect.flip(
          Action.getWikitext("evil.example.com", "Douglas Adams").pipe(provideFetch),
        ),
        Core.InvalidRequest,
      );
      expect(urls).toEqual([]);
    }),
  );
});

layer(Core.wikimediaLayer)("Action.getPageMetadata", (it) => {
  it.effect("extracts identity and bookkeeping fields", () =>
    Effect.gen(function* () {
      const { provideFetch } = stubRouter({
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
      const result = yield* Action.getPageMetadata("en.wikipedia.org", "Douglas Adams").pipe(
        provideFetch,
      );
      expect(result).toEqual(
        Option.some({
          pageId: Option.some(42),
          title: "Douglas Adams",
          contentModel: Option.some("wikitext"),
          language: Option.some("en"),
          touched: Option.some("2024-01-01T00:00:00Z"),
          lastRevisionId: Option.some(987654),
          length: Option.some(54321),
          fullUrl: Option.some("https://en.wikipedia.org/wiki/Douglas_Adams"),
        }),
      );
    }),
  );

  it.effect("drops a non-https fullurl rather than trusting it", () =>
    Effect.gen(function* () {
      const { provideFetch } = stubRouter({
        "prop=info": {
          status: 200,
          body: {
            query: { pages: { "42": { pageid: 42, title: "X", fullurl: "javascript:alert(1)" } } },
          },
        },
      });
      const result = yield* Action.getPageMetadata("en.wikipedia.org", "X").pipe(provideFetch);
      expect(Option.flatMap(result, (page) => page.fullUrl)).toEqual(Option.none());
      expect(Option.isSome(result)).toBe(true);
    }),
  );

  it.effect("returns None for a missing page", () =>
    Effect.gen(function* () {
      const { provideFetch } = stubRouter({
        "prop=info": { status: 200, body: { query: { pages: { "-1": { missing: "" } } } } },
      });
      expect(
        yield* Action.getPageMetadata("en.wikipedia.org", "Nonexistent").pipe(provideFetch),
      ).toEqual(Option.none());
    }),
  );

  // MediaWiki's `ApiQuery` writes an invalid title as `{ title, invalidreason,
  // invalid }` and an existing special page as `{ ns, title, special }`, with
  // no `missing` flag on either (`formatversion=1`, the default this client
  // requests, sends each flag as `""`).
  it.effect("returns None for a title the API reports as invalid", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubRouter({
        "prop=info": {
          status: 200,
          body: {
            query: {
              pages: {
                "-1": {
                  title: "Talk:../Foo",
                  invalidreason:
                    "Title has relative path. Relative page titles (./, ../) are invalid, because they will often be unreachable when handled by user's browser.",
                  invalid: "",
                },
              },
            },
          },
        },
      });
      expect(
        yield* Action.getPageMetadata("en.wikipedia.org", "Talk:../Foo").pipe(provideFetch),
      ).toEqual(Option.none());
      expect(urls).toHaveLength(1);
    }),
  );

  it.effect("returns None for an existing special page", () =>
    Effect.gen(function* () {
      const { provideFetch } = stubRouter({
        "prop=info": {
          status: 200,
          body: { query: { pages: { "-1": { ns: -1, title: "Special:Random", special: "" } } } },
        },
      });
      expect(
        yield* Action.getPageMetadata("en.wikipedia.org", "Special:Random").pipe(provideFetch),
      ).toEqual(Option.none());
    }),
  );
});

layer(Core.wikimediaLayer)("Action.search", (it) => {
  it.effect("parses hits and collapses the result to the requested limit", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubRouter({
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
      const result = yield* Action.search("en.wikipedia.org", "Douglas Adams", { limit: 5 }).pipe(
        provideFetch,
      );
      expect(result).toEqual([
        {
          pageId: Option.some(42),
          title: "Douglas Adams",
          snippet: Option.some("<span>Douglas</span> Adams"),
          wordCount: Option.some(3000),
        },
      ]);
      expect(urls[0]).toContain("srlimit=5");
    }),
  );

  it.effect("returns an empty list when there are no matches (not an error)", () =>
    Effect.gen(function* () {
      const { provideFetch } = stubRouter({
        "list=search": { status: 200, body: { query: { search: [] } } },
      });
      expect(yield* Action.search("en.wikipedia.org", "zzz").pipe(provideFetch)).toEqual([]);
    }),
  );

  it.effect("rejects a blank query before any request", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubRouter({});
      assertInstanceOf(
        yield* Effect.flip(Action.search("en.wikipedia.org", "   ").pipe(provideFetch)),
        Core.InvalidRequest,
      );
      expect(urls).toEqual([]);
    }),
  );
});

layer(Core.wikimediaLayer)("Action.parsePage", (it) => {
  it.effect("extracts sections, links, categories, and templates", () =>
    Effect.gen(function* () {
      const { provideFetch } = stubRouter({
        "action=parse": {
          status: 200,
          body: {
            parse: {
              title: "Douglas Adams",
              pageid: 42,
              tocdata: {
                sections: [{ tocLevel: 1, hLevel: 2, line: "Life", anchor: "Life" }],
                extensionData: [],
              },
              links: [{ ns: 0, "*": "The Hitchhiker's Guide to the Galaxy" }],
              categories: [{ sortkey: "", "*": "English novelists" }],
              templates: [{ ns: 10, "*": "Infobox writer" }],
            },
          },
        },
      });
      const result = yield* Action.parsePage("en.wikipedia.org", "Douglas Adams").pipe(
        provideFetch,
      );
      expect(result).toEqual(
        Option.some({
          pageId: Option.some(42),
          title: "Douglas Adams",
          sections: [{ level: Option.some(2), title: "Life", anchor: Option.some("Life") }],
          links: ["The Hitchhiker's Guide to the Galaxy"],
          categories: ["English novelists"],
          templates: ["Infobox writer"],
        }),
      );
    }),
  );

  // Hand-derived from MediaWiki's ApiParse (`prop=tocdata`, which writes
  // `jsonCodec->toJsonArray(TOCData)`) and Parsoid's
  // `SectionMetadata::toJsonArray()`, which omits a field at its default and
  // `linkAnchor` when it equals `anchor` (#144). No live network.
  it.effect("reads the tocdata table of contents and requests it rather than sections", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubRouter({
        "action=parse": {
          status: 200,
          body: {
            parse: {
              title: "Douglas Adams",
              pageid: 8091,
              tocdata: {
                sections: [
                  {
                    tocLevel: 1,
                    hLevel: 2,
                    line: "Early life",
                    number: "1",
                    index: "1",
                    fromTitle: "Douglas_Adams",
                    codepointOffset: 3054,
                    anchor: "Early_life",
                  },
                  {
                    tocLevel: 2,
                    hLevel: 3,
                    line: "<i>The Hitchhiker's Guide</i> & radio",
                    number: "1.1",
                    index: "2",
                    fromTitle: "Douglas_Adams",
                    codepointOffset: 5120,
                    anchor: "The_Hitchhiker's_Guide_&_radio",
                    linkAnchor: "The_Hitchhiker's_Guide_&amp;_radio",
                  },
                  { tocLevel: 1, hLevel: 2, number: "2", index: "3", anchor: "Empty" },
                ],
                extensionData: [],
              },
              showtoc: true,
            },
          },
        },
      });
      const result = yield* Action.parsePage("en.wikipedia.org", "Douglas Adams").pipe(
        provideFetch,
      );
      expect(Option.map(result, (page) => page.sections)).toEqual(
        Option.some([
          { level: Option.some(2), title: "Early life", anchor: Option.some("Early_life") },
          {
            level: Option.some(3),
            title: "<i>The Hitchhiker's Guide</i> & radio",
            anchor: Option.some("The_Hitchhiker's_Guide_&_radio"),
          },
        ]),
      );
      const prop = new URL(urls[0] ?? "").searchParams.get("prop");
      expect(prop?.split("|")).toEqual(["tocdata", "links", "categories", "templates"]);
    }),
  );

  it.effect("returns None when the endpoint has no parse result", () =>
    Effect.gen(function* () {
      const { provideFetch } = stubRouter({
        "action=parse": { status: 200, body: { error: { code: "missingtitle" } } },
      });
      expect(yield* Action.parsePage("en.wikipedia.org", "Nonexistent").pipe(provideFetch)).toEqual(
        Option.none(),
      );
    }),
  );
});

layer(Core.wikimediaLayer)("Action.getRedirectAliases (#220)", (it) => {
  // The `formatversion=1` shape dewiki's siteinfo answers with, cut down.
  const dewikiMagicWords = {
    query: {
      magicwords: [
        {
          name: "notoc",
          aliases: ["__KEIN_INHALTSVERZEICHNIS__", "__NOTOC__"],
          "case-sensitive": "",
        },
        { name: "redirect", aliases: ["#WEITERLEITUNG", "#REDIRECT"] },
      ],
    },
  };

  it.effect("collects the redirect magic word's spellings and asks only for magicwords", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubRouter({
        "meta=siteinfo": { status: 200, body: dewikiMagicWords },
      });
      const aliases = yield* Action.getRedirectAliases("de.wikipedia.org").pipe(provideFetch);
      expect(aliases).toEqual(["#WEITERLEITUNG", "#REDIRECT"]);
      const url = new URL(urls[0]);
      expect(url.host).toBe("de.wikipedia.org");
      expect(url.searchParams.get("meta")).toBe("siteinfo");
      expect(url.searchParams.get("siprop")).toBe("magicwords");
    }),
  );

  it.effect("feeds Wikitext.redirectTarget so a localised redirect is recognised", () =>
    Effect.gen(function* () {
      const { provideFetch } = stubRouter({
        "meta=siteinfo": { status: 200, body: dewikiMagicWords },
      });
      const aliases = yield* Action.getRedirectAliases("de.wikipedia.org").pipe(provideFetch);
      const doc = Wikitext.parse("#weiterleitung [[Berlin]]");
      expect(Wikitext.redirectTarget(doc)).toEqual(Option.none());
      expect(Wikitext.redirectTarget(doc, { aliases })).toEqual(Option.some("Berlin"));
    }),
  );

  it.effect("drops unusable values and returns nothing without a redirect entry", () =>
    Effect.gen(function* () {
      const { provideFetch } = stubRouter({
        "meta=siteinfo": {
          status: 200,
          body: {
            query: {
              magicwords: [
                {
                  name: "redirect",
                  aliases: ["  ", 7, " #UMLEITUNG ", "#UMLEITUNG", "#".repeat(256)],
                },
                { name: "redirect" },
              ],
            },
          },
        },
      });
      expect(yield* Action.getRedirectAliases("de.wikipedia.org").pipe(provideFetch)).toEqual([
        "#UMLEITUNG",
      ]);
      expect(Action.normaliseRedirectAliases({})).toEqual([]);
      expect(
        Action.normaliseRedirectAliases({
          query: { magicwords: [{ name: "notoc", aliases: ["x"] }] },
        }),
      ).toEqual([]);
    }),
  );

  it("caps the list at MAX_REDIRECT_ALIASES", () => {
    const aliases = Arr.makeBy(Action.MAX_REDIRECT_ALIASES + 10, (i) => `#R${i}`);
    expect(
      Action.normaliseRedirectAliases({ query: { magicwords: [{ name: "redirect", aliases }] } }),
    ).toHaveLength(Action.MAX_REDIRECT_ALIASES);
  });

  it.effect("fails with RequestFailed when the magic-word list is not an array", () =>
    Effect.gen(function* () {
      const { provideFetch } = stubRouter({
        "meta=siteinfo": { status: 200, body: { query: { magicwords: { redirect: "#R" } } } },
      });
      assertInstanceOf(
        yield* Effect.flip(Action.getRedirectAliases("de.wikipedia.org").pipe(provideFetch)),
        Core.RequestFailed,
      );
    }),
  );

  it.effect("fails with InvalidRequest for a host outside the allowed set", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubRouter({});
      assertInstanceOf(
        yield* Effect.flip(Action.getRedirectAliases("evil.example.com").pipe(provideFetch)),
        Core.InvalidRequest,
      );
      expect(urls).toEqual([]);
    }),
  );
});

layer(Core.wikimediaLayer)("Action.getHiddenLinkPrefixes (#208)", (it) => {
  // The `formatversion=1` shape dewiki's siteinfo answers with, cut down.
  const dewikiSiteinfo = {
    query: {
      namespaces: {
        "0": { id: 0, case: "first-letter", "*": "" },
        "2": { id: 2, case: "first-letter", canonical: "User", "*": "Benutzer" },
        "6": { id: 6, case: "first-letter", canonical: "File", "*": "Datei" },
        "14": { id: 14, case: "first-letter", canonical: "Category", "*": "Kategorie" },
      },
      namespacealiases: [
        { id: 6, "*": "Bild" },
        { id: 6, "*": "Image" },
        { id: 2, "*": "Benutzerin" },
      ],
      interwikimap: [
        { prefix: "de", local: "", language: "Deutsch", localinterwiki: "", url: "x" },
        { prefix: "fr", local: "", language: "français", url: "x" },
        { prefix: "ar", local: "", language: "العربية", url: "x" },
        { prefix: "simple", local: "", language: "Simple English", url: "x" },
        { prefix: "wikt", local: "", url: "x" },
        { prefix: "commons", local: "", url: "x" },
        { prefix: "extra", extralanglink: "", url: "x" },
      ],
    },
  };

  it.effect(
    "collects the File and Category names, their aliases and the interlanguage prefixes",
    () =>
      Effect.gen(function* () {
        const { urls, provideFetch } = stubRouter({
          "meta=siteinfo": { status: 200, body: dewikiSiteinfo },
        });
        const prefixes = yield* Action.getHiddenLinkPrefixes("de.wikipedia.org").pipe(provideFetch);
        expect(prefixes).toEqual([
          "File",
          "Datei",
          "Category",
          "Kategorie",
          "Bild",
          "Image",
          "fr",
          "ar",
          "simple",
          "extra",
        ]);
        const url = new URL(urls[0]);
        expect(url.host).toBe("de.wikipedia.org");
        expect(url.searchParams.get("siprop")).toBe("namespaces|namespacealiases|interwikimap");
      }),
  );

  it.effect("feeds Wikitext.stripToText so localised file, category and language links drop", () =>
    Effect.gen(function* () {
      const { provideFetch } = stubRouter({
        "meta=siteinfo": { status: 200, body: dewikiSiteinfo },
      });
      const hiddenLinkPrefixes =
        yield* Action.getHiddenLinkPrefixes("de.wikipedia.org").pipe(provideFetch);
      const doc = Wikitext.parse(
        "Berlin[[Datei:B.jpg|mini|Brandenburger Tor]] ist eine [[Stadt]].[[Kategorie:Ort]][[fr:Berlin]]",
      );
      expect(Wikitext.stripToText(doc, { hiddenLinkPrefixes })).toBe("Berlin ist eine Stadt.");
    }),
  );

  it.effect("drops unusable values and returns nothing for an error response", () =>
    Effect.gen(function* () {
      const { provideFetch } = stubRouter({
        "meta=siteinfo": {
          status: 200,
          body: {
            query: {
              namespaces: { "6": { id: 6, canonical: 6, "*": "  " } },
              namespacealiases: [{ id: 14, "*": "Bad:Alias" }, { id: 14 }, { id: 14, "*": "Kat" }],
              interwikimap: [{ prefix: "x|y", language: "Bad" }, { language: "No prefix" }],
            },
          },
        },
      });
      expect(yield* Action.getHiddenLinkPrefixes("de.wikipedia.org").pipe(provideFetch)).toEqual([
        "Kat",
      ]);
      expect(Action.normaliseHiddenLinkPrefixes({})).toEqual([]);
    }),
  );

  it("caps the list at MAX_HIDDEN_LINK_PREFIXES", () => {
    const interwikimap = Arr.makeBy(Action.MAX_HIDDEN_LINK_PREFIXES + 10, (i) => ({
      prefix: `l${i}`,
      language: "L",
    }));
    expect(Action.normaliseHiddenLinkPrefixes({ query: { interwikimap } })).toHaveLength(
      Action.MAX_HIDDEN_LINK_PREFIXES,
    );
  });

  it.effect("fails with InvalidRequest for a host outside the allowed set", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubRouter({});
      assertInstanceOf(
        yield* Effect.flip(Action.getHiddenLinkPrefixes("evil.example.com").pipe(provideFetch)),
        Core.InvalidRequest,
      );
      expect(urls).toEqual([]);
    }),
  );
});

layer(Core.wikimediaLayer)("Action.getSiteTextConfig (#220)", (it) => {
  // A cut-down dewiki siteinfo answer to all four `siprop`s at once.
  const dewiki = {
    query: {
      namespaces: {
        "6": { id: 6, canonical: "File", "*": "Datei" },
        "14": { id: 14, canonical: "Category", "*": "Kategorie" },
      },
      namespacealiases: [{ id: 6, "*": "Bild" }],
      interwikimap: [{ prefix: "fr", language: "français" }, { prefix: "wikt" }],
      magicwords: [{ name: "redirect", aliases: ["#WEITERLEITUNG", "#REDIRECT"] }],
    },
  };

  it.effect("gets both values in one request, as the two single calls normalise them", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubRouter({ "meta=siteinfo": { status: 200, body: dewiki } });
      const config = yield* Action.getSiteTextConfig("de.wikipedia.org").pipe(provideFetch);
      expect(config).toEqual({
        hiddenLinkPrefixes: ["File", "Datei", "Category", "Kategorie", "Bild", "fr"],
        redirectAliases: ["#WEITERLEITUNG", "#REDIRECT"],
      });
      expect(config.hiddenLinkPrefixes).toEqual(Action.normaliseHiddenLinkPrefixes(dewiki));
      expect(config.redirectAliases).toEqual(Action.normaliseRedirectAliases(dewiki));
      expect(urls).toHaveLength(1);
      expect(new URL(urls[0] ?? "").searchParams.get("siprop")).toBe(
        "namespaces|namespacealiases|interwikimap|magicwords",
      );
    }),
  );

  it.effect("feeds both Wikitext queries", () =>
    Effect.gen(function* () {
      const { provideFetch } = stubRouter({ "meta=siteinfo": { status: 200, body: dewiki } });
      const { hiddenLinkPrefixes, redirectAliases } =
        yield* Action.getSiteTextConfig("de.wikipedia.org").pipe(provideFetch);
      const doc = Wikitext.parse("#weiterleitung [[Berlin]] [[Datei:x.jpg|thumb|Bild]]");
      expect(Wikitext.redirectTarget(doc, { aliases: redirectAliases })).toEqual(
        Option.some("Berlin"),
      );
      expect(Wikitext.stripToText(doc, { hiddenLinkPrefixes })).not.toContain("Bild");
    }),
  );

  it.effect(
    "gives empty lists for an empty query, and fails RequestFailed on a malformed one",
    () =>
      Effect.gen(function* () {
        expect(Action.normaliseSiteTextConfig({})).toEqual({
          hiddenLinkPrefixes: [],
          redirectAliases: [],
        });
        const { provideFetch } = stubRouter({
          "meta=siteinfo": { status: 200, body: { query: { magicwords: { redirect: "#R" } } } },
        });
        assertInstanceOf(
          yield* Effect.flip(Action.getSiteTextConfig("de.wikipedia.org").pipe(provideFetch)),
          Core.RequestFailed,
        );
      }),
  );
});
