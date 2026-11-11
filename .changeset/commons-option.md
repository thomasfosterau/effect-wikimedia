---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** Commons now uses `Option` for absent values (#224).

- `Commons.filePathUrl` returns `Option<string>`, `None` for unusable input.
- `Commons.getFileInfo` succeeds with `Option<FileInfo>`, `None` when the file doesn't exist.
- `FileInfo`'s `url`, `descriptionUrl`, `width`, `height`, `mime` and `size` are `Option`s.
