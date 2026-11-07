---
"@thomasfosterau/effect-wikimedia": patch
---

Add `Action.getRedirectAliases(host, retry?)` (#220). It fetches a wiki's spellings of the redirect magic word (such as `#WEITERLEITUNG` on the German Wikipedia) from `meta=siteinfo&siprop=magicwords`, ready to pass to `Wikitext.redirectTarget`'s `aliases`. Also adds `MagicWordsResponse`, `normaliseRedirectAliases` and `MAX_REDIRECT_ALIASES`.
