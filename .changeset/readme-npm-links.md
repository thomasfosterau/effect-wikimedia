---
"@thomasfosterau/effect-wikimedia": patch
---

The README no longer has links that 404 on the npm page. Its Development section names `AGENTS.md` and `docs/RELEASING.md` as files in the source repository instead of linking them (npm resolves relative links against the private repository, and neither file ships in the package), and its License section points at the `LICENSE` file shipped in the package.
