---
"@thomasfosterau/effect-wikimedia": patch
---

`Dumps.SourceError.description` is now documented: a reason code (`dumps/source-read-failed` or `dumps/http-range-failed`), a colon, then the underlying error's message. Every public property now carries a doc comment, and the docs gate requires one on new ones.
