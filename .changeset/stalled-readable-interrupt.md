---
"@thomasfosterau/effect-wikimedia": patch
---

`Dumps.fromNodeReadable` (and so `Dumps.fromFile`, `Dumps.gunzip` and `Dumps.decompressWith`) now tears down a stalled source: interrupting the stream while the Readable is waiting for data completes promptly and destroys the Readable. Before, the interruption hung and the Readable (a file descriptor, an HTTP body, a decompressor) was never released.
