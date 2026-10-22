---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** a table caption written after a row or cell now round-trips: `Wikitext.serialize(Wikitext.parse(s)) === s` holds for `{|\n|a\n|+cap\n|b\n|}`, which used to move the caption to the top. `TableCaption` gains `row`, the index in `Table.rows` of the row it precedes, and `serialize` writes each caption there. A caption ends the row it interrupts (as an HTML parser closes the row at the `<caption>` MediaWiki emits), so cells after it open a new implicit row, and row and caption spans no longer overlap. Code that builds `TableCaption` nodes must set `row`.
