---
"@thomasfosterau/effect-wikimedia": patch
---

`Wikidata` now caps sitelinks, which its `MAX_LIST_ENTRIES` doc comment claimed but the code never did. An item keeps at most `MAX_SITELINKS` (2,000, a new export) sitelinks, and each sitelink keeps at most `MAX_LIST_ENTRIES` (500) badges. As with aliases and statements, the first usable entries in Wikibase's order are kept, and an entry dropped as unusable (a sitelink without a title, a badge that is not an item id) does not count towards the cap. This applies to `getEntities`, `normaliseEntities`, `normaliseItem`, `decodeEntity` and the `Dumps` entity pipeline. Wikibase allows one sitelink per wiki, and Wikimedia has fewer linkable wikis than 2,000, so no real item loses a sitelink; sitelinks get their own cap because a few meta items may link more than 500 wikis. The `MAX_LIST_ENTRIES` doc now lists exactly the lists it caps, and `WikidataItem.sitelinks` and `Sitelink.badges` name their caps.
