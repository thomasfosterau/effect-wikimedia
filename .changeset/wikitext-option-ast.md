---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** the Wikitext AST uses `Option` for its optional fields (#224).

These fields are now `Option`s, `None` where they were `undefined`:

- `Param.name`: `None` for a positional parameter.
- `Argument.default`.
- `ExternalLink.label`.
- `Tag.rawContent` and `Tag.closeRaw`.
- `TableCaption.attrs` and `TableCell.attrs`.
- `TableRow.open`: `None` for an implicit row.

Code that builds nodes by hand must pass `Option`s. `serialize(parse(s)) === s` still holds, and `parse(source, { offset })` keeps the `Option`s while it shifts spans.
