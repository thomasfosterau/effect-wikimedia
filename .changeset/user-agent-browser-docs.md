---
"@thomasfosterau/effect-wikimedia": patch
---

Correct the `User-Agent` docs for browsers. `Core.UserAgent` and the README said the value is "sent verbatim" on every request. That holds in Node, but Chromium-based browsers silently drop a `User-Agent` set on `fetch` and send their own, so Wikimedia never sees the configured value. The docs now say so, and point to the `Api-User-Agent` header Wikimedia asks browser clients to send instead, which this package doesn't send yet. Behaviour is unchanged.
