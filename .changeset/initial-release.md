---
"@thomasfosterau/effect-wikimedia": minor
---

Initial release.

A strongly typed, Effect-idiomatic client family for Wikimedia properties, as one package with a namespace per surface on a single barrel:

- `Core` — the shared `HttpClient` service, per-wiki host validation, the typed error family, and the polite-`User-Agent` / `maxlag` / retry-after etiquette every other module builds on.
- `Action`, `Rest`, `Commons` — the Action API, the Core REST/Parsoid surface, and Commons file info / `Special:FilePath` URLs.
- `Wikidata` — the typed item / claim model (branded `Q`/`P`/`L` ids, the full snak datavalue union) plus batched `wbgetentities` and `wbsearchentities`.
- `Sparql` — the Wikidata Query Service client, with a LIMIT-enforcing helper.
- `Wikitext` — a pure, dependency-free wikitext → typed AST parser, round-trip serializer, and query surface.
- `Dumps` — Wikimedia dump processing as `Stream` pipelines, with Node-only byte sources and pluggable decompression.
- `Reconciliation` — Match/Enrich against Wikidata: label and external-identifier lookup to candidate items, then fact enrichment for a confirmed QID.

Importing one namespace never pulls another surface's code into a bundle; `tests/tree-shaking.test.ts` proves it with real `esbuild` builds.

Extracted from `thomasfosterau/website`, where it had been in production use; its pre-extraction git history is preserved.
