---
"@thomasfosterau/effect-wikimedia": patch
---

`Dumps.decompressWith` (and so `Dumps.gunzip`) no longer leaks its upstream source when the stream is interrupted just before the decompression stage is opened. Before, the source (an HTTP body from `Dumps.fromHttpRange`, a file) had already been started, nothing stopped it, and it stayed open; an HTTP body kept its connection. It now starts in the same uninterruptible step that opens the stage, so stream teardown stops it.

`Dumps.fromFile` on a compressed file, `Dumps.gunzip` / `Dumps.decompressWith`, and `Dumps.fromNodeReadable` over a `stream.compose` chain also no longer crash the process when the stream is torn down before it is first read. Destroying their decompression chain at that point emitted an `AbortError` that nothing listened for, which Node throws as an uncaught exception. The teardown now drops that error.
