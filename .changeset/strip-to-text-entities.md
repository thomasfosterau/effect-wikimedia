---
"@thomasfosterau/effect-wikimedia": patch
---

`Wikitext.stripToText` no longer replaces `&constructor;`, `&toString;`, `&valueOf;` or `&hasOwnProperty;` with the source of a built-in function, such as `function Object() { [native code] }`. Like any other unknown named entity, each is now kept as written.

A numeric character reference that MediaWiki renders as literal text now also stays as written, so the result shows what a reader sees. This covers NUL, the C0 and C1 control characters other than tab and newline, carriage return, a surrogate, U+FFFE and U+FFFF. Before, `stripToText` decoded these references. A lone surrogate made the result malformed UTF-16, so `encodeURIComponent` threw `URIError`, and two surrogate references such as `&#55357;&#56832;` were joined into one character. A reference past U+10FFFF already stayed as written. A hand-built `HtmlEntity` whose `raw` is not a whole decimal or hex reference, such as `&#12.5;`, now stays as written instead of decoding the leading digits.
