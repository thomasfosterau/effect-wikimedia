---
"@thomasfosterau/effect-wikimedia": patch
---

Document every `Wikitext` AST property. Each field of the node types (`Span`, `Document`, `Text`, `Comment`, `HtmlEntity`, `Formatting`, `Heading`, `Template`, `Argument`, `Param`, `Wikilink`, `ExternalLink`, `AutoLink`, `Tag`, `Table`, `TableCaption`, `TableRow`, `TableCell`) now has a doc comment. Each says what the field holds, when it is absent or empty, and how it maps to MediaWiki's reading of the wikitext. `Span` offsets are UTF-16 code units from the start of `Document.source`, with an exclusive end. Three interface comments were also corrected: a heading's `trailing` holds only spaces and tabs, an explicit `|-` row's `open` is at least its line break (`"\n"`), not `""`, and an ordinary wikilink's label is all its `segments` rejoined with `|`, not only the first.
