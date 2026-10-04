---
"@thomasfosterau/effect-wikimedia": patch
---

Document when `Core.UserAgent` reaches the client. `WikimediaClient` reads it once, when its layer is built. So an `Effect.provideService(Core.UserAgent, ua)` that the layer build doesn't see leaves the client on the default `User-Agent`, while `Dumps.fromHttpRange` still picks it up. That happens when the call is applied inside `Effect.provide(Core.wikimediaLayer)`, or per run on a `ManagedRuntime`. To avoid the split, provide the reference to the layer.
