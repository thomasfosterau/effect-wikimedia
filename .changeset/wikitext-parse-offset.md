---
"@thomasfosterau/effect-wikimedia": minor
---

`Wikitext.parse(source, { offset })` parses a fragment of a larger text, such as a `<ref>` body taken out of its page (#209, slice 4, step one). Every span, `Document.span` included, is shifted by `offset`, so the spans index the larger text. `Document.source` stays the parsed text. Without the option, nothing changes. An offset that isn't a non-negative safe integer throws a `RangeError`. New type: `ParseOptions`.
