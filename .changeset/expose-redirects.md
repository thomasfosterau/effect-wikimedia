---
"@thomasfosterau/effect-wikimedia": minor
---

Redirects are now visible in `Dumps` and `Wikitext` (#207). `Dumps.PageRef` has a new `redirect: string | null` field: the entity-decoded `title` of the page's `<redirect title="…" />`, or `null` for a page that isn't a redirect. `Dumps.skipRedirects` drops the records of redirect pages from a record stream, before or after `Dumps.onlyRevisions`. An open `Dumps.XmlToken` now carries its raw `attributes` text when the tag has any. `Wikitext.redirectTarget(document, { aliases })` returns the target of a `#REDIRECT [[Target]]` page by MediaWiki's rule (the magic word first, after only whitespace, case-insensitive, an optional `:`, then the link), or `null` for any other page; `aliases` adds a wiki's localised spellings such as `#WEITERLEITUNG`. Code that builds a `Dumps.PageRef` by hand must now set `redirect`.
