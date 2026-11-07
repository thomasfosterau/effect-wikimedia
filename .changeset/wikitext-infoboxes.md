---
"@thomasfosterau/effect-wikimedia": minor
---

Add `Wikitext.infoboxes(input, options?)`, the infobox view over the AST (#209, slice 2). It finds each template named `Infobox` or `Infobox …`, plus any names given in `options.names` (`Taxobox`, `Chembox`, …). Each field is returned as a fragment trimmed at its edges, so links and templates survive, along with its text. Every record holds the document's own `Template` and `Param` nodes. `options` also takes `stripToText`'s options, which are applied to each field's `text`. New types: `Infobox`, `InfoboxField`, `InfoboxesOptions`.
