---
"@thomasfosterau/effect-wikimedia": minor
---

`Reconciliation.DateFact` has a `calendar` field: `"gregorian"` when the claim's Wikibase calendar model is proleptic Gregorian (`Q1985727`), `"julian"` when it is proleptic Julian (`Q1985786`), and `null` when the claim has no calendar model or names another one. Read `time` with `calendar`: a Julian date, common before 1582, is not the same day as the Gregorian date with the same digits. `WikidataLookup.enrich` sets it from each date claim's `calendarmodel` and accepts the `http` and `https` entity IRIs.

`DateFact` first ships in this release, so no released version needs migrating. `calendar` is required: code that builds `DateFact` values itself, such as test fixtures, must set it (`null` for an unknown calendar), and a stored `Date` fact without it no longer decodes through `Reconciliation.WikidataFact` or `Reconciliation.DateFact`.
