---
"@thomasfosterau/effect-wikimedia": patch
---

Fix doc-comment links that pointed at nothing: module-path links such as `{@link "./core".WikimediaRequest}` (including those in the `Dumps` overview, `Dumps.onlyEntities` and `Reconciliation.WikidataLookup`), links to helpers the package doesn't export (such as the branches named on `Reconciliation.normaliseFacts`), and a stale `labelText` reference on `Wikitext.ExternalLink` (now `stripToText`). Document `Core.WikimediaClient`'s `getJson` and `getText`, including their error channel. The namespace module comments end in a bare `@module`, so generated docs name each namespace as the barrel exports it (`Core`, not `core`). Doc comments only; no runtime or type change.
