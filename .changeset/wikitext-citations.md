---
"@thomasfosterau/effect-wikimedia": minor
---

Add `Wikitext.citations(doc, options?)`, the citation view over the AST (#209, slice 4). It returns every `<ref>`, at any depth.

- Each `Citation` has its `name` and `group` (as `Option`s) and the document's own `Tag`.
- `body` is the ref's content parsed with `parse`'s `offset`, so its spans index the page.
- `templates` lists the citation templates in the body: `Citation`, `Cite …`, and any `options.names`.
- `reuse` marks a bodiless `<ref name=… />`, and `definition` points to the first citation that defines that name in its group.

New types: `Citation`, `CitationsOptions`.
