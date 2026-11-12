---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** Wikidata now uses `Option` for absent values (#224).

- `parseItemId`, `parsePropertyId`, `parseLexemeId` and `parseEntityId` return `Option` of the branded id: `None` for anything that is not one.
- `decodeEntity`, `normaliseItem`, `normaliseStatement` and `normaliseSnak` return `Option`: `None` where they returned `null`.
- `normaliseDataValue`'s `datatype` argument is an `Option<string>`.
- Every optional field of the typed model is an `Option`, `None` where it was `null`:
  - `WikidataItem.type`, `Statement.id` and `Reference.hash`.
  - Each snak's `datatype`.
  - `WikibaseEntityIdValue.entityType`.
  - `TimeValue`'s `precision`, `calendarModel`, `timezone`, `before` and `after`.
  - `GlobeCoordinateValue`'s `latitude`, `longitude`, `altitude`, `precision` and `globe`.
  - `QuantityValue`'s `unit`, `upperBound` and `lowerBound`.
  - `MonolingualTextValue.language` and `UnknownValue.type`.
  - `SearchHit`'s `label`, `description`, `matchType` and `matchText`.
- The `Wb*Response` wire schemas are unchanged.
- `Reconciliation`'s stored `DateFact` keeps `null` for an absent `precision` or `calendar`.
