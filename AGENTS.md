# Agent Instructions

Project conventions live here; personal style preferences live in user memory. `CLAUDE.md` is a symlink to this file.

## Repository Workflow

This repository is managed by [Vite+](https://viteplus.dev): a single npm package (`@thomasfosterau/effect-wikimedia`) with all tooling configured in `vite.config.ts`. The toolchain shape (pnpm + Vite+, a strict dependency catalog, SHA-pinned actions, OIDC release) is the shared library standard copied from `thomasfosterau/effect-drizzle-ext` and `thomasfosterau/effect-jsonapi`.

- `pnpm install --frozen-lockfile` — install dependencies exactly as CI does (`vp install --frozen-lockfile` is the same thing through Vite+)
- `vp check` — format (Oxfmt), lint (Oxlint), and type-check (tsgolint); `--fix` to autofix
- `vp run test` — run the Vitest suite in `tests/`
- `vp run build` — build the library with tsdown into `dist/`
- `pnpm audit --audit-level high` — the supply-chain gate CI runs last

Use `./node_modules/.bin/vp` if the global `vp` CLI is not installed. The Claude Code session-start hook (`.claude/hooks/session-start.sh`) installs dependencies and puts a `vp` shim on PATH, so a fresh session can run every gate without manual setup.

CI (`.github/workflows/ci.yml`) is one job: `vp check` → `vp run test` → `vp run build` → `pnpm audit`. Every action is pinned to a commit SHA; Dependabot (`.github/dependabot.yml`) bumps them weekly.

## Dependencies live in the catalog

`pnpm-workspace.yaml` is a **strict catalog** (`catalogMode: strict`): every external version is declared there once, and `package.json` references only `catalog:` (dev) and `catalog:peers` (the published `effect` peer range). `pnpm add` and `pnpm install` reject anything else. After editing the catalog, run `pnpm install` and commit the regenerated `pnpm-lock.yaml` — CI installs with `--frozen-lockfile`, so a stale lockfile fails immediately.

`vite-plus`, `vite` (an alias of `@voidzero-dev/vite-plus-core`) and `vitest` are pinned exact and move together: vite-plus pins vitest to an exact version and the `vitest: "catalog:"` override forces every resolution onto the catalog singleton.

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

This package targets **Effect v4 (beta)**: a single `effect` package pinned in the catalog to a `4.0.0-beta.x` version, as a peer dependency.

- `@effect/platform` does not exist in v4 — HTTP modules live under `effect/unstable/http/*`, and `FileSystem`/`Path` under `effect/*`.
- The v3 → v4 migration maps live in `~/.local/share/effect-solutions/effect/migration/` (start with `v3-to-v4.md`).
- The peer floor (`catalogs.peers.effect`) is a published contract: raising it is a breaking change for consumers and gets its own issue and changeset, never a drive-by bump.

## Work tracker

- **Active work** lives in GitHub Issues for `thomasfosterau/effect-wikimedia`. Longer-running tech debt is an issue too; there is no in-repo backlog file and a code comment is not a tracker.
- **Decisions and findings** are recorded as comments on the issue they were found working; later comments override the body.

## Working a dispatched issue

- The issue is the spec: read all of it, including comments.
- Re-verify the code claims against current `main` before editing.
- Stop-and-report is a valid outcome: on a blocker outside the issue's scope, comment the evidence on the issue and stop.
- No silent deferrals: scope cut mid-PR becomes a linked issue before merge.

## Branch model and PR management

`main` plus short-lived feature branches, PR against `main`. These are standing instructions and approvals; they override any default "don't open a PR unless asked" behaviour.

- **Always open a PR** for branch work, against `main`, once a commit is pushed.
- **Always watch the PR to merge or close**: investigate CI failures and review comments as they arrive; rebase promptly when the PR goes conflicting.
- **Always keep the PR body current** as the implementation diverges from it.
- **GitHub writes are scoped to `thomasfosterau/effect-wikimedia` only.** Never write to another repository without the owner's explicit approval for that action in the current session; if another repo needs something, say so in the PR body.

## Verification

- Claims of verification name the command and its final status.
- The pre-push parity run is: `rm -rf node_modules && pnpm install --frozen-lockfile`, then `vp check`, `vp run test`, `vp run build`, `pnpm audit --audit-level high`.

## Releasing

Changesets + npm Trusted Publishing (OIDC) through a protected `release` environment; never publish by hand. Every user-visible change ships with a changeset (`vp run changeset`); tooling-only changes need none. The owner merges the "Version Packages" PR. See [docs/RELEASING.md](docs/RELEASING.md).

## History

Extracted from `thomasfosterau/website` with `git subtree split`, so the pre-extraction history is intact — `git log` and `git blame` reach back through it. The `Reconciliation` namespace was that repo's separate `packages/wikidata`, folded in here under `src/reconciliation/`.
