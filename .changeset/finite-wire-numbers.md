---
"@thomasfosterau/effect-wikimedia": patch
---

Wire schemas decode ids, sizes and counts with `Schema.Int` (and heading levels with `Schema.Finite`), so a fractional, NaN or infinite value now degrades to absent instead of decoding (#224).
