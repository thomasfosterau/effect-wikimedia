---
"@thomasfosterau/effect-wikimedia": patch
---

Document that a lone UTF-16 surrogate in a `WikimediaRequest.params` value is sent as U+FFFD, because `URLSearchParams` replaces it. A title is different: `Core.normaliseTitle` rejects one.
