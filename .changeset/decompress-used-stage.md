---
"@thomasfosterau/effect-wikimedia": patch
---

`Dumps.decompressWith` and `Dumps.fromFile` no longer leak when the `Decompressor` returns a stream that is already used. A stage already destroyed, or one whose input had ended, failed the stream with a `SourceError` but left the upstream source (an HTTP range download, a file) open, or, in `fromFile`, the file descriptor. A stage whose output had already ended made `decompressWith` hang and `fromFile` succeed with no bytes. Such a stage now fails the stream with a `SourceError` before anything is opened. If Node's `stream.compose` rejects a stage anyway, the source or file it was given is now closed. The `Dumps.NodeDuplexLike` and `Dumps.Decompressor` docs now say the stage must be a new Node stream each time.
