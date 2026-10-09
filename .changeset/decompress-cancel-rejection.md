---
"@thomasfosterau/effect-wikimedia": patch
---

Fix a crash in `Dumps.decompressWith`. When the upstream source had already failed and the stage was rejected (it isn't a Node stream), cancelling the errored web stream produced an unhandled promise rejection, which crashes a Node process. The rejection is now swallowed. The stream fails with the `SourceError` for the rejected stage, and the upstream's own error is not reported.
