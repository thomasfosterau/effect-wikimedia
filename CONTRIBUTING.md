# Contributing

Maintained by Thomas Foster, with a workflow meant to be approachable for both humans and coding agents. Conventions, commands and the gate list are in [AGENTS.md](AGENTS.md); this file covers what a human needs on top.

## Setup

Node 22 or later and pnpm 11 (pinned by `packageManager`; `corepack enable` picks it up).

```sh
pnpm install --frozen-lockfile
```

`prepare` installs the Vite+ git hooks (`vp config`) and patches the native `tsc` and `oxlint` with `@effect/tsgo` (`effect-tsgo patch --typescript --oxlint`), so `vp run check` reports Effect diagnostics and `vp check` runs the Effect lint preset. Nothing needs a credential, a database or Docker: tests run against the recorded fixtures in `tests/fixtures/` with the network stubbed.

## Branches

Branch off `trunk` as `issue-<n>-<slug>`, rebase onto `origin/trunk` rather than merging it, and squash-merge with a conventional prefix: see [AGENTS.md](AGENTS.md#branches-and-pull-requests).

## Git hooks

Hooks are managed by Vite+; the editable [.vite-hooks/pre-commit](.vite-hooks/pre-commit) is committed. **pre-commit** runs `vp staged` on the staged files: `vp check --fix --no-lint` (format with fixes) then `vp check --no-fmt` (lint without autofixes, since type-aware fixes would change the commit after you verified it). There is no pre-push hook: run the gates yourself.

## CI expectations

[ci.yml](.github/workflows/ci.yml) runs one required job, `ci`, whose steps are the gate list in [AGENTS.md](AGENTS.md#verification), in that order. [release.yml](.github/workflows/release.yml) runs changesets/action on `trunk`: it opens the "chore: version packages" PR while unreleased changesets exist and publishes once it merges, via npm OIDC trusted publishing (see [PUBLISHING.md](PUBLISHING.md)). Both workflows are hardened: `permissions: {}` at the top with per-job grants, every third-party action pinned to a commit SHA (Dependabot keeps the pins current), `persist-credentials: false` except where the Release job pushes, no secrets in anything a pull request (Dependabot's included) can trigger, and the Release job skipped for `dependabot[bot]`; `uvx zizmor --offline .github` audits them.

## Pre-PR checklist

1. The gates in [AGENTS.md](AGENTS.md#verification), each with its final pass/fail.
2. A changeset (`pnpm changeset`) where [AGENTS.md](AGENTS.md#branches-and-pull-requests) requires one: a breaking change is `minor` while the package is on 0.x.
3. `git fetch origin trunk && git rebase origin/trunk`
4. Docs: `README.md` for any change to the public surface, and the doc comment of every export you touch.

## Running individual checks

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
fallow audit --base origin/trunk  # change-set review (the agent gate; not a CI step)
```
