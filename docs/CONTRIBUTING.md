# Contributing

## Workflow

- Branch off `trunk` and open a pull request into `trunk`; never commit to `trunk` directly. Open a draft PR as soon as you start, and keep one PR per change, however large. Squash-merge with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`). Rebase onto `origin/trunk` rather than merging it in.
- File an issue for anything you notice that is out of scope, and keep issue bodies evergreen: edit the body as understanding improves rather than appending comments.
- Dependabot keeps dependencies current. Its `toolchain` group needs hand edits on the same branch: the npm-alias catalog entries (`vite` must equal `vite-plus`; `typescript` / `@typescript/native` must be a pair `@effect/tsgo` supports), an `@effect/tsgo` release that supports the new oxlint, and the devcontainer image tag.

## Toolchain

[Vite+](https://viteplus.dev) (`vp`) manages Node and pnpm and runs every task. `vp install` installs dependencies, the git hooks (pre-commit runs `vp staged`, then `vp run fallow:audit`) and, through `prepare`, the Effect-patched `tsc` and oxlint.

| Command                                  | What it does                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `vp check`                               | Format (Oxfmt) and lint (Oxlint with the Effect presets, type-aware)         |
| `vp run check`                           | Type gate: the Effect-patched native `tsc`, which reports Effect diagnostics |
| `vp run test:unit`                       | Unit tests, writing the coverage map fallow reads                            |
| `vp run fallow` / `vp run fallow:health` | Dead code and duplication / complexity                                       |
| `vp run build`                           | `vp pack` → `dist/`                                                          |
| `vp run check:dist`                      | Type-checks `tests/dist-consumer/` against the emitted declarations          |
| `vp run docgen`                          | TypeDoc; fails on an undocumented export or an unresolved `{@link}`          |
| `vp run ci`                              | Everything CI runs, in order (`pnpm audit` needs the network)                |

[Fallow](https://docs.fallow.tools) is a guide, not dogma: use it to polish your work. `vp run fallow:audit` (the pre-commit hook) fails only on findings your change introduces. Before deleting "unused" code, trace it: `vp exec fallow dead-code --trace <file>:<export>`.

Every external version lives in the `pnpm-workspace.yaml` catalog; never edit one in `package.json`.

## Coding guidelines

- Use Effect idioms throughout, and strongly prefer Effect v4's own modules (`Array`, `Option`, `Match`, `Schema`, `effect/http`, …) over hand-rolled equivalents; convert existing code where practical. Exceptions: non-Effect APIs adapted at the edge (the Node streams in `src/dumps/sources.ts`), and hot paths where measured performance needs plain code (the wikitext cursor). Read the installed `effect` package rather than guessing at an API.
- One module per surface: each namespace imports only `Core`, except `Dumps` (uses `Wikidata`'s model) and `Reconciliation` (drives `Action` and `Wikidata`); `Wikitext` imports nothing. Fallow's boundaries and `tests/tree-shaking.test.ts` enforce it.
- Exports follow Effect's layout: `src/index.ts` re-exports each surface as a PascalCase namespace, and each is also importable from its own PascalCase subpath (`@thomasfosterau/effect-wikimedia/Action`). A new surface adds both, plus its `exports` entry in `package.json`.
- The build is `platform: "neutral"`: Node imports stay in `src/dumps/sources.ts`.
- Absent values are `Option`. Options-object members are `readonly x?: T` (`exactOptionalPropertyTypes` is on); wire schemas keep native optionals.
- Errors are `Schema.TaggedError` classes with a brand type argument. Relative imports carry `.ts`.
- Fix lint findings in code; a rule is relaxed only in `vite.config.ts`, scoped, with its reason.
- Comments: a short file header only where it adds context; doc comments on exports where they add to IntelliSense (description first, then tags; TypeDoc needs every export documented and every `{@link}` resolvable in the published surface). Inline comments only for the non-obvious. No references to issues, PRs or history.
- Tests take `it` / `layer` from `@effect/vitest` and the rest from `vite-plus/test`. Never hit the network: use the fixtures in `tests/fixtures/` and stub `FetchHttpClient.Fetch`. Test logic and edge cases, not what the type system already checks.

## Before pushing

Run `vp run ci`. CI ([ci.yml](../.github/workflows/ci.yml)) runs it on Node `lts` and `latest` with no secrets. Workflows pin actions by exact tag, locked to commits by `.github/workflows/actions.lock`: run `gh actions-lock` after changing a `uses:`. `uvx zizmor --offline .github` audits the workflows.

## Changesets

Every change to the published package's behaviour or its `.d.ts` (doc comments included, as a `patch`) needs a changeset: `vp exec changeset`. Docs-, CI- and tooling-only changes need none. The package stays on 0.x: a breaking change is a `minor`, never a `major` (see [PUBLISHING.md](PUBLISHING.md#versioning)), and adds an entry to [MIGRATION.md](../MIGRATION.md). Never version or publish by hand: the Release workflow opens the `chore: version packages` PR, and merging it publishes.
