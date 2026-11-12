# @thomasfosterau/effect-wikimedia

**Disclaimer:** This is an experimental library mostly written using Claude Code. Not extensively tested, still a work in progress, use at your own risk.

Typed [Effect](https://effect.website) clients for Wikimedia: Wikipedia, Wikidata, Commons, the Wikidata Query Service, wikitext and dumps.

## Install

```sh
pnpm add @thomasfosterau/effect-wikimedia effect
```

`effect` (`^4.0.0`) is a peer dependency.

## Example

```ts
import * as Effect from "effect/Effect";
import { Action, Core } from "@thomasfosterau/effect-wikimedia";

const page = Action.getWikitext("en.wikipedia.org", "Douglas Adams").pipe(
  Effect.provide(Core.wikimediaLayer),
);
```

## Entry points

Every namespace is exported from the package root and tree-shakes independently.

| Namespace        | For                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `Core`           | The shared client (`WikimediaClient`), host validation, errors, the User-Agent and the `maxlag` retry policy. |
| `Action`         | The Action API (`/w/api.php`): wikitext, page metadata, search, parse, a wiki's text settings.                |
| `Rest`           | The REST API and Parsoid (`/w/rest.php/v1`): page and revision metadata, rendered HTML.                       |
| `Commons`        | Commons file URLs and file info.                                                                              |
| `Wikidata`       | The typed Wikidata item model, `wbgetentities` and `wbsearchentities`.                                        |
| `Sparql`         | Wikidata Query Service (SPARQL) queries with typed result terms.                                              |
| `Wikitext`       | A pure wikitext parser with a lossless serializer, queries, and views (sections, infoboxes, tables, …).       |
| `Dumps`          | Wikidata JSON and MediaWiki XML dumps as constant-memory `Stream`s, multistream random access and workers.    |
| `Reconciliation` | Match a label or identifier to Wikidata items, and pull their facts.                                          |

## More

- [Requests: User-Agent, etiquette and CORS](https://unpkg.com/@thomasfosterau/effect-wikimedia/docs/requests.md)
- [Dumps: bzip2, multistream and workers](https://unpkg.com/@thomasfosterau/effect-wikimedia/docs/dumps.md)
- [Type-checking against the package](https://unpkg.com/@thomasfosterau/effect-wikimedia/docs/typescript.md)
- [Migrating from 0.9 to 0.10](https://unpkg.com/@thomasfosterau/effect-wikimedia/MIGRATION.md)
- [Changelog](https://unpkg.com/@thomasfosterau/effect-wikimedia/CHANGELOG.md)
- The API reference is in each export's doc comments, shown in your editor and in the shipped `.d.ts` files.

Questions, bug reports, and reports from Wikimedia operators about this client's traffic: [me@thomasfoster.au](mailto:me@thomasfoster.au). The source repository is private.

## License

MIT. The `Wikitext` HTML entity table comes from the HTML Standard and the `character-entities` package; their licenses are in [THIRD_PARTY_NOTICES.md](https://unpkg.com/@thomasfosterau/effect-wikimedia/THIRD_PARTY_NOTICES.md).
