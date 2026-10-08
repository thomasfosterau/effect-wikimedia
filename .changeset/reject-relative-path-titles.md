---
"@thomasfosterau/effect-wikimedia": patch
---

Reject MediaWiki's relative-path titles (`.`, `..`, a leading `./` or `../`, a `/./` or `/../` anywhere, a trailing `/.` or `/..`) in `Core.normaliseTitle`. `new URL` removed `.` and `..` path segments, so `Rest.getPageMetadata(host, "..")` requested `/w/rest.php/v1/`, `Rest.getParsedHtml(host, ".")` requested `/w/rest.php/v1/page/html`, and `Commons.filePathUrl("..")` built `https://commons.wikimedia.org/wiki/`. `Rest`, `Action` and `Commons.getFileInfo` now fail with `InvalidRequest` before any request is sent; `Commons.filePathUrl` and `Reconciliation.normaliseCommonsImage` return `null`. MediaWiki already rejects these titles, so a valid title is never affected; titles that merely contain dots (`Mr. Smith`, `A.B`, `...`) are still accepted.
