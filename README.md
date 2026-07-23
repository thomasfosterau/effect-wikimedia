# @thomasfosterau/effect-wikimedia

A strongly typed, Effect-idiomatic client family for Wikimedia properties (Wikipedia, Wikidata, Commons, and siblings). One package, **module-per-surface**, designed from day one for extraction to its own repository/npm package — see [the decision doc](../../docs/decisions/effect-wikimedia-as-the-wikimedia-client-toolkit.md).

Every surface is a namespace on the package's single `"."` barrel (`import { Action, Rest, Commons, Wikidata, Sparql, Core } from "@thomasfosterau/effect-wikimedia"`); importing one namespace never pulls another surface's code into a bundle (`tests/tree-shaking.test.ts` proves this with a real `esbuild` build).

## Module surface

- **`Core`** — the shared `HttpClient`-based service (`WikimediaClient`), per-wiki host validation (`normaliseWikimediaHost`), the typed error family (`InvalidRequest` / `RequestFailed` / `RateLimited`), and the polite-`User-Agent` / `maxlag` / retry-after etiquette every other module builds on.
- **`Action`** — the Action API (`/w/api.php`): `getWikitext`, `getPageMetadata`, `search`, `parsePage` (sections/links/categories/templates).
- **`Rest`** — the Core REST API / Parsoid surface (`/w/rest.php/v1/...`): `getPageMetadata`, `getRevisionMetadata`, `getParsedHtml`, `getRevisionHtml`.
- **`Commons`** — `filePathUrl` (`Special:FilePath` URL construction, with optional thumbnail width) and `getFileInfo`.
- **`Wikidata`** — the typed Wikidata item / claim model: branded `Q`/`P`/`L` ids (`ItemId` / `PropertyId` / `LexemeId`), the full snak `DataValue` union (`wikibase-entityid`, `time`, `globecoordinate`, `quantity`, `monolingualtext`, `string`, `external-id`, and a lenient `unknown` degrade), statements with rank / qualifiers / references, sitelinks, and per-language label / description / alias maps. `getEntities` (batched `wbgetentities`, 50-id chunking) and `searchEntities` (`wbsearchentities`).
- **`Sparql`** — the Wikidata Query Service (WDQS) SPARQL client: `query` (with a LIMIT-enforcing helper, `hasLimitClause`) decoding SPARQL 1.1 JSON results into typed terms (`uri` / `literal` / `bnode` / `unknown`), and `literalKind` mapping `xsd:*` datatypes back toward the Wikibase datavalue vocabulary.

Later epic slices (#1065-#1066) add `Wikitext` and `Dumps` as further namespaces on the same barrel.

## Usage

```ts
import * as Effect from "effect/Effect";
import { Action, Core } from "@thomasfosterau/effect-wikimedia";

const program = Action.getWikitext("en.wikipedia.org", "Douglas Adams").pipe(
  Effect.provide(Core.wikimediaLayer),
);
```

Every request goes through `Core.WikimediaClient`, which applies the UA policy and `maxlag` etiquette, and retries a `429`/`503`/in-body maxlag signal automatically. `Core.wikimediaLayer` is the production layer (over the platform `fetch`); tests provide `Core.wikimediaClientLayer` over a stubbed `HttpClient` instead — see `tests/core.test.ts`.

## Testing

`vp run test:unit` runs the suite against recorded fixtures (`tests/fixtures/`) with the network stubbed at `FetchHttpClient.Fetch` — there is no live network access anywhere in this package's tests or in CI.
