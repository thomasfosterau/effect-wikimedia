---
"@thomasfosterau/effect-wikimedia": patch
---

`Wikidata.decodeEntity` no longer throws on an entity whose nested containers are the wrong kind (a `null` statement, mainsnak, reference, sitelink or alias list, a statement list or badges that are a number, and so on). It keeps a best-effort item, dropping the unusable entries, so one such line in a dump is no longer a defect that ends a `Dumps.entityRecords` stream. A `__proto__` key in labels, descriptions, aliases or sitelinks is now dropped instead of replacing the map's prototype (and no longer counts towards `MAX_SITELINKS`), and `Dumps.hasSitelink` counts only an item's own sitelinks, so `hasSitelink(item, "toString")` is `false`.
