# @thomasfosterau/effect-wikimedia

**Disclaimer:** This is an experimental library mostly written using Claude Code. Not extensively tested, still a work in progress, use at your own risk.

A strongly typed, Effect-idiomatic client family for Wikimedia properties — Wikipedia, Wikidata, Commons, WDQS, wikitext, and dumps.

Every surface is a namespace on the package's single `.` entry point (`import { Action, Core } from "@thomasfosterau/effect-wikimedia"`), and each namespace is a tree-shakeable slice built on `Core` (except the pure `Wikitext`): importing `Action` never pulls `Rest` or `Commons` into a bundle.

## Install

```sh
pnpm add @thomasfosterau/effect-wikimedia effect
```

`effect` is a required peer dependency (`>=4.0.0`) — two copies break `Context` / `Layer` / `Schema` identity at runtime.

The package's declarations need no `@types/node`: the Node-only `Dumps` byte sources type their stream parameters structurally. A project that type-checks dependencies' declarations (`skipLibCheck: false`) still needs a `lib` that covers `effect`'s own: `ESNext.Disposable` (or `ESNext`) for `Disposable` / `AsyncDisposable`, and `DOM` for the web types they name (`URL`, `Request`, `ReadableStream`; `WebWorker` alone lacks the `Storage` that `effect/persistence` names).

## Usage

```ts
import * as Effect from "effect/Effect";
import { Action, Core } from "@thomasfosterau/effect-wikimedia";

const program = Action.getWikitext("en.wikipedia.org", "Douglas Adams").pipe(
  Effect.provide(Core.wikimediaLayer),
);
```

Every `Action`, `Rest`, `Commons`, `Wikidata` and `Sparql` request goes through `Core.WikimediaClient`, which applies the UA policy, the `maxlag` etiquette and the Action API's `origin=*` (see [Anonymous requests](#anonymous-requests)), and retries a `429`/`503`/in-body maxlag signal automatically. `Core.wikimediaLayer` is the production layer (over the platform `fetch`); in tests, provide `Core.wikimediaClientLayer` over a stubbed `HttpClient` instead.

### User-Agent

Wikimedia's [User-Agent policy](https://meta.wikimedia.org/wiki/User-Agent_policy) asks every caller to identify itself with contact details, so problem traffic can be raised with its owner rather than blocked. By default every request sets both the `User-Agent` and the `Api-User-Agent` header to `Core.USER_AGENT`, which names only this package (`effect-wikimedia (+https://www.npmjs.com/package/@thomasfosterau/effect-wikimedia)`). Set your own through the `Core.UserAgent` reference, which sets both headers; in Node both are sent verbatim:

```ts
import * as Layer from "effect/Layer";

const userAgent = "my-bot/1.2 (https://example.org/my-bot; bot@example.org) effect-wikimedia";

const program = Action.getWikitext("en.wikipedia.org", "Douglas Adams").pipe(
  Effect.provide(
    Core.wikimediaLayer.pipe(Layer.provideMerge(Layer.succeed(Core.UserAgent, userAgent))),
  ),
);
```

In a browser, the browser decides what happens to `User-Agent`. The Fetch standard lets a page set it, but Chromium-based browsers silently drop it and send their own. Wikimedia's [API etiquette](https://www.mediawiki.org/wiki/API:Etiquette#The_User-Agent_header) asks browser clients to send an `Api-User-Agent` header instead, and browsers send that one as given, so your value still reaches Wikimedia.

The cost is a CORS preflight. `Api-User-Agent` isn't a [CORS-safelisted request header](https://fetch.spec.whatwg.org/#cors-safelisted-request-header), so a browser sends an `OPTIONS` request before a cross-origin request, and Wikimedia's APIs set no `Access-Control-Max-Age`, so the browser caches each preflight for only about 5 seconds. The Action API with `origin=*` (see [Anonymous requests](#anonymous-requests)) and the REST API allow the header in their preflight responses: both allow the headers in MediaWiki's [`$wgAllowedCorsHeaders`](https://github.com/wikimedia/mediawiki/blob/18d8c1070cde87412919f36e46a8197185534272/includes/MainConfigSchema.php#L12992-L13011), which lists `Api-User-Agent`. WDQS's [nginx config](https://github.com/wikimedia/operations-puppet/blob/1a24a2a3354c4a147ac712d1cfb01879b01611e3/modules/query_service/templates/nginx.erb#L253-L259) lists it too, though no live WDQS preflight has been checked. A browser that honours a script-set `User-Agent` preflights already, because that header isn't safelisted either.

`Dumps.fromHttpRange` sends `User-Agent` only: it's a Node download from the dump host, which serves files rather than an API.

`Core.WikimediaClient` reads the reference once, when its layer is built. `Dumps.fromHttpRange` reads it from the program's context when the stream runs, or takes a `userAgent` option that wins over it. Merging the reference into the layer with `Layer.provideMerge`, as above, reaches both (`Dumps.fromHttpRange` also needs an `HttpClient`, such as `FetchHttpClient.layer`, which `Core.wikimediaLayer` doesn't expose). So does `Effect.provideService(Core.UserAgent, userAgent)` placed outside the `Effect.provide` that builds the layer. `Layer.provide` reaches the client only. A `provideService` the layer build doesn't see reaches the dump download only: one applied inside `Effect.provide(Core.wikimediaLayer)`, or per run on a `ManagedRuntime` made from the layer.

### Anonymous requests

Every Action API (`/w/api.php`) request carries `origin=*`, so a page on another origin can read the response: without an `origin` parameter MediaWiki sends no CORS headers on the Action API. `origin=*` is MediaWiki's anonymous mode, so `Action`, `Commons`, `Wikidata` and `Reconciliation` make anonymous requests. MediaWiki answers as a logged-out user whatever credentials arrive, which is all these read-only surfaces need, and their limits are already the anonymous ones. Two setups lose their credentials:

- an on-wiki gadget or user script on the same origin that relies on the user's session cookies;
- a caller that adds an `Authorization` header (an OAuth token, say) through `HttpClient.mapRequest`.

`Rest` and `Sparql` requests don't carry the parameter, because the REST API and WDQS already send CORS headers without it. A request you build yourself for `Core.WikimediaClient` keeps any `origin` you put in its `params`, sent instead of `*`. If its `params` carry `crossorigin`, it gets no `origin=*`. `crossorigin` is MediaWiki's authenticated-CORS mode, which needs an `Authorization` header; without one, MediaWiki rejects the request. MediaWiki also returns a 403 for a request that carries both `origin` and `crossorigin`, so don't put both in `params`.

### bzip2 dumps

Wikidata publishes its entity dumps as `.json.gz` and `.json.bz2`. `Dumps.fromFile` decompresses a `.gz` file by itself, but Node has no bzip2, and the package ships no decoder. Bring one as the `decompressor`, for example [`unbzip2-stream`](https://www.npmjs.com/package/unbzip2-stream):

```ts
import * as Stream from "effect/Stream";
import unbzip2 from "unbzip2-stream";
import { Dumps } from "@thomasfosterau/effect-wikimedia";

const itemCount = Dumps.fromFile("latest-all.json.bz2", { decompressor: () => unbzip2() }).pipe(
  Dumps.entityRecords,
  Dumps.onlyEntities,
  Stream.runCount,
);
```

`Dumps.decompressWith(() => unbzip2())` decompresses any other byte stream, such as a `Dumps.fromHttpRange` download. Return a new decoder from each call. `unbzip2-stream` returns a classic (pre-streams2) Node stream, which `Dumps` adapts for `stream.compose`; a `Transform` from another library works as is. `unbzip2-stream` is pure JavaScript and decodes on the event loop, so where both are published the `.json.gz` dump avoids that cost.

## API

- **`Core`** — the shared `HttpClient`-based service (`WikimediaClient`), per-wiki host validation (`normaliseWikimediaHost`, which accepts Wikipedia, Wikidata, `*.wikimedia.org`, the sister projects — Wiktionary, Wikivoyage, Wikisource, Wikiquote, Wikibooks, Wikinews, Wikiversity — mediawiki.org and Wikifunctions, and no other host), the typed error family (`InvalidRequest` / `RequestFailed` / `RateLimited`), the configurable `User-Agent` and `Api-User-Agent` (`UserAgent`, defaulting to `USER_AGENT`), the Action API's `origin=*`, and the `maxlag` / retry-after etiquette every other module builds on.
- **`Action`** — the Action API (`/w/api.php`): `getWikitext`, `getPageMetadata`, `search`, `parsePage` (sections/links/categories/templates).
- **`Rest`** — the Core REST API / Parsoid surface (`/w/rest.php/v1/...`): `getPageMetadata`, `getRevisionMetadata`, `getParsedHtml`, `getRevisionHtml`.
- **`Commons`** — `filePathUrl` (`Special:FilePath` URL construction, with optional thumbnail width) and `getFileInfo`.
- **`Wikidata`** — the typed Wikidata item / claim model: branded `Q`/`P`/`L` ids (`ItemId` / `PropertyId` / `LexemeId`), the full snak `DataValue` union (`wikibase-entityid`, `time`, `globecoordinate`, `quantity`, `monolingualtext`, `string`, `external-id`, and a lenient `unknown` degrade), statements with rank / qualifiers / references, sitelinks, and per-language label / description / alias maps. `getEntities` (batched `wbgetentities`, 50-id chunking) and `searchEntities` (`wbsearchentities`).
- **`Sparql`** — the Wikidata Query Service (WDQS) SPARQL client: `query` (with a LIMIT-enforcing helper, `hasLimitClause`) decoding SPARQL 1.1 JSON results into typed terms (`uri` / `literal` / `bnode` / `unknown`), and `literalKind` mapping `xsd:*` datatypes back toward the Wikibase datavalue vocabulary.
- **`Wikitext`** — a pure wikitext → typed AST parser written with the [`@thomasfosterau/effect-parse`](https://www.npmjs.com/package/@thomasfosterau/effect-parse) combinators, with a round-trip serializer and a query/manipulation surface. The one module that imports no other, not even `Core`.
- **`Dumps`** — Wikimedia dump processing as `Stream` pipelines: the Wikidata JSON entity dump decoded through `Wikidata`'s model, MediaWiki XML pages / incrementals via a scoped SAX-style scanner, and Node-only byte sources (file / resumable HTTP range) with pluggable gzip / bz2 decompression stages. Those byte sources are the package's only Node-only exports; the pipelines themselves stay runtime-agnostic over any `Stream<Uint8Array>`.
- **`Reconciliation`** — the one _opinionated_ namespace, layered on top of `Action` / `Wikidata`: resolve a label or an external identifier to candidate Wikidata items (**Match**), then pull the selected facts for a confirmed QID (**Enrich**). It carries policy the surface modules deliberately don't — input validators, curated property allowlists, and the candidate/fact shapes. It is persistence-free: Match returns candidates, Enrich returns facts as a `WikidataFact` union tagged by kind (`Item`, `Identifier`, `Date`, `Image`), and storing either is the caller's job.

## Contact

Questions, bug reports, and reports from Wikimedia operators about this client's traffic: email [me@thomasfoster.au](mailto:me@thomasfoster.au). The source repository is private, so there is no public issue tracker.

## Development

Commands and conventions: `AGENTS.md`; releases: `PUBLISHING.md`; contributing: `CONTRIBUTING.md`; security: `SECURITY.md` (all in the source repository, not the npm package).

## License

MIT — see the `LICENSE` file in the package. The `Wikitext` HTML entity table comes from the HTML Standard and the `character-entities` package; their licenses are in `THIRD_PARTY_NOTICES.md`, also in the package.
