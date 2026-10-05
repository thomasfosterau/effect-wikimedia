---
"@thomasfosterau/effect-wikimedia": patch
---

`Core` no longer adds `origin=*` to an Action API request whose `params` already carry `crossorigin`, MediaWiki's authenticated-CORS mode. MediaWiki rejects a request that has both parameters with HTTP 403. The Action API path is now matched after URL normalisation, so a spelling like `/w/./api.php` also gets `origin=*`. The `WikimediaRequest` docs cover both, and the README now documents `crossorigin` on hand-built requests.
