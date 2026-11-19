# Publishing

[Changesets](https://github.com/changesets/changesets) manages versions and changelogs; publishing is npm trusted publishing (OIDC) from the protected `release` environment. There is no `NPM_TOKEN`.

## Release flow

1. A PR with a changeset merges into `trunk`.
2. The Release workflow ([release.yml](../.github/workflows/release.yml)) opens or updates the `chore: version packages` PR, which bumps the version and writes `CHANGELOG.md`.
3. Merging it publishes with `changeset publish` (`pnpm publish`, which does the OIDC exchange itself) after the `release` environment's approval, and tags the release.

Don't add `--provenance`: trusted publishing records provenance itself. The release jobs install with `--ignore-scripts`, so no dependency script runs in a job holding `id-token: write`.

## Versioning

The package stays on 0.x. 1.0.0 was published in error and unpublished, and npm never reuses a version, so a `major` changeset would fail at publish. Going stable means a one-off manual bump to 2.0.0 in the version PR: edit `package.json` and the new `CHANGELOG.md` heading on the `changeset-release/trunk` branch as the last step before merging, since any push to `trunk` regenerates that branch.

## One-time owner setup

1. On npmjs.com, for `@thomasfosterau/effect-wikimedia`: Settings → Trusted Publisher → GitHub Actions, repository `thomasfosterau/effect-wikimedia`, workflow `release.yml`, environment `release`.
2. Repository settings → Environments → `release`: required reviewers, deployments from `trunk` only.
3. Settings → Actions → General: allow GitHub Actions to create and approve pull requests.
