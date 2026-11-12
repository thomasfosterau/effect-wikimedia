---
"@thomasfosterau/effect-wikimedia": minor
---

Wikitext: `sentences(paragraph, { locale })`, the sentence view over a paragraph (#209, slice 7).

It cuts a `Paragraph`'s plain text with the runtime's `Intl.Segmenter` for the given locale, and gives each sentence trimmed with its offsets in the paragraph's `text`. The view adds no splitting rules of its own, so an abbreviation such as `Mr.` ends a sentence.
