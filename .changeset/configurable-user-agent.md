---
"@thomasfosterau/effect-wikimedia": minor
---

Make the `User-Agent` configurable, with a neutral default. The new `Core.UserAgent` reference sets the header every `Core.WikimediaClient` request and every `Dumps.fromHttpRange` request sends, and `Dumps.FromHttpRangeOptions` gains a `userAgent` option that overrides it for one download. `Core.USER_AGENT`, the default, changes from `effect-wikimedia/0.0.0 (+https://github.com/thomasfosterau/website; mailto:me@thomasfoster.au)` to `effect-wikimedia (+https://github.com/thomasfosterau/effect-wikimedia)`: it names this package, not the package author, and drops the stale version. Wikimedia's User-Agent policy asks each caller to identify itself, so set your own, with your contact details: `Core.wikimediaLayer.pipe(Layer.provideMerge(Layer.succeed(Core.UserAgent, "my-bot/1.2 (bot@example.org)")))`.
