# AGENTS.md

`CLAUDE.md` is a symlink to this file. This repo publishes `@thomasfosterau/effect-wikimedia`, one package with a single `.` entry point: Effect clients for Wikipedia, Wikidata, Commons, WDQS, wikitext and dumps. It was extracted from `thomasfosterau/website` with `git subtree split`, so `git log` / `git blame` reach back through it; a bare `#NNN` in a comment ported from there names a **website** issue, not one in this tracker (write new ones as `website#NNN`).

Toolchain differences from the other library repos: single package, so the tasks are `vp run test` / `vp run build` (no `-r`, no `test:unit`); the type check runs inside `vp check` (tsgolint), so there is no separate `vp run check`, and the patched native `tsc -p tsconfig.json` is the Effect-diagnostics gate; no fallow gate and no docgen.

## Common pitfalls

- **Module-per-surface is load-bearing.** Each namespace in `src/index.ts` imports only `Core`, with two exceptions: `Dumps` decodes through `Wikidata`'s model, and `Reconciliation` drives `Action` and `Wikidata`. `Wikitext` imports nothing. `tests/tree-shaking.test.ts` bundles each namespace with esbuild and fails on any other cross-surface import; add a new surface to its `SURFACES` table.
- **No subpath exports.** Namespaces on the one barrel give the tree-shaking property without fragmenting the API.
- **No live network in tests.** Use the recorded fixtures in `tests/fixtures/` and stub at `FetchHttpClient.Fetch` or under `Core.wikimediaClientLayer`. Wikimedia's etiquette rules (polite `User-Agent`, `maxlag`) exist because the projects are donation-funded.
- **Node imports stay in `src/dumps/sources.ts`.** The build is `platform: "neutral"` (`vite.config.ts`); everything else must run in a browser or a Worker.
- **Never edit a version in `package.json`.** Edit the strict catalog in `pnpm-workspace.yaml`, run `pnpm install`, and commit `pnpm-lock.yaml` (CI installs with `--frozen-lockfile`). `vite-plus`, `vite` and `vitest` move together; see the catalog comment.

## Conventions

- Relative imports carry their `.ts` extension (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`).
- `exactOptionalPropertyTypes` is on: spell an optional a caller may pass `undefined` for as `?: T | undefined`.
- Tests import from `vite-plus/test`, never `vitest` or `@effect/vitest`.
- Every export has a doc comment whose first sentence says what it is for and stands alone in a hover; state the error channel, units and invariants the signature can't. Put the description before any tag (`@copyright`, `@module`): only text before the first tag shows as the summary.
- Errors are `Schema.TaggedError<Self>()(tag, fields)` classes (the pinned `effect` has no `Schema.TaggedErrorClass`).
- Services are keyed `"effect-wikimedia/<Name>"` (e.g. `"effect-wikimedia/Client"`), not an app-style `"@app/<Name>"` (that slip was #19).

## Commands

- `pnpm install --frozen-lockfile` — install exactly as CI does.
- `vp check` — format (Oxfmt) + lint (Oxlint) + type-check (tsgolint); `--fix` to autofix.
- `tsc -p tsconfig.json` — Effect diagnostics: the native `tsc` that `prepare` patches with `effect-tsgo`. Only `error` fails it; warnings (`ignoreEffectWarningsInTscExitCode`) and suggestions print without affecting the exit code. tsgolint reports none of these.
- `vp run test` — the Vitest suite.
- `vp run build` — `vp pack` (tsdown) into `dist/`.
- `pnpm audit --audit-level high` — the supply-chain gate (network: needs the npm registry).
- `pnpm changeset` — add a changeset.

Use `./node_modules/.bin/vp` if `vp` is not on PATH. Run `tsc` as `./node_modules/.bin/tsc` unless `node_modules/.bin` leads PATH (as CI arranges): a global `tsc` is not the patched one and reports no Effect diagnostics.

## Verification

Before you report work as done, run these in CI's order (`.github/workflows/ci.yml`) and quote each command with its final pass/fail:

1. `vp check`
2. `tsc -p tsconfig.json`
3. `vp run test`
4. `vp run build`
5. `pnpm audit --audit-level high`

Before pushing, start from a clean tree: `rm -rf node_modules dist && pnpm install --frozen-lockfile`. None of the gates needs a credential or Docker. If a gate can't run here (the audit needs the registry), say which and why in the PR body; never imply it ran.

## Branches and pull requests

- Branch off `trunk` as `issue-<n>-<slug>`; PR against `trunk`; squash-merge. Rebase onto `origin/trunk` before opening or updating a PR; never merge `trunk` into your branch (GitHub's Update-branch button merges).
- Every change to the published package's behaviour, including its doc comments (they ship in the `.d.ts`), carries a changeset (`pnpm changeset`); docs-, CI- and tooling-only changes need none. Never publish or version by hand: the Release workflow opens the "Version Packages" PR (`chore: version packages`), the owner merges it, and the workflow publishes. See [docs/RELEASING.md](docs/RELEASING.md).
- Standing approvals: open a PR once a branch has a pushed commit; watch it to merge or close (CI failures, review comments, rebase when it conflicts); keep the PR body current.
- GitHub writes go to `thomasfosterau/effect-wikimedia` only; pass `-R thomasfosterau/effect-wikimedia` whenever the cwd might be another checkout. Use the `gh` CLI for GitHub operations, even when GitHub MCP tools are available. If another repo needs something, say so in the PR body.

## Work tracker

- Issues are the backlog: when you find work you can't do now, file an issue rather than leaving a TODO.
- The issue is the spec — read all of it, including comments; later comments override the body. Re-verify its code claims against current `trunk` before editing.
- Record decisions and findings as issue comments.
- Stop-and-report is a valid outcome: on a blocker outside the issue's scope, comment the evidence on the issue and stop. Scope cut mid-PR becomes a linked issue before merge.

## Effect

- Read the Effect API from the installed package, not from memory: signatures and doc comments in `node_modules/effect/dist/*.d.ts`, implementations in `node_modules/effect/src`.
- The pinned version is the `effect` entry in `pnpm-workspace.yaml`'s catalog; the published peer floor is `catalogs.peers.effect`.
- In the rc line, HTTP modules live under `effect/http` (`HttpApi` under `effect/http-api`); there are no `effect/unstable/*` paths and no `@effect/platform`. `FileSystem` / `Path` are `effect/*` modules.
- The peer floor is a published contract: raising it is a breaking change for consumers and gets its own issue and a major changeset, never a drive-by bump.

## Agent sessions

The SessionStart hook (`.claude/hooks/session-start.sh`) installs dependencies against the lockfile and puts a `vp` shim on PATH for non-interactive shells. It hydrates no secrets; nothing here needs one. A PostToolUse hook runs `vp fmt --write` on each edited file. Publishing (the Release workflow's OIDC exchange) is the only thing that can't run in a session; the audit needs the npm registry.

## Documentation surfaces

`README.md` is the npm-facing API reference; `docs/RELEASING.md` holds the release pipeline and the one-time owner setup; decisions go in issue comments.
