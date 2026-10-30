---
"@thomasfosterau/effect-wikimedia": patch
---

`Wikitext.stripToText` keeps a colon link (`[[:Category:Foo]]`, `[[:File:Bar.jpg]]`) as the visible text MediaWiki renders, `Category:Foo`, where it used to return `""`. `StripToTextOptions` gains `hiddenLinkPrefixes`, which adds a wiki's localised File and Category namespace names and aliases (`Datei`, `Bild`, `Kategorie`) and its interlanguage prefixes (`fr`, `de`) to the canonical `File` / `Image` / `Category` set, so those links strip to nothing too, including in text a template renderer strips through `TemplateRenderContext.strip`. The new `Action.getHiddenLinkPrefixes(host)` fetches that set from the wiki's siteinfo (`SiteinfoResponse`, `normaliseHiddenLinkPrefixes` and `MAX_HIDDEN_LINK_PREFIXES` come with it).
