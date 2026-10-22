---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** `Sparql.query` now returns an `ASK` query's answer. `SparqlResults` gains `boolean: boolean | null`, the response's top-level `boolean` for an `ASK` and `null` for any other query; before, an `ASK` gave empty `vars` and `bindings` whatever the answer. Code that builds a `SparqlResults` must set the new field. Also, `UnknownTerm.type` is now cut at 200 UTF-16 code units, like every other string `normaliseTerm` copies.
