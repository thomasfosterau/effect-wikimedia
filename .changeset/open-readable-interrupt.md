---
"@thomasfosterau/effect-wikimedia": patch
---

`Dumps.fromNodeReadable` (and so `Dumps.fromFile`, `Dumps.gunzip` and `Dumps.decompressWith`) no longer leaks the Readable when the stream is interrupted just after opening it. Opening the Readable and registering its teardown are now one uninterruptible step, so an interruption that arrives right after the `evaluate` callback returns destroys the Readable. Before, the stream completed as interrupted and the Readable (a file descriptor, an HTTP body, a decompressor) stayed open.
