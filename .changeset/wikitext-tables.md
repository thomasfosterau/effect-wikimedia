---
"@thomasfosterau/effect-wikimedia": minor
---

Add the table views over the AST (#209, slice 5).

- `Wikitext.tableGrid(table)` lays a table's cells out on a grid, expanding `rowspan` and `colspan` as a browser does. Spans are clamped to 1–1000 / 1–65534, and `rowspan=0` runs to the last row. Each slot points back at its own `TableCell`, with `origin` marking where the span starts.
- `Wikitext.tableRecords(table, options?)` reads the rows as records. The keys come from the first all-header row, or are column numbers when there is none. A row's leading `!` cell becomes its `rowHeader`.

New types: `GridCell`, `TableRecord`.
