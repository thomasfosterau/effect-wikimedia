---
"@thomasfosterau/effect-wikimedia": minor
---

Typed leaves for the Sparql and Commons response schemas (#224).

- `Sparql.SparqlResultsResponse`'s term fields (`type`, `value`, `datatype`, `xml:lang`) are now `string`, through `Core.lenientField`. A value of the wrong kind is dropped at decode, so `normaliseTerm` reads typed values.
- Commons' internal `imageinfo` schema reads `url`, `descriptionurl` and `mime` the same way.

The `Type` of `SparqlResultsResponse` narrows from `unknown`, so code that builds one by hand, or passes `normaliseTerm` a raw term, must now pass strings. That's breaking, hence `minor` on 0.x. Decoding a real response behaves as before.
