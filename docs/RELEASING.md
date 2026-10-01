# Releasing

Releases are automated with [Changesets](https://github.com/changesets/changesets) and the **Release** GitHub workflow (`.github/workflows/release.yml`), and published to npm via [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC) — there is no `NPM_TOKEN`. One package is published from this repository: `@thomasfosterau/effect-wikimedia`. The pipeline is the shared library standard, copied from `thomasfosterau/effect-jsonapi`.

## How a release happens

1. **Land changesets.** Every change that should appear in the changelog ships with a changeset — a markdown file in `.changeset/` created by `pnpm changeset` (pick a bump type). Changes that don't affect the published package (docs, CI, tooling) need no changeset. Preview what is pending with `vp exec changeset status`.

2. **Version Packages PR (automatic).** On every push to `main`, the Release workflow runs `pnpm run version` (`changeset version && vp fmt`): it consumes the pending changesets, bumps `package.json`, and writes `CHANGELOG.md` on the `changeset-release/main` branch, then opens (or updates) a **"chore: version packages"** PR. Review it like any other PR.

   Changesets v3 formats the changelogs it writes with whatever formatter it detects, and it detects the `oxfmt` shim that Vite+ installs whenever `node_modules/oxfmt` exists (a hoisted install, as in the other library repositories); that shim only serves editors and exits non-zero when run directly. So `.changeset/config.json` sets `"format": false` and the `version` script formats with `vp fmt` itself.

3. **Publish (automatic on merge).** Merging that PR triggers the workflow's publish step, `pnpm run release` (`vp run build && changeset publish`). `changeset publish` runs `pnpm publish`, which rewrites the `catalog:peers` peer range into the real one and hands the publish to the npm CLI, which authenticates via OIDC (the job's `id-token: write` permission plus the trusted publisher below) and leaves provenance to npm (attached only when allowed, never forced: an explicit request fails from a private repository). The action then pushes the `v*` tag and creates the GitHub release.

The job runs in the protected `release` environment, so every run on `main` — the version PR and the publish alike — pauses for the environment's required reviewer to approve it.

## One-time repository setup

1. **Allow the Action to open the release PR.** _Settings → Actions → General → Workflow permissions →_ enable **"Allow GitHub Actions to create and approve pull requests."** Without this, the workflow runs `changeset version` and pushes the `changeset-release/main` branch successfully, but fails at the final step with `GitHub Actions is not permitted to create or approve pull requests`, so no version PR is opened.

2. **Create and protect the `release` environment.** _Settings → Environments → New environment → `release`_ → enable **Required reviewers** (yourself) and restrict deployment branches to `main`, so publishing pauses for manual approval. (GitHub auto-creates the environment, unprotected, the first time the workflow references it; the protection is the point.)

3. **Configure the trusted publisher on npmjs.com.** On `@thomasfosterau/effect-wikimedia`, go to _Settings → Trusted Publisher_ and add a GitHub Actions publisher:
   - Organization or user: `thomasfosterau`
   - Repository: `effect-wikimedia`
   - Workflow filename: `release.yml`
   - Environment: `release`

   The Environment field must match the workflow's `environment:` — a publisher configured without one (as this package's originally was) still matches, but pinning it means only an approved run of this workflow can publish.

4. **Protect `main`.** Require pull requests and passing CI before merge, and disallow direct pushes, so a release can only be triggered by merging the reviewed version PR.

## Manual fallback

If the workflow can't open the PR (e.g. setting #1 above is still off), the `changeset-release/main` branch is still pushed with the correct version bump — open the version PR from that branch by hand. You can also run the version step locally:

```sh
pnpm run version       # apply pending changesets -> bump + CHANGELOG
git switch -c version-packages
git commit -am "chore: version packages"
# open a PR; merging it triggers publish
```

Publishing by hand is deliberately not documented: the trusted publisher only accepts the workflow.
