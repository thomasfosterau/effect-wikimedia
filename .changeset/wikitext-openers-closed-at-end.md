---
"@thomasfosterau/effect-wikimedia": patch
---

`Wikitext.parse` now takes linear time on a page of `{|`, `{{`, `{{{` or `[[` openers that close only at the very end of the page (#179). Each such opener used to make every enclosing one, up to the nesting limit, walk the rest of the page again before failing, so a 32 kB edit of that shape took seconds to parse. The parser now remembers a fragment that ran to the end of its region without meeting its closing delimiter, a template or wikilink tail that failed, what a construct at the nesting limit parsed to, and where each nested table a table steps over ends, and it no longer parses the cells of a table that cannot close. The tree it builds is unchanged.
