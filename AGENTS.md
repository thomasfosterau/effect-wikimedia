# AGENTS.md

The guidance for any coding agent working here; Claude Code reads it through `.claude/CLAUDE.md`, which imports it with `README.md` and `CONTRIBUTING.md`. This repo publishes `@thomasfosterau/effect-wikimedia`, one package with a single `.` entry point: Effect clients for Wikipedia, Wikidata, Commons, WDQS, wikitext and dumps. It was extracted from `thomasfosterau/website` with `git subtree split`, so `git log` / `git blame` reach back through it; a bare `#NNN` in a comment ported from there names a **website** issue, not one in this tracker (write new ones as `website#NNN`).

Toolchain differences from the other library repos: single package, so the tasks keep the other repos' names (`check`, `test:unit`, `build`) but run without `-r` (`vp run check`, not `vp run -r check`). The docs gate is TypeDoc (`vp run docgen`), not `@effect/docgen`: TypeDoc checks that `{@link}`s resolve, and `@effect/docgen` does not. `vp check` and `vp run check` are different commands: `vp check` is Vite+'s built-in format + lint + type-check (tsgolint), and `vp run check` is this repo's `check` task in `vite.config.ts`, the patched native `tsc -p tsconfig.json` that reports Effect diagnostics.

## Common pitfalls

- **Module-per-surface is load-bearing.** Each namespace in `src/index.ts` imports only `Core`, with two exceptions: `Dumps` decodes through `Wikidata`'s model, and `Reconciliation` drives `Action` and `Wikidata`. `Wikitext` imports no other surface (its parser is written with `@thomasfosterau/effect-parse`). `tests/tree-shaking.test.ts` bundles each namespace with esbuild and fails on any other cross-surface import, and the `boundaries` zones in `.fallowrc.json` fail `vp run fallow` on one; add a new surface to the test's `SURFACES` table and to the zones.
- **No subpath exports.** Namespaces on the one barrel give the tree-shaking property without fragmenting the API.
- **No live network in tests.** Use the recorded fixtures in `tests/fixtures/` and stub at `FetchHttpClient.Fetch` or under `Core.wikimediaClientLayer`. Wikimedia's etiquette rules (polite `User-Agent`, `maxlag`) exist because the projects are donation-funded.
- **Node imports stay in `src/dumps/sources.ts`.** The build is `platform: "neutral"` (`vite.config.ts`); everything else must run in a browser or a Worker.
- **Never edit a version in `package.json`.** Edit the strict catalog in `pnpm-workspace.yaml`, run `pnpm install`, and commit `pnpm-lock.yaml` (CI installs with `--frozen-lockfile`). `vite-plus`, `vite`, `vitest` and `@vitest/coverage-istanbul` move together, and `@effect/tsgo`, `@typescript/native` and `vite-plus` move together (the tsgo patch hard-errors at install on a `tsc` or `oxlint` it has no build for); read the catalog comments first. Dependabot proposes each move-together set as one grouped PR (`.github/dependabot.yml`: `toolchain` and `effect`; everything else, `@enfect/oxlint` and each GitHub Action included, gets a PR of its own); the npm-alias entries it may not bump itself (`vite` → `@voidzero-dev/vite-plus-core`, `typescript` → `@typescript/typescript6`, `@typescript/native` → `typescript`) are by-hand edits in the same PR as their group's bump. Dependabot's `cooldown` is 1 day (it takes whole days only), longer than pnpm's 8-hour `minimumReleaseAge`.
- **`vp check` runs the Effect lint rules.** `vite.config.ts` extends `@effect/tsgo/oxlint-presets`' `recommended` and `@enfect/oxlint`'s `recommended` (the `effect/` rules), on top of Oxlint's `correctness`, `suspicious` and `perf` categories with the `typescript`, `unicorn`, `oxc`, `import`, `promise`, `vitest` and `jsdoc` plugins, type-aware. Fix a finding by writing the idiomatic Effect shape, never with a disable comment; a rule is relaxed only in `vite.config.ts`, scoped to the files it cannot apply to, with a comment giving the reason.

## Conventions

- Effect modules are namespace imports. The helper modules take the aliases `effect/prefer-namespace-imports` enforces: `Arr` (`effect/Array`), `P` (`effect/Predicate`), `R` (`effect/Record`), `Str` (`effect/String`), `Eq` (`effect/Equal`) and `Bool` (`effect/Boolean`). Every other module keeps its own name (`import * as Option from "effect/Option"`, `Schema`, `Effect`) (#224).
- Relative imports carry their `.ts` extension (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`).
- Absent values are `Option.Option<T>`, never `T | null` or `T | undefined` (the owner's decision on #224, enforced by `effect/prefer-option-over-null`). The spellings:
  - A field or return that may be absent is `Option.Option<T>`.
  - An options-object member is plain `readonly x?: T`, with no `| undefined`. `exactOptionalPropertyTypes` stays on, so a caller forwarding a maybe-absent value omits the key.
  - An optional property whose absence and `None` mean different things is `x?: Option.Option<T>` (e.g. `WikimediaRequest.maxlagSeconds`).
  - An optional parameter is `x?: T`.
  - Wire schemas (`*Response`) and persisted JSON shapes keep their native `undefined` / `null`.
- Tests take `it` and `layer` from `@effect/vitest` (`assertInstanceOf` and the other assertions from `@effect/vitest/utils`) and the rest of the Vitest API (`describe`, `expect`, `vi`, hooks) from `vite-plus/test`, never from `vitest`. An Effect test is `it.effect` (`it.live` where it needs real time: the `Dumps` Node-stream tests), a describe whose tests share a stub layer is `layer(...)` / `it.layer(...)`, and a per-test stub goes in with `Effect.provideService` (a `FetchHttpClient.Fetch`, say) under that shared layer: no test calls `Effect.provide` with a layer or `Effect.run*` itself (`effecttsgo/strict-effect-provide` and `effect/effect-run-in-body` are errors with no exceptions, #224). A failure is asserted with `Effect.flip` (or `Effect.exit`) and `assertInstanceOf`. A test of a pure function stays a plain `it`.
- Every export has a doc comment whose first sentence says what it is for and stands alone in a hover; state the error channel, units and invariants the signature can't. Put the description before any tag (`@copyright`, `@module`): only text before the first tag shows as the summary.
- A `{@link}` must resolve within the published surface, or `vp run docgen` fails: link a name in scope (`{@link WikimediaRequest}`) or a barrel path (`{@link Core.WikimediaRequest}`, `{@link Core}`), never a module path (`{@link "./core"}`) or a helper the barrel doesn't export (write that as a code span). A namespace's module comment ends in a bare `@module`, so the docs name it as the barrel does (`Core`, not `core`).
- Errors are `Schema.TaggedError<Self, { readonly brand: unique symbol }>()(tag, fields)` classes: the second type argument brands the instance type so structurally identical errors stay distinct (`effecttsgo/schema-class-missing-brand`; the pinned `effect` has no `Schema.TaggedErrorClass`).
- Services are keyed `"effect-wikimedia/<Name>"` (e.g. `"effect-wikimedia/Client"`), not an app-style `"@app/<Name>"` (that slip was #19).

## Commands

The commands, each gate's details and the single-check variants are in [CONTRIBUTING.md](CONTRIBUTING.md#commands); [Verification](#verification) below is the order to run them in.

## Verification

Before you report work as done, run `vp run ci`, the `ci` task in `vite.config.ts` and the one command CI runs (`.github/workflows/ci.yml`, on the Node.js LTS and Current lines). It runs gates 1–9 below in order, stopping at the first failure. Quote each gate with its final pass/fail:

1. `vp check`
2. `vp run check`
3. `vp run fallow`
4. `vp run test:unit`
5. `vp run fallow:health`
6. `vp run build`
7. `vp run check:dist`
8. `vp run docgen`
9. `pnpm audit --audit-level high`
10. `vp run test:coverage`, then `vp exec fallow audit --format json --quiet --explain --gate-marker agent --base origin/trunk` (the fallow gate below; not a CI step). Its verdict must not be `fail`.

Steps 1–9 are the `ci` task, in its order; the required check is the workflow's `ci` gate job, which passes only when every matrix run of `vp run ci` did.

Before pushing, start from a clean tree: `rm -rf node_modules dist && pnpm install --frozen-lockfile`. None of the gates needs a credential or Docker. If a gate can't run here (the audit needs the registry), say which and why in the PR body; never imply it ran.

## Branches and pull requests

- Branch off `trunk` as `issue-<n>-<slug>`; PR against `trunk`. Squash-merge is preferred and a merge commit is acceptable; either way, rebase onto `origin/trunk` before opening or updating a PR, and never merge `trunk` into your branch (GitHub's Update-branch button merges).
- Every change to the published package's behaviour, including its doc comments (they ship in the `.d.ts`), carries a changeset (`pnpm changeset`); docs-, CI- and tooling-only changes need none. Never publish or version by hand (the one exception is the owner's one-off 2.0.0 bump; see [PUBLISHING.md](PUBLISHING.md#versioning)): the Release workflow opens the "Version Packages" PR (`chore: version packages`), the owner merges it, and the workflow publishes. See [PUBLISHING.md](PUBLISHING.md).
- The package stays on 0.x: a breaking change takes a `minor` changeset, and `major` is never used while on 0.x. 1.0.0 was published and unpublished, so npm will never accept it again and a `major` bump from 0.x would fail at publish; going stable skips straight to 2.0.0 with a one-off manual bump in the Version Packages PR (see [PUBLISHING.md](PUBLISHING.md#versioning)).
- Standing approvals: open a PR once a branch has a pushed commit; watch it to merge or close (CI failures, review comments, rebase when it conflicts); keep the PR body current.
- GitHub writes go to `thomasfosterau/effect-wikimedia` only; pass `-R thomasfosterau/effect-wikimedia` whenever the cwd might be another checkout. Use the `gh` CLI for GitHub operations, even when GitHub MCP tools are available. If another repo needs something, say so in the PR body.

## Work tracker

- Issues are the backlog: when you find work you can't do now, file an issue rather than leaving a TODO.
- The issue is the spec — read all of it, including comments; later comments override the body. Re-verify its code claims against current `trunk` before editing.
- Record decisions and findings as issue comments.
- Stop-and-report is a valid outcome: on a blocker outside the issue's scope, comment the evidence on the issue and stop. Scope cut mid-PR becomes a linked issue before merge.

## Effect

- Read the Effect API from the installed package, never from memory, and never guess at one: signatures and doc comments in `node_modules/effect/dist/*.d.ts`, implementations in `node_modules/effect/src`, and the guides the pinned version ships in `node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/`.
- The pinned version is the `effect` entry in `pnpm-workspace.yaml`'s catalog; the published peer range is `catalogs.peers.effect`: `^4.0.0`, raised only when a dependency requires it (or the package needs an unstable module first shipped in a later minor), naming the dependency or module in the catalog comment, and proved by re-running the gates with the catalog pin at the floor.
- In the rc line, HTTP modules live under `effect/http` (`HttpApi` under `effect/http-api`); there are no `effect/unstable/*` paths and no `@effect/platform`. `FileSystem` / `Path` are `effect/*` modules.
- The peer floor is a published contract: raising it is a breaking change for consumers and gets its own issue and a `minor` changeset while on 0.x (a major one once stable), never a drive-by bump.

## Agent sessions

Every gate runs in an agent session: none needs a credential or Docker. Two things can't: publishing (the Release workflow's OIDC exchange), and anything that needs the npm registry when the session has no route to it (`pnpm audit`). Work in a worktree under `.claude/worktrees/<name>` (the fallow gate trusts exactly those, as `.claude/CLAUDE.md` describes). Tool-specific session setup lives with each tool: Claude Code's hooks and plugins are in [.claude/CLAUDE.md](.claude/CLAUDE.md).

## Documentation surfaces

`README.md` is the npm landing page and stays short: what the package is, install, one minimal example, a table of the entry points, and links, every link absolute (it renders on npm, away from the private repository). Longer how-tos go in `docs/*.md` guides (published), and API detail goes in the per-export doc comments; `MIGRATION.md` (published) tells apps how to move across each breaking minor, and a breaking PR adds its entry there alongside its changeset; `vp run docgen` renders the per-export reference from the doc comments into `api-docs/` (gitignored, not published); `CONTRIBUTING.md` carries setup, the hooks and every command with its details; this file the conventions, pitfalls, gate order and tracker rules any agent follows; `.claude/CLAUDE.md` only what is specific to Claude Code (its hooks, plugins and session notes), importing the other three; `PUBLISHING.md` the release pipeline, versioning and the one-time owner setup; `SECURITY.md` the reporting channel and supply-chain posture; decisions go in issue comments.

## Fallow local gate

Before any `git commit` or `git push`, run `fallow audit --format json --quiet --explain --gate-marker agent --base origin/trunk`. If the verdict is `fail`, fix the reported findings before retrying. Treat JSON runtime errors like `{ "error": true, ... }` as non-blocking. Audit defaults to `gate=new-only`: only findings introduced by the current changeset affect the verdict.

## Fallow task map

| When the agent is about to...                                     | Run                                          |
| ----------------------------------------------------------------- | -------------------------------------------- |
| delete an "unused" export or file                                 | `fallow dead-code --trace <file>:<export>`   |
| delete an "unused" dependency                                     | `fallow dead-code --trace-dependency <name>` |
| commit or open a PR                                               | `fallow audit --base origin/trunk`           |
| check which architecture rules apply to a file before changing it | `fallow guard <files>`                       |
| understand a finding                                              | `fallow explain <issue-type>`                |
