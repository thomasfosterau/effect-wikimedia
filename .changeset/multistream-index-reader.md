---
"@thomasfosterau/effect-wikimedia": minor
---

Add a reader for the `pages-articles-multistream` index (part of #211). It is runtime-agnostic, and both of its stages are strict: a corrupt index fails the stream with a typed `Dumps.MultistreamIndexError` rather than emitting per-line error elements.

- `Dumps.multistreamIndexRecords` decodes the index's `offset:pageId:title` lines into typed entries. A malformed line fails the stream with reason `dumps/malformed-index-line`.
- `Dumps.multistreamRanges({ fileSize? })` groups the entries into the dump's per-stream byte ranges `[start, end)`. Each range can be decompressed on its own and decoded through `Dumps.pageRecords`.
  - With `fileSize`, the last range ends at the file size. Without it, the last range's `end` is `null`.
  - An offset that goes backwards fails the stream with reason `dumps/index-offset-decreased`.
  - An offset at or past `fileSize` fails the stream with reason `dumps/index-offset-past-file-size`.
- `Dumps.decodeIndexLine` decodes a single line to a `Result`.
