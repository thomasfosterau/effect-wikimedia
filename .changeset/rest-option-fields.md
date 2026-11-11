---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** every absent value in `Rest.PageMetadata` and `Rest.RevisionMetadata` is now an `Option` instead of `null` (#224). In `PageMetadata` that's `pageId`, `key`, `contentModel`, `latestRevisionId`, `latestTimestamp` and `licenseUrl`. In `RevisionMetadata` it's `pageId`, `pageTitle`, `size`, `minor`, `timestamp`, `contentModel` and `licenseUrl`. Read them with `Option.getOrNull`, or `Option.match` for the `None` case. This is the first surface of the package-wide move to `Option`.
