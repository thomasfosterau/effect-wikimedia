---
"@thomasfosterau/effect-wikimedia": patch
---

Brand the package's tagged error classes (`InvalidRequest`, `RequestFailed`, `RateLimited`, `InvalidQuery`, `LookupFailed`, `MultistreamIndexError`, `MultistreamRangeFailed`, `SourceError`) with a `{ readonly brand: unique symbol }` second type argument, so TypeScript no longer treats structurally identical errors as interchangeable. Patch, not minor: the runtime shape and constructors are unchanged, and only code that relied on assigning a structurally compatible plain object to one of these error types stops compiling.
