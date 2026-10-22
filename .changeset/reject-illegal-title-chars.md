---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** `Core.normaliseTitle` and `Core.requireTitle` now reject a title containing `<`, `>`, `[`, `]`, `{` or `}`, which MediaWiki's default `$wgLegalTitleChars` never allows. Every title-taking function (`Action.getWikitext`, `Action.getPageMetadata`, `Action.parsePage`, `Rest.getPageMetadata`, `Rest.getParsedHtml`, `Commons.getFileInfo`) fails with `InvalidRequest` before sending a request, where the Action readers used to return `null` after one and the Rest readers failed with `RequestFailed`; `Commons.filePathUrl` returns `null`.
