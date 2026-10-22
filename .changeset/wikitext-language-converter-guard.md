---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** a table cell or caption whose opening line has a `-{` (LanguageConverter markup, common on zh, sr and kk wikis) before its first `|` no longer splits at that `|` into attributes and content: as in MediaWiki, `attrs` is `undefined` and the whole text is content, just as for a `[[`. So `| -{ a|b }- || c` now has a first cell with content `-{ a|b }-`, where it used to have `attrs: " -{ a"`.
