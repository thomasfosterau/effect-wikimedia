---
"@thomasfosterau/effect-wikimedia": minor
---

`Action.getPageMetadata` (and `Action.normalisePageMetadata`) now return `null` for a title the Action API reports as `invalid`, such as `Foo<Bar`, and for a `Special:` or `Media:` title. Both used to return a `PageMetadata` with a `null` `pageId` and every other field except `title` `null`, because MediaWiki doesn't flag either entry `missing`. `getWikitext` and `parsePage` already return `null` for these titles. `PageMetadataResponse`'s page entries gain optional `invalid` and `special` fields. The `getPageMetadata` doc comment now states its error channel.
