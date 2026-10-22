---
"@thomasfosterau/effect-wikimedia": patch
---

`Action.parsePage` now requests `prop=tocdata|links|categories|templates` and reads its section outline from `parse.tocdata.sections`. MediaWiki 1.46 deprecated `prop=sections` (T319141), so every call drew a deprecation warning, and `ParsedPage.sections` would have gone empty once `sections` is removed. `ParsedPage` is unchanged. If you stub `action=parse` by URL or body, send `tocdata` (Parsoid's `SectionMetadata` JSON: `hLevel`, `line`, `anchor`, …) instead of `sections`.
