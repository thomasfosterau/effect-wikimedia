---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** the optional members of the Dumps options objects no longer accept an explicit `undefined` (#224).

`MultistreamRangesOptions.fileSize`, `MultistreamPageRecordsOptions.concurrency`, `FromFileOptions.start` / `end` and `FromHttpRangeOptions.endByte` / `userAgent` are now `?: T`, not `?: T | undefined`. Omit the key instead of passing `undefined`; for a value that may be absent, spread it conditionally (`...(x === undefined ? {} : { start: x })`). Behaviour is otherwise unchanged.
