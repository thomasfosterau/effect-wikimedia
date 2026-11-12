---
"@thomasfosterau/effect-wikimedia": patch
---

Accept `@thomasfosterau/effect-parse` 0.6 as well as 0.5 (`^0.5.0 || ^0.6.0`), so an app already on either version dedupes to one copy. The parser uses none of 0.6's breaking changes, and the suite passes against both versions.
