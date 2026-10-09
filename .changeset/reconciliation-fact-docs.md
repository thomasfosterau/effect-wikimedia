---
"@thomasfosterau/effect-wikimedia": patch
---

Clarify two `Reconciliation` fact docs. `DateFact.time` now says to read it with `calendar` as well as `precision`: a Julian `time` is not the Gregorian day with the same digits. `ImageFact.filename` no longer says the `File:` prefix is removed: it is the filename as the claim spells it, which has no prefix because Wikibase `commonsMedia` values carry none, and `normaliseCommonsImage` doesn't strip one. `WikidataLookup.enrich` now builds each `Image` fact from `normaliseCommonsImage`'s `filename` and `iri` by name instead of spreading its result, so a field the helper gains can't reach an `Image` fact. The facts `enrich` returns are unchanged.
