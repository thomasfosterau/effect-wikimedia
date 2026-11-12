---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** the Wikitext options objects drop `| undefined` from their optional members (#224).

`ParseOptions.offset`, `CitationsOptions.names`, `InfoboxesOptions.names`, `RedirectTargetOptions.aliases` and `StripToTextOptions.templates`, `.templateFallback` and `.hiddenLinkPrefixes` are now `?: T`, not `?: T | undefined`: omit a member rather than pass `undefined` for it.
