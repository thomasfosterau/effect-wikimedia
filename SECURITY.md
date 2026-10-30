# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately by email to [me@thomasfoster.au](mailto:me@thomasfoster.au), **not** through a public channel. The source repository is private, so there is no public issue tracker or advisory form.

You can expect an initial response within a few days. Please include a description, reproduction steps, and the affected version of `@thomasfosterau/effect-wikimedia`.

The package is an HTTP client for public Wikimedia APIs and a parser for untrusted wikitext and dump input, so reports of interest include: a request sent to a host other than the validated Wikimedia one, a header or parameter injection through a title or query, a parser or dump input that crashes the process or runs in super-linear time, and a decoded value that escapes its schema (for example prototype pollution through a JSON key).

## Supply-chain hardening

The package is published with an automated pipeline designed to resist supply-chain attacks (e.g. self-propagating npm worms that steal credentials and publish trojanized versions):

- **No long-lived npm token.** Releases use npm [**OIDC Trusted Publishing**](https://docs.npmjs.com/trusted-publishers): GitHub Actions proves its identity to npm with a short-lived, workflow-bound OIDC token. There is no `NPM_TOKEN` secret to steal from CI.
- **Provenance.** Provenance is attached only when the source repository and the package are both public; while this repository is private `pnpm publish` skips it.
- **Pinned actions.** Every GitHub Action is pinned to a full commit SHA, so a hijacked tag cannot inject workflow code.
- **Least privilege.** Workflows default to `permissions: {}`; each job opts into only the scopes it needs. CI checks out with `persist-credentials: false` and holds read permissions only.
- **Manual approval gate.** Publishing runs in a protected `release` environment that requires manual approval.
- **Locked dependencies with a cooling-off period.** Installs use `pnpm install --frozen-lockfile` against the committed `pnpm-lock.yaml`; `allowBuilds` in `pnpm-workspace.yaml` lists the only dependencies allowed to run build scripts; `minimumReleaseAge` holds newly published third-party versions for 8 hours before pnpm installs them, and Dependabot proposes updates after a 1-day cooldown (it takes whole days only), so never sooner. CI fails on any `high` advisory (`pnpm audit --audit-level high`).
- **Small runtime footprint.** The published package depends only on `@thomasfosterau/effect-parse` (first-party) and its `effect` peer.

## Release pipeline

The publishing pipeline and its one-time maintainer setup (trusted publisher, protected `release` environment, branch protection) are documented in [PUBLISHING.md](PUBLISHING.md).
