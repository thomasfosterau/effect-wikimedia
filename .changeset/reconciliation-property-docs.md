---
"@thomasfosterau/effect-wikimedia": patch
---

Document every `Reconciliation` property. The error fields now have doc comments: `InvalidQuery.kind` says which input each value names (`"identifier"` also covers an `enrich` argument that isn't a QID), `InvalidQuery.value` is the input as the caller passed it, and `LookupFailed.description` is a log message carrying the underlying `Core` error's description or a sentence naming it. So do the `filename` and `iri` of `normaliseCommonsImage`'s result. No type is hidden from the docs, since `Reconciliation` exposes no raw response schema.
