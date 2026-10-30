---
"@thomasfosterau/effect-wikimedia": minor
---

`Wikitext.sections(doc, options?)` splits a parsed page into its sections. It is the first view in a structured layer over the AST (#209).

It returns the lead at index 0, then one `Wikitext.Section` per heading MediaWiki numbers, in document order, so `index` is the `section=N` that `action=edit` takes. Each section has:

- its `level` and a plain-text `title`;
- `parent` / `children` indices, nested as MediaWiki nests them;
- the document's own `heading` node and own body `nodes` (the same objects, not copies);
- a node-aligned `span`, and a `fullSpan`: the text `action=edit&section=N` replaces.

Absent values are `Option`s: the lead's `heading` and `title`, and the `parent` of a top-level section. `options` is passed to `stripToText` for the titles.

A heading on its own line inside a table cell is counted and nested too, as an in-table section. Its `table` is the top-level `Table` that holds it, its `nodes` are empty, and the table stays whole in the section it sits in. So the sections with no `table` partition `doc.children` exactly, and the tree and `serialize` round-trip are unaffected.
