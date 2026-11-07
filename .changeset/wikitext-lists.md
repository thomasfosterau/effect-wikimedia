---
"@thomasfosterau/effect-wikimedia": minor
---

Add `Wikitext.lists(input)`, the list view over the AST (#209, slice 3). It groups consecutive `*` / `#` / `:` / `;` lines into lists. Each item carries its full marker (`#*`), depth and kind (bullet, number, indent, term, definition), its content nodes, and its span. A one-line `;term:definition` gives two items. A multi-line text node is split into fresh per-line `Text` nodes with exact spans; every other node is the document's own. New types: `List`, `ListItem`, `ListItemKind`.
