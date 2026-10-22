---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** `Wikitext.parse` now resolves bold and italic as MediaWiki's `doQuotes` does. A line with an odd number of `'''` runs reinterprets one as a literal apostrophe plus `''` only when its italic count is odd too (`'''''` counts as one of each); `The '''bold` now stays bold. Which `'''` is picked also matches MediaWiki: the line start counts as a longer word rather than a space, and the apostrophe a run of four sheds counts as text before the run. `Formatting.mode` and `Formatting.leadingLiterals` change for such lines; `serialize` output does not.
