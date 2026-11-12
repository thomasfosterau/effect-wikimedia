---
"@thomasfosterau/effect-wikimedia": minor
---

Add `Wikitext.paragraphs(input, options?)`, the paragraph view over the AST (#209, slice 6). It finds the runs of prose lines. A blank line ends one, and so does a block-level line: a list item, a `----` rule, a preformatted line, or a line holding a table or a heading. Each `Paragraph` has its nodes (fresh per-line `Text`, line breaks included; other nodes are the document's own), its span and its trimmed text. New type: `Paragraph`.
