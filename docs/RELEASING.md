# Releasing

Releases are automated with [Changesets](https://github.com/changesets/changesets) and the **Release** GitHub workflow (`.github/workflows/release.yml`). One package is published from this repository: `@thomasfosterau/effect-wikimedia`.

## One-time repository setup (required)

Publishing uses **npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) via OIDC** — no long-lived `NPM_TOKEN`. The workflow already has `permissions: id-token: write` and upgrades npm to a version that supports OIDC (>= 11.5); two things still need configuring outside the repo:

1. **Allow the Action to open the release PR.** _Settings → Actions → General → Workflow permissions →_ enable **"Allow GitHub Actions to create and approve pull requests."** Without this, the workflow runs `changeset version` and pushes the `changeset-release/main` branch successfully, but fails at the final step with `GitHub Actions is not permitted to create or approve pull requests`, so no "Version Packages" PR is opened.

2. **Configure a trusted publisher on npmjs.com.** On `@thomasfosterau/effect-wikimedia`, go to _Settings → Trusted Publisher_ and add a GitHub Actions publisher:
   - Organization or user: `thomasfosterau`
   - Repository: `effect-wikimedia`
   - Workflow filename: `release.yml`
   - Environment: _(leave blank — the workflow doesn't use one)_

   > **First publish of a brand-new package.** npm only lets you add a trusted publisher to a package that **already exists**, so the very first publish (the initial `0.1.0`) can't use OIDC. Bootstrap it once with a short-lived [granular access token](https://docs.npmjs.com/creating-and-viewing-access-tokens):
   >
   > ```sh
   > # 1. Merge the open "Version Packages" PR first, so `main` carries the real
   > #    version. A fresh clone of `main` is still at 0.0.0, and publishing
   > #    that puts a placeholder 0.0.0 on the registry forever.
   > vp install
   > vp run build      # `dist/` must exist — `files` ships it, and `exports`
   >                   # points at it. Publishing without it yields a package
   >                   # whose every entry point 404s.
   > pnpm publish --access public --no-git-checks
   > ```
   >
   > Then add the trusted publisher and let OIDC handle every release after. (Tracked upstream in [npm/cli#8544](https://github.com/npm/cli/issues/8544).)

## How a release happens

1. **Land changesets.** Every change that should appear in the changelog ships with a changeset — a markdown file in `.changeset/` created by `vp run changeset` (pick a bump type). Preview what is pending with `vp exec changeset status`.

2. **Version Packages PR (automatic).** On every push to `main`, the Release workflow runs `vp run version` (`changeset version`): it consumes the pending changesets, bumps `package.json`, and writes `CHANGELOG.md` on the `changeset-release/main` branch, then opens (or updates) a **"Version Packages"** PR. Review it like any other PR.

3. **Publish (automatic on merge).** Merging the "Version Packages" PR triggers the workflow's publish step, `npm run release` (`vp run build && changeset publish`), which builds the package and publishes it to npm — authenticating via OIDC, no token required.

## Manual fallback

If the workflow can't open the PR (e.g. setting #1 above is still off), the `changeset-release/main` branch is still pushed with the correct version bump — open the "Version Packages" PR from that branch by hand. You can also run the version step locally:

```sh
vp run version          # apply pending changesets -> bump + CHANGELOG
git switch -c version-packages
git commit -am "Version Packages"
# open a PR; merging it triggers publish (or run `npm run release` locally)
```
