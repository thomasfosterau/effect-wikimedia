---
"@thomasfosterau/effect-wikimedia": patch
---

Document every `Action` property.

- **Result interfaces.** The properties of `WikitextResult`, `PageMetadata`, `SearchResult`, `ParsedSection` and `ParsedPage` now say where each field comes from in the Action API response and when it is `null`. They also give its units and its form:
  - `PageMetadata.length` is in UTF-8 bytes.
  - `timestamp` and `touched` are ISO 8601 UTC strings, passed through unvalidated.
  - Titles are in prefixed display form, with spaces.
  - `ParsedPage.categories` are in database form, without the `Category:` prefix.
- **HTML fields.** `SearchResult.snippet` and `ParsedSection.title` are documented as HTML that is not sanitised: escape or sanitise them before rendering. The `Action` module comment says so too.
- **`PageMetadata.pageId`** notes that a title the API reports as `invalid` or `special` gets a result with a `null` page ID, not `null`.
- **`WikitextResult`.** Its summary no longer says it can hold a requested (non-current) revision.
- **Raw response schemas.** `WikitextResponse`, `PageMetadataResponse`, `SearchResponse` and `ParseResponse` stay in the docs, because the exported `normalise*` functions take them. Their fields now have short comments, and each schema's comment points to the typed result its normaliser builds.

Doc comments only; no runtime or type change, and nothing is hidden from the docs.
