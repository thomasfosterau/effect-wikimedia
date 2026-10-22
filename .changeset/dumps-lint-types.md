---
"@thomasfosterau/effect-wikimedia": patch
---

`Dumps.tokenizeXml` names its return type, the new exported `Dumps.XmlTokenization` (same shape). `Dumps.NodeReadableLike.destroy()`, `NodeDuplexLike.write()` and `NodeDuplexLike.end()` are typed as returning `void` rather than `unknown`; every Node stream still fits.
