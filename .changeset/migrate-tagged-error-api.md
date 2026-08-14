---
"@thomasfosterau/effect-wikimedia": major
---

Migrate off the removed `Schema.TaggedErrorClass` API to `Schema.TaggedError`, which was renamed in effect `4.0.0-beta.104`. `TaggedErrorClass` no longer exists at `beta.104` and later, so importing this package under a current `effect` version previously threw at module load.

This is a breaking change: `peerDependencies.effect` moves from `^4.0.0-beta.102` to `>=4.0.0-beta.104`. Consumers pinned to `effect@<=4.0.0-beta.103` must upgrade `effect` before taking this release.
