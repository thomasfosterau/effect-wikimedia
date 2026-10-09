---
"@thomasfosterau/effect-wikimedia": patch
---

Point the default `User-Agent` at the npm package page. `Core.USER_AGENT` is now `effect-wikimedia (+https://www.npmjs.com/package/@thomasfosterau/effect-wikimedia)`; it linked the GitHub repository, which is private, so the link 404'd for the Wikimedia operators it is there for. The `WikimediaRequest.params` docs also now say that a lone UTF-16 surrogate in a parameter value is sent as U+FFFD (`URLSearchParams` replaces it), unlike a title, which `Core.normaliseTitle` rejects. Set your own `User-Agent` through `Core.UserAgent` as before.
