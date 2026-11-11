---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** Reconciliation uses `Option` for absent values (#224).

- `WikidataCandidate.label` and `description` are `Option`s.
- `normaliseLabelQuery`, `normaliseQid`, `normalisePropertyId`, `normaliseExternalIdValue`, `sanitiseCandidateText`, `normaliseTimeValue` and `normaliseCommonsImage` return `Option`.
- Each `ExternalIdAuthority.iri` returns an `Option`.
- `WikidataLookup.enrich` succeeds with `Option<WikidataFacts>`, `None` when the item doesn't exist.
