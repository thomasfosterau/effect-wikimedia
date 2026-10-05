---
"@thomasfosterau/effect-wikimedia": minor
---

Send `origin=*` on every Action API (`/w/api.php`) request, so a browser page on another origin can read the response. Without an `origin` parameter MediaWiki sends no CORS headers on the Action API. This changes the query string of every `Action`, `Commons`, `Wikidata` and `Reconciliation` request, and makes them anonymous: MediaWiki answers as a logged-out user and ignores session cookies (as an on-wiki gadget would send) and any `Authorization` header added through `HttpClient.mapRequest`. `Rest` and `Sparql` requests are unchanged. An `origin` passed in `Core.WikimediaRequest.params` is sent in place of `*`.
