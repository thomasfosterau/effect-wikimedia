---
"@thomasfosterau/effect-wikimedia": patch
---

`Dumps.pageRecords` and `Dumps.incrementalRecords` now read a multi-slot revision's `model`, `format` and `text` from its main slot. Export schema 0.11 puts every other slot (such as Commons' `mediainfo`) in a `<content>` element, whose fields used to overwrite the main slot's; they are now skipped, and their text no longer counts towards the field cap. The cap's error `detail` now names its unit, `"revision field exceeds the 16777216-code-unit cap"` (it was `"…-byte cap"`): the cap counts UTF-16 code units of the still-escaped text, not bytes.
