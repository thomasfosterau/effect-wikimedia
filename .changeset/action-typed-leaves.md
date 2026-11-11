---
"@thomasfosterau/effect-wikimedia": minor
---

Typed leaves for the Action API's siteinfo response schemas (#224).

- `Core.lenient`, `Core.lenientField` and `Core.lenientArray` make a response-schema leaf lenient: a value of the wrong kind is dropped, or left `undefined` in place for an array element, instead of failing the decode.
- `Action.SiteinfoResponse` and `Action.MagicWordsResponse` now use them: namespace ids are `number`, and names, prefixes, magic-word names and aliases are `string`.
- The page metadata `fullurl` is `string`.

The `Type`s of those schemas narrow from `unknown`, so code that builds them by hand must now pass the typed values. That's breaking, hence `minor` on 0.x. Decoding a real response behaves as before.
