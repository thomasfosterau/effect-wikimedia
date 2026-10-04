# @thomasfosterau/effect-wikimedia

A strongly typed, Effect-idiomatic client family for Wikimedia properties — Wikipedia, Wikidata, Commons, WDQS, wikitext, and dumps.

Every surface is a namespace on the package's single `.` entry point (`import { Action, Core } from "@thomasfosterau/effect-wikimedia"`), and each namespace is a tree-shakeable slice built on `Core` (except the pure `Wikitext`): importing `Action` never pulls `Rest` or `Commons` into a bundle.

## Install

```sh
pnpm add @thomasfosterau/effect-wikimedia effect@rc
```

`effect` is a required peer dependency (`>=4.0.0-rc.118`) — two copies break `Context` / `Layer` / `Schema` identity at runtime.

## Usage

```ts
import * as Effect from "effect/Effect";
import { Action, Core } from "@thomasfosterau/effect-wikimedia";

const program = Action.getWikitext("en.wikipedia.org", "Douglas Adams").pipe(
  Effect.provide(Core.wikimediaLayer),
);
```

Every `Action`, `Rest`, `Commons`, `Wikidata` and `Sparql` request goes through `Core.WikimediaClient`, which applies the UA policy and `maxlag` etiquette, and retries a `429`/`503`/in-body maxlag signal automatically. `Core.wikimediaLayer` is the production layer (over the platform `fetch`); in tests, provide `Core.wikimediaClientLayer` over a stubbed `HttpClient` instead.

### User-Agent

Wikimedia's [User-Agent policy](https://meta.wikimedia.org/wiki/User-Agent_policy) asks every caller to identify itself with contact details, so problem traffic can be raised with its owner rather than blocked. By default every request sends `Core.USER_AGENT`, which names only this package (`effect-wikimedia (+https://github.com/thomasfosterau/effect-wikimedia)`). Set your own through the `Core.UserAgent` reference; the value is sent verbatim:

```ts
import * as Layer from "effect/Layer";

const userAgent = "my-bot/1.2 (https://example.org/my-bot; bot@example.org) effect-wikimedia";

const program = Action.getWikitext("en.wikipedia.org", "Douglas Adams").pipe(
  Effect.provide(Core.wikimediaLayer.pipe(Layer.provide(Layer.succeed(Core.UserAgent, userAgent)))),
);
```

`Core.WikimediaClient` reads the reference once, when its layer is built. `Dumps.fromHttpRange` reads it when the stream runs, or takes a `userAgent` option that wins over it. `Effect.provideService(Core.UserAgent, userAgent)` covers both only when it sits outside the `Effect.provide` that builds the layer. Applied inside `Effect.provide(Core.wikimediaLayer)`, or per run on a `ManagedRuntime` made from the layer, it reaches `Dumps.fromHttpRange` but not the already-built client, which keeps the default. Providing it to the layer, as above, avoids the split.

## API

- **`Core`** — the shared `HttpClient`-based service (`WikimediaClient`), per-wiki host validation (`normaliseWikimediaHost`), the typed error family (`InvalidRequest` / `RequestFailed` / `RateLimited`), the configurable `User-Agent` (`UserAgent`, defaulting to `USER_AGENT`), and the `maxlag` / retry-after etiquette every other module builds on.
- **`Action`** — the Action API (`/w/api.php`): `getWikitext`, `getPageMetadata`, `search`, `parsePage` (sections/links/categories/templates).
- **`Rest`** — the Core REST API / Parsoid surface (`/w/rest.php/v1/...`): `getPageMetadata`, `getRevisionMetadata`, `getParsedHtml`, `getRevisionHtml`.
- **`Commons`** — `filePathUrl` (`Special:FilePath` URL construction, with optional thumbnail width) and `getFileInfo`.
- **`Wikidata`** — the typed Wikidata item / claim model: branded `Q`/`P`/`L` ids (`ItemId` / `PropertyId` / `LexemeId`), the full snak `DataValue` union (`wikibase-entityid`, `time`, `globecoordinate`, `quantity`, `monolingualtext`, `string`, `external-id`, and a lenient `unknown` degrade), statements with rank / qualifiers / references, sitelinks, and per-language label / description / alias maps. `getEntities` (batched `wbgetentities`, 50-id chunking) and `searchEntities` (`wbsearchentities`).
- **`Sparql`** — the Wikidata Query Service (WDQS) SPARQL client: `query` (with a LIMIT-enforcing helper, `hasLimitClause`) decoding SPARQL 1.1 JSON results into typed terms (`uri` / `literal` / `bnode` / `unknown`), and `literalKind` mapping `xsd:*` datatypes back toward the Wikibase datavalue vocabulary.
- **`Wikitext`** — a pure, dependency-free wikitext → typed AST parser, with a round-trip serializer and a query/manipulation surface. The one module that imports nothing, not even `Core`.
- **`Dumps`** — Wikimedia dump processing as `Stream` pipelines: the Wikidata JSON entity dump decoded through `Wikidata`'s model, MediaWiki XML pages / incrementals via a scoped SAX-style scanner, and Node-only byte sources (file / resumable HTTP range) with pluggable gzip / bz2 decompression stages. Those byte sources are the package's only Node-only exports; the pipelines themselves stay runtime-agnostic over any `Stream<Uint8Array>`.
- **`Reconciliation`** — the one _opinionated_ namespace, layered on top of `Action` / `Wikidata`: resolve a label or an external identifier to candidate Wikidata items (**Match**), then pull the selected facts for a confirmed QID (**Enrich**). It carries policy the surface modules deliberately don't — input validators, curated property allowlists, and the candidate/fact shapes. It is persistence-free: Match returns candidates, Enrich returns neutral facts, and storing either is the caller's job.

## Development

Commands and conventions: [AGENTS.md](AGENTS.md). Releases: [docs/RELEASING.md](docs/RELEASING.md).

## License

[MIT](LICENSE)
