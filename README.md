# @thomasfosterau/effect-wikimedia

A strongly typed, Effect-idiomatic client family for Wikimedia properties — Wikipedia, Wikidata, Commons, WDQS, wikitext, and dumps.

Every surface is a namespace on the package's single `.` entry point (`import { Action, Core } from "@thomasfosterau/effect-wikimedia"`), and each namespace is a tree-shakeable slice built on `Core`: importing `Action` never pulls `Rest` or `Commons` into a bundle.

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

## API

- **`Core`** — the shared `HttpClient`-based service (`WikimediaClient`), per-wiki host validation (`normaliseWikimediaHost`), the typed error family (`InvalidRequest` / `RequestFailed` / `RateLimited`), and the polite-`User-Agent` / `maxlag` / retry-after etiquette every other module builds on.
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
