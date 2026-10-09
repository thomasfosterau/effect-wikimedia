---
"@thomasfosterau/effect-wikimedia": patch
---

`Dumps.decompressWith` no longer leaves its upstream source open when the `Decompressor` returns a value that isn't a Node stream: the stream still fails with a `SourceError`, and the source (an HTTP range download, a file) is now cancelled and closed. `Dumps.fromFile` likewise destroys the decompressor it created when opening the file throws. The `Dumps.NodeDuplexLike` and `Dumps.Decompressor` docs now say what the runtime check covers: a value that `node:stream` doesn't recognise as a stream fails with a `SourceError`; pass a real Node stream.
