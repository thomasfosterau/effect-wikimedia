---
"@thomasfosterau/effect-wikimedia": patch
---

`Dumps.fromFile` and `Dumps.decompressWith` now accept a classic (pre-streams2) Node stream as the decompressor, such as the one `unbzip2-stream` returns, so Wikidata's `.json.bz2` dumps stream through `{ decompressor: () => unbzip2() }`. Such a stream emits `end` and `close` but never `finish`, and `stream.compose` failed it with a `SourceError` "Premature close"; it is now adapted into a `Duplex` first. A `Duplex` or `Transform` passes through unchanged. The `Decompressor` docs and the README show the bzip2 recipe.
