---
"@thomasfosterau/effect-wikimedia": patch
---

Document every `Action` result property: `WikitextResult`, `PageMetadata`, `SearchResult`, `ParsedSection` and `ParsedPage`. The comments give each field's source in the Action API response, when it is `null`, its units (`PageMetadata.length` is in UTF-8 bytes; `timestamp` and `touched` are ISO 8601 UTC strings, passed through unvalidated) and its form (titles in prefixed display form with spaces; `ParsedPage.categories` in database form, without the `Category:` prefix). `SearchResult.snippet` and `ParsedSection.title` are now documented as HTML that is not sanitised, so a consumer must escape or sanitise them before rendering; the `Action` module comment says so too. `PageMetadata.pageId` notes that an `invalid` or `special` title yields a result with a `null` page ID, not `null`. The `WikitextResult` summary no longer says it can hold a requested (non-current) revision.

The four raw response schemas, `Action.WikitextResponse`, `Action.PageMetadataResponse`, `Action.SearchResponse` and `Action.ParseResponse` (each a schema and its type), are now marked `@hidden`, so the rendered API reference leaves them out. They are still exported, with the same types, from the package and its `.d.ts`. Doc comments only; no runtime or type change.
