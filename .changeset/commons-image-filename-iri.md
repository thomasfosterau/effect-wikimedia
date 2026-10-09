---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** `Reconciliation.normaliseCommonsImage` now returns `{ filename, iri }`, the same field names as `Reconciliation.ImageFact`, instead of `{ externalId, externalIri }`. The values are unchanged and no alias is kept for the old names.

To migrate, rename the fields you read from the result: `externalId` → `filename` and `externalIri` → `iri`.
