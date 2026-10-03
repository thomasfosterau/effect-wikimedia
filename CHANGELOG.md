# @thomasfosterau/effect-wikimedia

## 0.3.0

### Minor Changes

- 1fc2b7a: Raise the Effect floor to the shared library floor: requires `effect@>=4.0.0-rc.118`; import paths moved from `effect/unstable/*` to `effect/*`.

  `peerDependencies.effect` moves from `>=4.0.0-beta.104` to `>=4.0.0-rc.118`, and the package's own imports of `effect/unstable/http` now read `effect/http`. Consumers on any `beta` or earlier `rc` build must upgrade `effect` to `4.0.0-rc.118` or later before taking this release; the previous release's published output imports `effect/unstable/*`, which no longer exists in `rc.118`. No public API of this package changes.

- 5cb985c: Migrate off the removed `Schema.TaggedErrorClass` API to `Schema.TaggedError`, which was renamed in effect `4.0.0-beta.104`. `TaggedErrorClass` no longer exists at `beta.104` and later, so importing this package under a current `effect` version previously threw at module load.

  This is a breaking change: `peerDependencies.effect` moves from `^4.0.0-beta.102` to `>=4.0.0-beta.104`. Consumers pinned to `effect@<=4.0.0-beta.103` must upgrade `effect` before taking this release.

  This change was first published as 1.0.0 in error. That version is withdrawn, and the change ships here as 0.3.0, the next version after 0.2.0.

### Patch Changes

- 40df6e1: Rewrite the doc comments ported from the website app so they describe this package: module headers lead with their description, `@module` names match the source layout, and links to files that don't exist here are gone.
- d524895: Tested against effect 4.0.0; the peer floor is unchanged (`>=4.0.0-rc.118`). No source or public type changes.

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
