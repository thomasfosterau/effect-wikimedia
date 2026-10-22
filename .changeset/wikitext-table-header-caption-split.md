---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** `Wikitext.parse` now splits table header and caption lines as MediaWiki does. A header line (`!`) splits on `||` as well as `!!`, so `! a || b` is two header cells (it used to be one cell whose attributes were `a`); a data line still splits on `||` only. A caption line (`|+`) splits on `||` into one `TableCaption` per piece, as MediaWiki emits a `<caption>` per piece. `TableCell` gains `marker` (the `!`, `|`, `!!` or `||` written, which `serialize` now writes back) and `TableCaption` gains `inline` (whether it opened with `||`); code that builds these nodes must set them.
