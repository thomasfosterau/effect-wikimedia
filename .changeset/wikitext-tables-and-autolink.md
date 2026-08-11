---
"@thomasfosterau/effect-wikimedia": minor
---

`Wikitext`: parse wikitables (`{| … |}`) into structured `Table`/`TableCaption`/`TableRow`/`TableCell` nodes, and recognise bare `http(s)://` URLs in running text as `AutoLink` nodes, closing both vocabulary deferrals from thomasfosterau/website#1287.

- Tables: rows (`|-`), header (`!`/`!!`) and data (`|`/`||`) cells, captions (`|+`), and table/row/cell attributes, including MediaWiki's single-pipe attribute/content split and its `[[`-guard against misreading a wikilink's own pipe as the separator. Table recognition is block-level only (like headings), and nested tables are supported.
- Bare URL autolinking matches MediaWiki's documented `makeFreeExternalLink` trailing-punctuation semantics (`,;.:!?`, plus a trailing `)` only when the URL contains no `(`), and never double-links a URL already inside `[url label]` bracketed syntax.

Both are additive: parses of input without tables or bare URLs remain byte-identical.
