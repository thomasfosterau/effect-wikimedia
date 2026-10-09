---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** `Reconciliation.MAX_TEXT_FIELD_LENGTH` is renamed `Reconciliation.MAX_CANDIDATE_TEXT_LENGTH`, and `Reconciliation.sanitiseText` is renamed `Reconciliation.sanitiseCandidateText`, so they no longer share names with `Core.MAX_TEXT_FIELD_LENGTH` and `Core.sanitiseText`. Their behaviour is unchanged: the candidate bound is still 2000 code units, against Core's 4000, and the candidate sanitiser still collapses internal whitespace, which Core's does not (it only trims). The old names are removed with no deprecated aliases, so update any imports that use them.
