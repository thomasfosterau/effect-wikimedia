---
"@thomasfosterau/effect-wikimedia": patch
---

`Core.normaliseWikimediaHost` now accepts the Wikimedia sister projects, so every surface can address them instead of failing with `InvalidRequest`: any language edition of Wiktionary, Wikivoyage, Wikisource, Wikiquote, Wikibooks, Wikinews and Wikiversity (`en.wiktionary.org`, …), plus `mediawiki.org` / `www.mediawiki.org`, `wikifunctions.org` / `www.wikifunctions.org` and multilingual Wikisource (`wikisource.org`). The list stays closed to Wikimedia-owned domains; third-party wikis are still rejected.
