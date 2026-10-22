---
"@thomasfosterau/effect-wikimedia": patch
---

`Wikitext.parse` no longer takes quadratic time on a page of unclosed openers: an unclosed `<!--` or extension tag (such as `<ref>`) in every table cell, a run of unclosed `<ref>` lines, or a run of `{|`, `{{` or `[[` lines with no `|}`, `}}` or `]]` after them. Each close search is remembered for the rest of the parse, and a table, template, argument or wikilink with no possible close fails at once. A 40,000-character page of `{|` and `{{` lines that took seconds now parses in milliseconds. The parse result is unchanged.
