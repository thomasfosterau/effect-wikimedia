---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** Sparql uses `Option` for absent values (#224).

- `LiteralTerm.datatype` and `language`, `UnknownTerm.type` and `value`, and `SparqlResults.boolean`, the `ASK` answer, are `Option`s.
- `Sparql.literalKind(datatype, language)` takes `Option`s. A `Some` language, `Some("")` included, makes a literal `"monolingualtext"`.
