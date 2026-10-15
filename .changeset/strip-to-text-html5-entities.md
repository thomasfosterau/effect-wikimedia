---
"@thomasfosterau/effect-wikimedia": minor
---

`Wikitext.stripToText` now decodes every HTML5 named entity, as MediaWiki renders it: `&eacute;` becomes "é", `&copy;` becomes "©", `&AMP;` becomes "&", and `&NotEqualTilde;` becomes its two code points, U+2242 U+0338. Before, it decoded only `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&nbsp;`, `&ndash;`, `&mdash;`, `&hellip;`, `&times;` and `&deg;`, and kept every other named entity as written. MediaWiki's two aliases for `&rlm;`, spelt in Hebrew (`&רלמ;`) and in Arabic (`&رلم;`), now decode to U+200F as well. As in MediaWiki, names are case-sensitive and need their `;`, so `&Amp;` and `&eacute` (with no `;`) still stay as written.

`Wikitext.parse` now reads a named entity whose name has non-ASCII characters, such as `&רלמ;`, as one `HtmlEntity` node, as MediaWiki does. Before, it read it as text. `Wikitext.serialize` still returns the source unchanged.

The entity table adds about 24 KB minified (about 12 KB gzipped) to a bundle that imports `Wikitext`. A bundle that imports only other namespaces does not include it.
