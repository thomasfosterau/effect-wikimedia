---
"@thomasfosterau/effect-wikimedia": patch
---

A decompression stage (`Dumps.fromFile` with a decompressor, `Dumps.decompressWith`, `Dumps.gunzip`) that emits `error` after its output has ended, once the stream has already completed, no longer crashes the process with an uncaught exception. Errors while the stream is read still fail it with `SourceError`.
