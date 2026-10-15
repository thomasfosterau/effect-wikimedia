---
"@thomasfosterau/effect-wikimedia": patch
---

`Wikidata` now applies `MAX_LIST_ENTRIES` (500) to sitelinks, as its doc comment already said: an item keeps at most 500 sitelinks, and each sitelink keeps at most 500 badges. As with aliases and statements, the first usable entries in Wikibase's order are kept, and an entry dropped as unusable (a sitelink without a title, a badge that is not an item id) does not count towards the cap. This applies to `getEntities`, `normaliseEntities`, `normaliseItem`, `decodeEntity` and the `Dumps` entity pipeline. No real item comes close: Wikidata allows one sitelink per wiki. The `MAX_LIST_ENTRIES`, `WikidataItem.sitelinks` and `Sitelink.badges` docs now list every capped list.
