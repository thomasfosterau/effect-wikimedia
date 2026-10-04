---
"@thomasfosterau/effect-wikimedia": patch
---

Document how to set `Core.UserAgent` so both request paths see it. `WikimediaClient` reads it when its layer is built, and `Dumps.fromHttpRange` reads it from the program's context. Two forms reach both:

- `Layer.provideMerge(Layer.succeed(Core.UserAgent, ua))` on the layer, which the README example now uses;
- `Effect.provideService(Core.UserAgent, ua)` placed outside the `Effect.provide` that builds the layer.

`Layer.provide` reaches the client only. A `provideService` inside `Effect.provide(layer)`, or applied per run on a `ManagedRuntime`, reaches the dump download only.
