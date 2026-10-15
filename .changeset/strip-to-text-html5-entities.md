---
"@thomasfosterau/effect-wikimedia": minor
---

`Wikitext.stripToText` now decodes every HTML5 named entity, as MediaWiki renders it: `&eacute;` becomes "é", `&copy;` becomes "©", `&AMP;` becomes "&", and `&NotEqualTilde;` becomes its two code points, U+2242 U+0338. Before, it decoded only `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&nbsp;`, `&ndash;`, `&mdash;`, `&hellip;`, `&times;` and `&deg;`, and kept every other named entity as written. MediaWiki's two aliases for `&rlm;`, spelt in Hebrew (`&רלמ;`) and in Arabic (`&رلم;`), now decode to U+200F as well. As in MediaWiki, names are case-sensitive and need their `;`, so `&Amp;` and `&eacute` (with no `;`) still stay as written.

`Wikitext.parse` now reads a named entity whose name has non-ASCII characters, such as `&רלמ;`, as one `HtmlEntity` node, as MediaWiki does. Before, it read it as text. `Wikitext.serialize` and the template helpers give the same output as before, and so does `stripToText` for any such name other than the two `&rlm;` aliases above, but code that walks the AST (`walk`, `filter`) now sees the split. For example, French typography puts a no-break space (U+00A0) before `;`, so `AT&T ; Verizon` (with U+00A0 between `T` and `;`) now parses as text, an `HtmlEntity` for `&T ;`, then text.

The entity table adds about 24 KB minified (about 12 KB gzipped) to a bundle that imports `Wikitext`. A bundle that imports only other namespaces does not include it.

The package now also ships `THIRD_PARTY_NOTICES.md`, with the full license texts for the entity table: the HTML Standard's (BSD 3-Clause, as incorporated into source code) and `character-entities`' (MIT).
