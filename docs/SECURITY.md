# Security

## Reporting a vulnerability

Report vulnerabilities privately to Thomas Foster at [me@thomasfoster.au](mailto:me@thomasfoster.au), not in a public issue or other public channel. Include a description, reproduction steps and the affected version.

## Scope

The package is an HTTP client for public Wikimedia APIs and a parser for untrusted wikitext and dump input. In scope: a request sent to a host other than the validated Wikimedia one, header or parameter injection through a title or query, input that crashes the process or runs in super-linear time, and a decoded value escaping its schema (such as prototype pollution through a JSON key).

## Supply chain

- Releases use npm trusted publishing; there is no long-lived npm token. The release jobs install with `--ignore-scripts`.
- Workflows default to `permissions: {}`, never persist checkout credentials, and pin actions by `.github/workflows/actions.lock`.
- `minimumReleaseAge` holds new third-party versions for 24 hours; Dependabot waits 1 day. CI runs `pnpm audit --audit-level high`.
- The only runtime dependency is the first-party `@thomasfosterau/effect-parse`, besides the `effect` peer.
