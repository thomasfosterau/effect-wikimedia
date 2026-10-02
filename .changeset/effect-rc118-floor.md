---
"@thomasfosterau/effect-wikimedia": minor
---

Raise the Effect floor to the shared library floor: requires `effect@>=4.0.0-rc.118`; import paths moved from `effect/unstable/*` to `effect/*`.

`peerDependencies.effect` moves from `>=4.0.0-beta.104` to `>=4.0.0-rc.118`, and the package's own imports of `effect/unstable/http` now read `effect/http`. Consumers on any `beta` or earlier `rc` build must upgrade `effect` to `4.0.0-rc.118` or later before taking this release; the previous release's published output imports `effect/unstable/*`, which no longer exists in `rc.118`. No public API of this package changes.
