---
"@thomasfosterau/effect-wikimedia": patch
---

`Rest.getPageMetadata` and `Rest.getRevisionMetadata` now call MediaWiki's metadata-only endpoints, `GET /w/rest.php/v1/page/{title}/bare` and `GET /w/rest.php/v1/revision/{id}/bare`, instead of `/page/{title}` and `/revision/{id}`, which also send the full wikitext the functions discarded. Results are unchanged and responses are much smaller. If you stub these calls by URL, add `/bare` to the paths.
