---
"@thomasfosterau/effect-wikimedia": minor
---

Dumps: random access, iteration and resume over multistream dumps (#211, slice 3).

- `findMultistreamRange(match, options?)` scans an index entry stream for the whole `MultistreamRange` holding a page. Use it with `byTitle(title)` or `byPageId(id)`.
- `multistreamPageRecords(open, { concurrency? })` decodes each range's pages through a caller-supplied byte opener, so it stays platform-neutral.
- `fromCheckpoint(offset)` resumes a range stream at a recorded offset.
