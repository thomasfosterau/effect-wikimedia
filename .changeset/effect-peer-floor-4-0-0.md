---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** the `effect` peer dependency now requires `>=4.0.0`, up from `>=4.0.0-rc.118`. The `Wikitext` parser is now written with `@thomasfosterau/effect-parse`, whose own `effect` peer is `^4.0.0`, so an `effect` 4.0.0 prerelease no longer satisfies this package. Upgrade `effect` to 4.0.0 or later.
