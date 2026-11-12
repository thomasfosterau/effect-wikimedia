---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** Wikitext's queries use `Option` for absent values (#224).

- `paramName` returns `Option<string>`: `None` for a positional parameter, where it returned `null`.
- `getParam` returns `Option<string>`: `None` for a missing parameter, where it returned `undefined`.
- `redirectTarget` returns `Option<string>`: `None` when the input is not a redirect, where it returned `null`.
- A `TemplateRenderer`'s `param` callback returns `Option<string>`, so a renderer reads it with `Option.getOrElse(param(1), () => "")` rather than `param(1) ?? ""`.

The AST's own optional fields (`Param.name`, `Tag.rawContent`, …) are unchanged here.
