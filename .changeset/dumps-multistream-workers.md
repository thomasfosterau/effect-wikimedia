---
"@thomasfosterau/effect-wikimedia": minor
---

Dumps: decode a multistream dump on a pool of workers (#211, slice 4).

- `Dumps.multistreamPageRecordsInWorkers({ concurrency })` sends each range to a worker as one `effect/rpc` request, and the records stream back.
- `Dumps.MultistreamRpcs` is the RPC contract, and `Dumps.multistreamWorkerHandlers(open)` is the worker side's handler layer.
- The caller supplies the platform: the worker entry file and the main side's `RpcClient.layerProtocolWorker` over their platform's `Worker` spawner. The README has a Node `worker_threads` recipe.
- `Dumps.MultistreamRangeFailed` is the error when a worker cannot read a range.
- `PageRef`, `Contributor`, `Revision`, `PageRevisionHit`, `PageRevisionError`, `PageRevisionRecord` and `MultistreamRange` are now `Schema`s, and their types derive from them, so the types are unchanged. An absent field is encoded as `null`.

**Breaking:** `Revision.minor` is renamed `isMinor`. It is the one field the schema form renames, to follow the package's lint rule that a boolean schema field takes an `is…`/`has…` prefix.
