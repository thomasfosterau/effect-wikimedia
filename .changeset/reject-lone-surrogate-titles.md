---
"@thomasfosterau/effect-wikimedia": patch
---

`Core.normaliseTitle` now rejects a title that contains a lone UTF-16 surrogate, which made `encodeURIComponent` throw `URIError`. `Rest`, `Action` and `Commons.getFileInfo` fail with `InvalidRequest` before any request (the `Rest` path builders previously died with a `URIError` defect, and `Action` sent the title with the surrogate replaced by U+FFFD), and `Commons.filePathUrl` and `Reconciliation.normaliseCommonsImage` return `null` instead of throwing. Valid surrogate pairs, such as emoji, are still accepted.
