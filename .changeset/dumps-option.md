---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** Dumps uses `Option` for absent values (#224).

- **`PageRef`:** `title`, `ns`, `id` and `redirect` are `Option`s.
- **`Contributor`:** `username`, `id` and `ip` are `Option`s.
- **`Revision`:** `parentId`, `timestamp`, `contributor`, `comment`, `model`, `format`, `text` and `sha1` are `Option`s. `Revision.id` is now a plain `number`: a hit always has one.
- **`PageRevisionError.page`:** always set, so now `PageRef` rather than `PageRef | null`.
- **`MultistreamRange.end`:** `Option<number>`, `None` for an open-ended last range.
- **Functions:** `decodeIndexLine` succeeds with `Option` (`None` for a blank line), and `stripFraming` / `decodeEntityLine` return `Option`.
