# AGENTS.md

Read [README.md](README.md) and [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) first; this file adds only what is specific to agents.

## Process

- You may open pull requests in this repository (GitHub MCP tools or `gh`, whichever is available). GitHub writes go to `thomasfosterau/effect-wikimedia` only.
- When you spot work outside your task, file an issue and move on.
- Write idiomatic Effect (see docs/CONTRIBUTING.md). Non-idiomatic code you find: fix it if trivial, otherwise file an issue naming the sites and the idiomatic replacement.
- Before reporting work as done, run `vp run ci` and say which gates passed and which couldn't run.

## Pitfalls

- **The README is the npm page**: its links must stay absolute (unpkg), and the guides it links (`docs/dumps.md`, `docs/requests.md`, `docs/typescript.md`) are published through `package.json` `files`.
- **No `major` changesets**: 1.0.0 was unpublished and can't be reused (docs/PUBLISHING.md).
- **No live network in tests.** Wikimedia's projects are donation-funded; use the fixtures.
- **`effect-tsgo patch` is version-locked.** `@effect/tsgo`, `@typescript/native` and `vite-plus` move together, or `vp install` fails; read the catalog comments first.
- **`{@link}` must resolve in the published surface** (a name in scope or a barrel path such as `{@link Core.WikimediaRequest}`), or `vp run docgen` fails.
