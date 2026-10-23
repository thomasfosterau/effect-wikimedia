---
"@thomasfosterau/effect-wikimedia": minor
---

`Wikitext.walk` now visits nodes in depth-first pre-order, as its doc comment always said: siblings in source order, and each node's children before its next sibling. It previously visited each fragment's siblings last to first and descended only after the whole fragment (`parse("{{A}} {{C}}")` walked `C` before `A`), and `findTemplates` inherited that order. `findTemplates` now returns templates in document order, the same order as `filter`. A caller that relied on the old reversed order must reverse the result itself.
