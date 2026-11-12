---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** `Wikidata.ItemId`, `PropertyId` and `LexemeId` now check their pattern (`Q`, `P` or `L` followed by digits, no leading zero) when decoding, and `.make` throws on anything else, instead of branding any string (#265). The `parse*Id` functions behave as before and are now built on these schemas.
