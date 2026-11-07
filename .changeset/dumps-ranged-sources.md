---
"@thomasfosterau/effect-wikimedia": minor
---

Dumps: ranged sources for multistream dumps (#211, slice 2).

- `fromFile` takes `start` / `end` to read one byte range of a file.
- `fromHttpRange` takes `endByte`, so it downloads one range and its resumes stay inside it.
- The new `fromMultistreamRange(path, range, decompressor)` reads one `MultistreamRange` straight from a `pages-articles-multistream.xml.bz2`.

`end` and `endByte` are exclusive, matching `MultistreamRange.end`. An invalid range, and now an invalid `startByte` too, fails the stream with a `SourceError` (`dumps/invalid-byte-range`) before the file is opened or a request is sent.
