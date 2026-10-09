---
"@thomasfosterau/effect-wikimedia": minor
---

Send an `Api-User-Agent` header, with the same value as `User-Agent`, on every `Core.WikimediaClient` request, so every `Action`, `Rest`, `Commons`, `Wikidata`, `Sparql` and `Reconciliation` request carries it. Chromium-based browsers silently drop a `User-Agent` set on `fetch`, so until now a browser caller's `Core.UserAgent` never reached Wikimedia. Wikimedia's API etiquette asks browser clients to send `Api-User-Agent` instead, and browsers send it as given.

In a browser this changes CORS behaviour: `Api-User-Agent` isn't a CORS-safelisted header, so cross-origin requests that Chromium sent as simple requests (`Rest` and `Sparql` GETs, and Action API GETs with `origin=*`) now get an `OPTIONS` preflight first. The Action API (with `origin=*`) and the REST API allow the header in their preflight responses, and WDQS's nginx config lists it too, though no live WDQS preflight has been checked. `Dumps.fromHttpRange` is unchanged and sends `User-Agent` only.
