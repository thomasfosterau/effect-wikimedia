---
"@thomasfosterau/effect-wikimedia": patch
---

`Wikitext.parse` is now written with the [`@thomasfosterau/effect-parse`](https://www.npmjs.com/package/@thomasfosterau/effect-parse) parser combinators, in place of a hand-rolled scanner, and the package gains it as a runtime dependency. `parse` returns the same `Document` as before: it is still a plain synchronous function that never throws, and `serialize(parse(s)) === s` still holds. A differential test of the two parsers over the test fixtures and 600,000 generated inputs found no difference in the trees they return.

Two costs come with it. Parsing a typical article takes about twice as long as before (about 4.5 ms against 2 ms for a 90,000-character article). Among the adversarial table inputs the tests time, a cell holding a long run of `{` then `}` now parses about 15 times faster, and one holding `[[{{` runs closed only by `}}` about a third slower. And a bundle that imports `Wikitext` but no other namespace grows from about 41 KB to about 153 KB minified (17 KB to 55 KB gzipped): it now includes effect-parse, with its parser compiler, and the parts of `effect` that effect-parse uses.
