# Publishing

[Changesets](https://github.com/changesets/changesets) manages versions and changelogs; publishing is npm trusted publishing (OIDC) from the protected `release` environment. There is no `NPM_TOKEN`.

## Release flow

1. A PR with a changeset merges into `trunk`.
2. The Release workflow ([release.yml](../.github/workflows/release.yml)) opens or updates the `chore: version packages` PR, which bumps the version and writes `CHANGELOG.md`.
3. Merging it publishes after the `release` environment's approval. The job runs `vp run release`, a `vite.config.ts` task (there is no publish script): the build, `vp run check:dist`, then `vp pm publish -r --access public --no-git-checks -- --ignore-scripts` (pnpm skips a version npm already has and does the OIDC exchange itself), then `changeset git-tag`, which tags the version and reports the tag to the Changesets action; the action pushes it and creates the GitHub release. A failed publish stops before tagging.

`vp run release:dry-run` builds, checks and lists what would be published, without publishing or tagging.

Don't add `--provenance`: trusted publishing records provenance itself. The release jobs install with `--ignore-scripts`, so no dependency script runs in a job holding `id-token: write`.

## Versioning

The package stays on 0.x. 1.0.0 was published in error and unpublished, and npm never reuses a version, so a `major` changeset would fail at publish. Going stable means a one-off manual bump to 2.0.0 in the version PR: edit `package.json` and the new `CHANGELOG.md` heading on the `changeset-release/trunk` branch as the last step before merging, since any push to `trunk` regenerates that branch.

## One-time owner setup

1. A trusted publisher needs an existing package. To publish a version by hand (a bootstrap), from a clean `trunk`: `vp install --frozen-lockfile`, `vp run release:dry-run`, then `vp run release`, then `git push origin --tags`.
2. On npmjs.com, for `@thomasfosterau/effect-wikimedia`: Settings → Trusted Publisher → GitHub Actions, repository `thomasfosterau/effect-wikimedia`, workflow `release.yml`, environment `release`.
3. Repository settings → Environments → `release`: required reviewers, deployments from `trunk` only.
4. Settings → Actions → General: allow GitHub Actions to create and approve pull requests.
