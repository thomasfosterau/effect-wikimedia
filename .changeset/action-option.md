---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** Action now uses `Option` for absent values (#224).

- `getWikitext`, `getPageMetadata` and `parsePage` succeed with an `Option`, `None` where they succeeded with `null` (a page that doesn't exist upstream). So do their `normaliseWikitext`, `normalisePageMetadata` and `normaliseParse` steps.
- The optional fields of the results are `Option`s, `None` where they were `null`:
  - `WikitextResult`'s `pageId`, `revisionId` and `timestamp`.
  - Every `PageMetadata` field except `title`.
  - `SearchResult`'s `pageId`, `snippet` and `wordCount`.
  - `ParsedSection`'s `level` and `anchor`.
  - `ParsedPage.pageId`.
- The `*Response` wire schemas are unchanged.
