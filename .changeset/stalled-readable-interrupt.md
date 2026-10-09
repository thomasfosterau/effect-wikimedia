---
"@thomasfosterau/effect-wikimedia": patch
---

`Dumps.fromNodeReadable` (and so `Dumps.fromFile`, `Dumps.gunzip` and `Dumps.decompressWith`) now tears down a stalled source: interrupting the stream while the Readable is waiting for data destroys the Readable and completes once the Readable's own `destroy()` does, without waiting for that data. Before, the interruption hung and the Readable (a file descriptor, an HTTP body, a decompressor) was never released. A source whose `destroy()` never emits `close` (a `Dumps.fromFile` read of a FIFO whose writer is open but idle, or a Readable built with `emitClose: false`) still holds the interruption up.
