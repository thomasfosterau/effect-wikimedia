---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** Core's validators and parsers (`normaliseWikimediaHost`, `normaliseTitle`, `sanitiseText`, `toNonNegativeInt`, `parseRetryAfterHeader`, `detectMaxlagSignal`) return `Option` instead of `T | null`, and `WikimediaRequest.maxlagSeconds` takes `Option.none()` rather than `null` to omit `maxlag`. `Reconciliation.itemToCandidate` takes a `WikidataItem` and returns one candidate (#224). MIGRATION.md has the details.
