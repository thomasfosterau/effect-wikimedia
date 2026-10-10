---
"@thomasfosterau/effect-wikimedia": patch
---

`Dumps.fromNodeReadable` (and so `Dumps.fromFile`, `Dumps.gunzip` and `Dumps.decompressWith`) now tears down a stalled source: interrupting the stream while the Readable is waiting for data destroys the Readable and completes once the Readable's own `destroy()` does, without waiting for that data. Before, the interruption hung and the Readable (a file descriptor, an HTTP body, a decompressor) was never released. The wait for `destroy()` to finish is bounded at one second: a source whose `destroy()` never emits `close` (a `Dumps.fromFile` read of a FIFO whose writer is open but idle, or a Readable built with `emitClose: false`) no longer holds the interruption up, but the interruption then completes before that source has released what it holds.
