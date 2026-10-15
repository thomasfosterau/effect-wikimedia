---
"@thomasfosterau/effect-wikimedia": patch
---

`Dumps.decodeEntityLine` (and so `Dumps.entityRecords`) now reports a dump line whose body is the JSON literal `null` (`null,`) as `dumps/not-an-entity`, like any other valid JSON that is not an entity object (`42`, `"x"`, `[]`). Before, it reported `dumps/invalid-json`, because the internal parse step returned `null` both for a parse failure and for a body that parsed to `null`. A line that is not valid JSON is still `dumps/invalid-json`, and every other line decodes as before.
