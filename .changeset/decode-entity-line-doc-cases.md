---
"@thomasfosterau/effect-wikimedia": patch
---

Docs: the `Dumps.decodeEntityLine` doc comment now lists its `dumps/not-an-entity` cases as examples rather than a complete list, and names the one it left out: an object Wikibase flagged `missing`, which `Wikidata.decodeEntity` rejects even when its id is valid. Behaviour is unchanged.
