# AGENTS.md

`CLAUDE.md` is a symlink to this file. This repo publishes `@thomasfosterau/effect-wikimedia`, one package with a single `.` entry point: Effect clients for Wikipedia, Wikidata, Commons, WDQS, wikitext and dumps. It was extracted from `thomasfosterau/website` with `git subtree split`, so `git log` / `git blame` reach back through it; a bare `#NNN` in a comment ported from there names a **website** issue, not one in this tracker (write new ones as `website#NNN`).

Toolchain differences from the other library repos: single package, so the tasks keep the other repos' names (`check`, `test:unit`, `build`) but run without `-r` (`vp run check`, not `vp run -r check`). The docs gate is TypeDoc (`vp run docgen`), not `@effect/docgen`: TypeDoc checks that `{@link}`s resolve, and `@effect/docgen` does not. `vp check` and `vp run check` are different commands: `vp check` is Vite+'s built-in format + lint + type-check (tsgolint), and `vp run check` is this repo's `check` task in `vite.config.ts`, the patched native `tsc -p tsconfig.json` that reports Effect diagnostics.

## Common pitfalls

- **Module-per-surface is load-bearing.** Each namespace in `src/index.ts` imports only `Core`, with two exceptions: `Dumps` decodes through `Wikidata`'s model, and `Reconciliation` drives `Action` and `Wikidata`. `Wikitext` imports nothing. `tests/tree-shaking.test.ts` bundles each namespace with esbuild and fails on any other cross-surface import; add a new surface to its `SURFACES` table.
- **No subpath exports.** Namespaces on the one barrel give the tree-shaking property without fragmenting the API.
- **No live network in tests.** Use the recorded fixtures in `tests/fixtures/` and stub at `FetchHttpClient.Fetch` or under `Core.wikimediaClientLayer`. Wikimedia's etiquette rules (polite `User-Agent`, `maxlag`) exist because the projects are donation-funded.
- **Node imports stay in `src/dumps/sources.ts`.** The build is `platform: "neutral"` (`vite.config.ts`); everything else must run in a browser or a Worker.
- **Never edit a version in `package.json`.** Edit the strict catalog in `pnpm-workspace.yaml`, run `pnpm install`, and commit `pnpm-lock.yaml` (CI installs with `--frozen-lockfile`). `vite-plus`, `vite`, `vitest` and `@vitest/coverage-istanbul` move together; see the catalog comment.

## Conventions

- Relative imports carry their `.ts` extension (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`).
- `exactOptionalPropertyTypes` is on: spell an optional a caller may pass `undefined` for as `?: T | undefined`.
- Tests import from `vite-plus/test`, never `vitest` or `@effect/vitest`.
- Every export has a doc comment whose first sentence says what it is for and stands alone in a hover; state the error channel, units and invariants the signature can't. Put the description before any tag (`@copyright`, `@module`): only text before the first tag shows as the summary.
- A `{@link}` must resolve within the published surface, or `vp run docgen` fails: link a name in scope (`{@link WikimediaRequest}`) or a barrel path (`{@link Core.WikimediaRequest}`, `{@link Core}`), never a module path (`{@link "./core"}`) or a helper the barrel doesn't export (write that as a code span). A namespace's module comment ends in a bare `@module`, so the docs name it as the barrel does (`Core`, not `core`).
- Errors are `Schema.TaggedError<Self>()(tag, fields)` classes (the pinned `effect` has no `Schema.TaggedErrorClass`).
- Services are keyed `"effect-wikimedia/<Name>"` (e.g. `"effect-wikimedia/Client"`), not an app-style `"@app/<Name>"` (that slip was #19).

## Commands

- `pnpm install --frozen-lockfile` — install exactly as CI does.
- `vp check` — format (Oxfmt) + lint (Oxlint) + type-check (tsgolint); `--fix` to autofix. A Vite+ built-in, not the `check` task below.
- `vp run check` — the TS 7 type check plus Effect diagnostics: runs `tsc -p tsconfig.json` with the native `tsc` that `prepare` patches with `effect-tsgo`. Only `error` fails it; warnings (`ignoreEffectWarningsInTscExitCode`) and suggestions print without affecting the exit code. tsgolint reports none of these. Cached; a change to anything it reads (`src/`, `tests/`, `vite.config.ts`, `tsconfig.json`, `node_modules`, the patched binary included) reruns it.
- `vp run fallow` — the dead-code and duplication gate, fallow's static analyses. `fallow dead-code` fails on an unused file, export, type, devDependency or catalog entry, a duplicate export, an unresolved import or a circular dependency. `.fallowrc.json` adds the entry points fallow's plugins can't see (`tests/dist-consumer/`, the TypeDoc plugin in `scripts/`) and holds the documented exemptions; everything reachable from `src/index.ts` is the published surface and counts as used. Delete what it reports as dead; exempt something in `.fallowrc.json` only with a comment saying why it is live (or, for a duplicate export, why the duplication is intended). A devDependency used only as a bin from a `vite.config.ts` task needs an `ignoreDependencies` entry, because fallow reads commands from package.json `scripts`, not from `run.tasks`. `fallow dupes --fail-on-issues` then fails on any clone group (5+ lines, 50+ tokens; test files are skipped) not listed in `duplicates.ignoredClones`. Each entry is the content fingerprint and instance count of a clone that predates the gate (#102): moving the code keeps it ignored, while editing a copy or adding another makes it a new group that fails. Extract a shared helper rather than add an entry. After removing a listed clone, delete its entry. Needs no build.
- `vp run test:unit` — the Vitest suite, with Istanbul coverage: it writes `coverage/coverage-final.json` (gitignored), which `fallow:health` reads.
- `vp run fallow:health` — the complexity ratchet (#102): `fallow health` fails on a function over a cyclomatic, cognitive or CRAP ceiling. CRAP (`CC² × (1 − coverage)³ + CC`) uses the coverage `test:unit` writes, so the task depends on `test:unit` (a cache hit when the tests just ran). A missing coverage file is an error (exit 2), not a fallback to fallow's estimate. Every function is held to fallow's defaults (cyclomatic 20, cognitive 15, CRAP 30); the functions already over one when the gate landed are pinned at their measured value by `health.thresholdOverrides` in `.fallowrc.json`, one entry per function, raising only the limit it breaches. So no pinned function may get worse and no new one may join them. Bring a new over-limit function under the defaults (split it, or test it to lower its CRAP); don't add an override. After a refactor or new tests lower a pinned function, lower its ceiling to the value `fallow:health` now prints under "Health threshold overrides" (CRAP fails _at_ its ceiling, so set a CRAP ceiling 0.1 above the score), or delete the entry once the function is within the defaults. Renaming or moving a pinned function to another file drops its pin, so move the entry with it.
- `vp run build` — `vp pack` (tsdown) into `dist/`.
- `vp run check:dist` — the dist-consumer declaration check: builds, then type-checks `tests/dist-consumer/` against the emitted `dist/*.d.ts` (`skipLibCheck: false`, `nodenext`) with both TS 7 (`tsc`) and TS 6 (`tsc6`). A change to a public type the fixture pins means updating the fixture alongside the changeset.
- `vp run docgen` — the docs gate: TypeDoc renders the API reference from the doc comments reachable from `src/index.ts` into the gitignored `api-docs/`, and fails on an undocumented export or method or a `{@link}` that resolves to nothing in the published surface (`typedoc.json`; `tsdoc.json` registers `@copyright`). Needs no build. Properties aren't required yet (#79).
- `pnpm audit --audit-level high` — the supply-chain gate (network: needs the npm registry).
- `pnpm changeset` — add a changeset.

Use `./node_modules/.bin/vp` if `vp` is not on PATH. `vp run` puts this package's `node_modules/.bin` first on PATH, so its tasks always get the patched `tsc`. Run a bare `tsc` yourself only as `./node_modules/.bin/tsc`: a global `tsc` is not the patched one and reports no Effect diagnostics.

## Verification

Before you report work as done, run these in CI's order (`.github/workflows/ci.yml`) and quote each command with its final pass/fail:

1. `vp check`
2. `vp run check`
3. `vp run fallow`
4. `vp run test:unit`
5. `vp run fallow:health`
6. `vp run build`
7. `vp run check:dist`
8. `vp run docgen`
9. `pnpm audit --audit-level high`

Before pushing, start from a clean tree: `rm -rf node_modules dist && pnpm install --frozen-lockfile`. None of the gates needs a credential or Docker. If a gate can't run here (the audit needs the registry), say which and why in the PR body; never imply it ran.

## Branches and pull requests

- Branch off `trunk` as `issue-<n>-<slug>`; PR against `trunk`. Squash-merge is preferred and a merge commit is acceptable; either way, rebase onto `origin/trunk` before opening or updating a PR, and never merge `trunk` into your branch (GitHub's Update-branch button merges).
- Every change to the published package's behaviour, including its doc comments (they ship in the `.d.ts`), carries a changeset (`pnpm changeset`); docs-, CI- and tooling-only changes need none. Never publish or version by hand (the one exception is the owner's one-off 2.0.0 bump; see [docs/RELEASING.md](docs/RELEASING.md#versioning)): the Release workflow opens the "Version Packages" PR (`chore: version packages`), the owner merges it, and the workflow publishes. See [docs/RELEASING.md](docs/RELEASING.md).
- The package stays on 0.x: a breaking change takes a `minor` changeset, and `major` is never used while on 0.x. 1.0.0 was published and unpublished, so npm will never accept it again and a `major` bump from 0.x would fail at publish; going stable skips straight to 2.0.0 with a one-off manual bump in the Version Packages PR (see [docs/RELEASING.md](docs/RELEASING.md#versioning)).
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
- The peer floor is a published contract: raising it is a breaking change for consumers and gets its own issue and a `minor` changeset while on 0.x (a major one once stable), never a drive-by bump.

## Agent sessions

The SessionStart hook (`.claude/hooks/session-start.sh`) installs dependencies against the lockfile and puts a `vp` shim on PATH for non-interactive shells. It hydrates no secrets; nothing here needs one. A PostToolUse hook runs `vp fmt --write` on each edited file. Publishing (the Release workflow's OIDC exchange) is the only thing that can't run in a session; the audit needs the npm registry.

## Documentation surfaces

`README.md` is the npm-facing API reference; `vp run docgen` renders the per-export reference from the doc comments into `api-docs/` (gitignored, not published); `docs/RELEASING.md` holds the release pipeline and the one-time owner setup; decisions go in issue comments.
