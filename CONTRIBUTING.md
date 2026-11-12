# Contributing

Maintained by Thomas Foster, with a workflow meant to be approachable for both humans and coding agents. This file covers setup, the hooks and every command, for humans and agents alike; the conventions, the gate order and the tracker rules are in [AGENTS.md](AGENTS.md).

## Setup

Node 22 or later and pnpm 11 (pinned by `packageManager`; `corepack enable` picks it up).

```sh
pnpm install --frozen-lockfile
```

`prepare` installs the Vite+ git hooks (`vp config`) and patches the native `tsc` and `oxlint` with `@effect/tsgo` (`effect-tsgo patch --typescript --oxlint`), so `vp run check` reports Effect diagnostics and `vp check` runs the Effect lint preset. Nothing needs a credential, a database or Docker: tests run against the recorded fixtures in `tests/fixtures/` with the network stubbed.

Open in a Codespace or Dev Container: `.devcontainer/` provisions it with the same hook as agent sessions. The `Dev Container` workflow (`.github/workflows/devcontainer.yml`) builds it in CI whenever its inputs change; to try a change locally, `pnpm dlx @devcontainers/cli@0.89.0 up --workspace-folder .` (needs Docker).

## Branches

Branch off `trunk` as `issue-<n>-<slug>`, rebase onto `origin/trunk` rather than merging it, and squash-merge with a conventional prefix: see [AGENTS.md](AGENTS.md#branches-and-pull-requests).

## Git hooks

Hooks are managed by Vite+; the editable [.vite-hooks/pre-commit](.vite-hooks/pre-commit) is committed. **pre-commit** runs `vp staged` on the staged files: `vp check --fix --no-lint` (format with fixes) then `vp check --no-fmt` (lint without autofixes, since type-aware fixes would change the commit after you verified it). There is no pre-push hook: run the gates yourself.

## CI expectations

[ci.yml](.github/workflows/ci.yml) runs `vp run ci` (the `ci` task in `vite.config.ts`: the gate list in [AGENTS.md](AGENTS.md#verification), in that order) as one job per Node.js line, `ci (node lts)` and `ci (node latest)`: the required checks. Run `vp run ci` locally for the same result. [release.yml](.github/workflows/release.yml) runs changesets/action on `trunk`: it opens the "chore: version packages" PR while unreleased changesets exist and publishes once it merges, via npm OIDC trusted publishing (see [PUBLISHING.md](PUBLISHING.md)). Both workflows are hardened: `permissions: {}` at the top with per-job grants, every third-party action pinned to a commit SHA (Dependabot keeps the pins current), `persist-credentials: false` on every checkout (the Release workflow pushes through the GitHub API), no secrets in anything a pull request (Dependabot's included) can trigger, and the Release job skipped for `dependabot[bot]`; `uvx zizmor --offline .github` audits them.

## Pre-PR checklist

1. The gates in [AGENTS.md](AGENTS.md#verification), each with its final pass/fail.
2. A changeset (`pnpm changeset`) where [AGENTS.md](AGENTS.md#branches-and-pull-requests) requires one: a breaking change is `minor` while the package is on 0.x.
3. `git fetch origin trunk && git rebase origin/trunk`
4. Docs: the doc comment of every export you touch, which is the API reference. Update a `docs/*.md` guide when you change what it shows, and the README's entry-point table only when a namespace is added or its purpose changes.

## Commands

- `pnpm install --frozen-lockfile` — install exactly as CI does. `prepare` installs the Vite+ git hooks (`vp config`; pre-commit runs `vp staged`: `vp check --fix --no-lint` then `vp check --no-fmt` on staged files, formatting with fixes and linting without, so no type-aware autofix lands unverified) and patches the native `tsc` and `oxlint` with `effect-tsgo`. There is no pre-push hook.
- `vp check` — format (Oxfmt) + lint (Oxlint) + type-check (tsgolint); `--fix` to autofix. Lint is type-aware through oxlint-tsgolint (`lint.options.typeAware` and `typeCheck` in `vite.config.ts`), so its type-aware rules resolve imports: run it from a clean tree, as CI does before building. A Vite+ built-in, not the `check` task below.
- `vp run check` — the TS 7 type check plus Effect diagnostics: runs `tsc -p tsconfig.json` with the native `tsc` that `prepare` patches with `effect-tsgo`. Only `error` fails it; warnings (`ignoreEffectWarningsInTscExitCode`) and suggestions print without affecting the exit code. tsgolint reports none of these. Cached; a change to anything it reads (`src/`, `tests/`, `vite.config.ts`, `tsconfig.json`, `node_modules`, the patched binary included) reruns it.
- `vp run fallow` — the dead-code and duplication gate, fallow's static analyses. `fallow dead-code` fails on an unused file, export, type, devDependency or catalog entry, a duplicate export, an unresolved import, a circular dependency or a cross-surface import outside the `boundaries` rules. `.fallowrc.json` adds the entry points fallow's plugins can't see (`tests/dist-consumer/`, the TypeDoc plugin in `scripts/`) and holds the documented exemptions; everything reachable from `src/index.ts` is the published surface and counts as used. Delete what it reports as dead; exempt something in `.fallowrc.json` only with a comment saying why it is live (or, for a duplicate export, why the duplication is intended). A devDependency used only as a bin from a `vite.config.ts` task needs an `ignoreDependencies` entry, because fallow reads commands from package.json `scripts`, not from `run.tasks`. `fallow dupes --fail-on-issues` then fails on any clone group (5+ lines, 50+ tokens; test files are skipped) not listed in `duplicates.ignoredClones`. Each entry is the content fingerprint and instance count of a clone that predates the gate (#102): moving the code keeps it ignored, while editing a copy or adding another makes it a new group that fails. Extract a shared helper rather than add an entry. After removing a listed clone, delete its entry. Needs no build.
- `vp run test:unit` — the Vitest suite, with Istanbul coverage: it writes `coverage/coverage-final.json` (gitignored), which `fallow:health` reads.
- `vp run test:coverage` — the family's name for the coverage run the fallow audit reads; here an alias that depends on `test:unit`.
- `vp run fallow:health` — the complexity ratchet (#102): `fallow health` fails on a function over a cyclomatic, cognitive or CRAP ceiling. CRAP (`CC² × (1 − coverage)³ + CC`) uses the coverage `test:unit` writes, so the task depends on `test:unit` (a cache hit when the tests just ran). A missing coverage file is an error (exit 2), not a fallback to fallow's estimate. Every function is held to fallow's defaults (cyclomatic 20, cognitive 15, CRAP 30); the functions already over one when the gate landed are pinned at their measured value by `health.thresholdOverrides` in `.fallowrc.json`, one entry per function, raising only the limit it breaches. So no pinned function may get worse and no new one may join them. Bring a new over-limit function under the defaults (split it, or test it to lower its CRAP); don't add an override. After a refactor or new tests lower a pinned function, lower its ceiling to the value `fallow:health` now prints under "Health threshold overrides" (CRAP fails _at_ its ceiling, so set a CRAP ceiling 0.1 above the score), or delete the entry once the function is within the defaults. Renaming or moving a pinned function to another file drops its pin, so move the entry with it.
- `vp run build` — `vp pack` (tsdown) into `dist/`.
- `vp run check:dist` — the dist-consumer declaration check: builds, then type-checks `tests/dist-consumer/` against the emitted `dist/*.d.ts` (`skipLibCheck: false`, `nodenext`) with both TS 7 (`tsc`) and TS 6 (`tsc6`). A change to a public type the fixture pins means updating the fixture alongside the changeset.
- `vp run docgen` — the docs gate: TypeDoc renders the API reference from the doc comments reachable from `src/index.ts` into the gitignored `api-docs/`, and fails on an undocumented export, method or property (a field of a public interface, schema or error class) or a `{@link}` that resolves to nothing in the published surface (`typedoc.json`; `tsdoc.json` registers `@copyright`). Needs no build.
- `pnpm audit --audit-level high` — the supply-chain gate (network: needs the npm registry).
- `vp exec fallow audit --format json --quiet --explain --gate-marker agent --base origin/trunk` — the change-set review an agent runs before each commit or push ([AGENTS.md](AGENTS.md#fallow-local-gate); in Claude Code a PreToolUse hook runs it, see [.claude/CLAUDE.md](.claude/CLAUDE.md)); not a CI step. It reads `coverage/coverage-final.json`, so run `vp run test:coverage` first.
- `pnpm changeset` — add a changeset.

Use `./node_modules/.bin/vp` if `vp` is not on PATH. `vp run` puts this package's `node_modules/.bin` first on PATH, so its tasks always get the patched `tsc`. Run a bare `tsc` yourself only as `./node_modules/.bin/tsc`: a global `tsc` is not the patched one and reports no Effect diagnostics.

Single checks and their variants:

```sh
vp check                          # format + lint + tsgolint type-check (Vite+ built-in)
vp check --fix                    # the same, autofixing
vp lint src/core.ts               # lint one file
vp fmt                            # format only
vp run check                      # the TS 7 type check with Effect diagnostics
vp run fallow                     # dead code + duplication
vp run test:unit                  # the Vitest suite, writing coverage/coverage-final.json
vp test run tests/core.test.ts    # one test file
vp run fallow:health              # the complexity ratchet (reads the coverage map)
vp run build                      # vp pack → dist/
vp run check:dist                 # type-check tests/dist-consumer/ against dist/
vp run docgen                     # TypeDoc API reference → api-docs/
vp exec fallow audit --base origin/trunk  # change-set review (the agent gate; not a CI step)
```
