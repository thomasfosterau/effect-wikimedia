---
"@thomasfosterau/effect-wikimedia": patch
---

Dumps: stream teardown now behaves the same on every `effect` 4.x, including 4.1 (#235). Interrupting a `fromNodeReadable`, `fromFile` or `decompressWith` stream again waits, for at most one second, for the Readable to close before the interruption returns. Under `effect` 4.1 it had stopped waiting, because `Stream.fromAsyncIterable` no longer awaits the iterator's `return()` while a read is pending. `decompressWith` now rejects a bad stage before it starts the upstream source, as `fromFile` already did before opening its file, so a rejected stage never opens the source.
