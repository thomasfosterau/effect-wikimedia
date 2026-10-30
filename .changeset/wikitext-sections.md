---
"@thomasfosterau/effect-wikimedia": minor
---

`Wikitext.sections(doc)` splits a parsed page into its sections, the first view in a structured layer over the AST (#209). It returns the lead at index 0, then one `Wikitext.Section` per top-level heading, in document order. Each section has its `level`, its plain-text `title`, and `parent` / `children` indices nested as MediaWiki nests them. It also holds the document's own `heading` node and own body `nodes` (the same objects, not copies), plus a `span` and a `fullSpan` (the section with its subsections, the text `action=edit&section=N` replaces). Together the sections partition `doc.children` exactly, so the tree and `serialize` round-trip are unaffected. A heading inside a table cell does not open a section.
