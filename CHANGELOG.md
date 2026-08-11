# @thomasfosterau/effect-wikimedia

## 0.2.0

### Minor Changes

- 15a9506: `Wikitext`: parse wikitables (`{| … |}`) into structured `Table`/`TableCaption`/`TableRow`/`TableCell` nodes, and recognise bare `http(s)://` URLs in running text as `AutoLink` nodes, closing both vocabulary deferrals from thomasfosterau/website#1287.

  - Tables: rows (`|-`), header (`!`/`!!`) and data (`|`/`||`) cells, captions (`|+`), and table/row/cell attributes, including MediaWiki's single-pipe attribute/content split and its `[[`-guard against misreading a wikilink's own pipe as the separator. Table recognition is block-level only (like headings), and nested tables are supported.
  - Bare URL autolinking matches MediaWiki's documented `makeFreeExternalLink` trailing-punctuation semantics (`,;.:!?`, plus a trailing `)` only when the URL contains no `(`), and never double-links a URL already inside `[url label]` bracketed syntax.

  Both are additive: parses of input without tables or bare URLs remain byte-identical.

## 0.1.0

### Minor Changes

- 447fe5d: Initial release.

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
