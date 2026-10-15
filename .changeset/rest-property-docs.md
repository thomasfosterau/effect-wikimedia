---
"@thomasfosterau/effect-wikimedia": patch
---

Document every `Rest` property. Each field of `PageMetadata` and `RevisionMetadata`, and of the lenient `PageMetadataResponse` and `RevisionMetadataResponse` schemas, now has a doc comment. Each says what the field holds and when it is `null`: `key` is the title in URL form with underscores and `title` the display form with spaces, timestamps are MediaWiki's ISO 8601 UTC strings passed through unparsed, `size` is in bytes, `pageTitle` is the page's current title (after any move), and `licenseUrl` is the wiki's site-wide content license rather than one specific to the page or revision. No type is hidden from the docs: the two response schemas are the parameter types of the exported `normalisePageMetadata` and `normaliseRevisionMetadata`, so a consumer can type against them. Nothing else changes; the comments on the schema fields also appear in the built JavaScript.
