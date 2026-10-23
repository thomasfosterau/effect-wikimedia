---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking (Wikitext):** `Wikitext.EXTENSION_TAGS` is now an Effect `HashSet<string>` (was a native `ReadonlySet<string>`), and `Wikitext.templateParams` returns an Effect `HashMap<string, string>` (was a native `Map<string, string>`). Read them with `HashSet.has(EXTENSION_TAGS, name)` and `HashMap.get(params, key)` (an `Option`) instead of `.has` / `.get`. `Wikitext.getParam` is unchanged. The parser's scans now run on two internal cursor drivers rather than eight hand-written loops; parsing output is unchanged (#174).
