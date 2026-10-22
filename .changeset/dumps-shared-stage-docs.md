---
"@thomasfosterau/effect-wikimedia": patch
---

The `Dumps` decompressor check now says exactly what it enforces. A `Decompressor` that returns a stream already destroyed or ended fails with `SourceError`, as before, but the message now reads "the decompressor must return a Node stream (a Duplex, a Transform or a classic duplex stream) that is neither destroyed nor ended, not a plain object" (it promised a "fresh" stream). The `Decompressor` and `NodeDuplexLike` docs note that a stage shared by two streams at once isn't detected.
