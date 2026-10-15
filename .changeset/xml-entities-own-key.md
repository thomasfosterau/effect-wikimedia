---
"@thomasfosterau/effect-wikimedia": patch
---

`Dumps.decodeXmlEntities` no longer replaces `&constructor;`, `&toString;`, `&valueOf;` or `&hasOwnProperty;` with the source of a built-in function, such as `function Object() { [native code] }`. Like any other name outside XML's five predefined entities, each is now kept as written. `Dumps.pageRecords` and `Dumps.incrementalRecords` decode every captured field through it, so this also applies to their records.

A character reference to a code point that XML 1.0 forbids now also stays as written, so a decoded reference never makes the result malformed UTF-16. This covers NUL, the C0 control characters other than tab, line feed and carriage return, a surrogate, U+FFFE and U+FFFF. Before, these references were decoded: a lone surrogate such as `&#xD800;` made the result malformed UTF-16, and two surrogate references such as `&#55357;&#56832;` were joined into one character. A reference past U+10FFFF already stayed as written. A reference that is not a whole decimal or hex number, such as `&#65a;`, now stays as written instead of decoding its leading digits (it was "A").
