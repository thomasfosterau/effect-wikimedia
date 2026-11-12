---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** the optional members of the Dumps options objects no longer accept an explicit `undefined` (#224).

`MultistreamRangesOptions.fileSize`, `MultistreamPageRecordsOptions.concurrency`, `FromFileOptions.start` / `end` and `FromHttpRangeOptions.endByte` / `userAgent` are now `?: T`, not `?: T | undefined`. Omit the key instead of passing `undefined`. For a value that may be absent, pass `x === undefined ? {} : { start: x }` rather than `{ start: x }`. Behaviour is otherwise unchanged.
