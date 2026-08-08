# Agent Instructions

## Repository Workflow

This repository is managed by [Vite+](https://viteplus.dev): a single npm package (`@thomasfosterau/effect-wikimedia`) with all tooling configured in `vite.config.ts`.

- `vp install` — install dependencies (delegates to pnpm)
- `vp check` — format (Oxfmt), lint (Oxlint), and type-check (tsgolint); `--fix` to autofix
- `vp run test` — run the Vitest suite in `tests/`
- `vp run build` — build the library with tsdown into `dist/`

Use `./node_modules/.bin/vp` if the global `vp` CLI is not installed.

## Module-per-surface is the load-bearing constraint

Every surface is a namespace re-exported from the single `"."` barrel (`src/index.ts`). Each surface module imports **only** `Core` (and `Wikitext` imports nothing at all), so importing one namespace never pulls another surface's code into a consumer's bundle.

`tests/tree-shaking.test.ts` pins this with real `esbuild` bundles, asserting on span-name string literals unique to each module. **Adding an import between surface modules will fail that test** — which is the point. If you add a new surface, add it to that test's `SURFACES` table too.

`Reconciliation` is the one namespace layered _above_ the raw clients: it drives `Action` and `Wikidata` over `Core`, so those are legitimately in its bundle.

## No subpath exports

The package has exactly one entry point. Don't add subpaths — namespaced barrel re-exports are what give the tree-shaking property above without fragmenting the public API.

## No live network in tests

The suite runs against recorded fixtures in `tests/fixtures/`, with the network stubbed at `FetchHttpClient.Fetch`. Never add a test that hits the real Wikimedia APIs — their etiquette rules (polite `User-Agent`, `maxlag`) exist because the projects are donation-funded.

<!-- effect-solutions:start -->

## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns — check the guide first.

<!-- effect-solutions:end -->

## Effect v4

This package targets **Effect v4 (beta)**: a single `effect` package pinned to a `4.0.0-beta.x` version, as a peer dependency.

- `@effect/platform` does not exist in v4 — HTTP modules live under `effect/unstable/http/*`, and `FileSystem`/`Path` under `effect/*`.
- The v3 → v4 migration maps live in `~/.local/share/effect-solutions/effect/migration/` (start with `v3-to-v4.md`).

## Releasing

Changesets + npm Trusted Publishing (OIDC). Every user-visible change ships with a changeset (`vp run changeset`). See [docs/RELEASING.md](docs/RELEASING.md).

## History

Extracted from `thomasfosterau/website` with `git subtree split`, so the pre-extraction history is intact — `git log` and `git blame` reach back through it. The `Reconciliation` namespace was that repo's separate `packages/wikidata`, folded in here under `src/reconciliation/`.
