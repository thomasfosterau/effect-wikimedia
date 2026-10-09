---
"@thomasfosterau/effect-wikimedia": minor
---

The published declarations no longer import `node:stream`, so a browser or Worker project that type-checks them (`skipLibCheck: false`) no longer needs `@types/node`. The `Dumps` byte-source signatures now use two new structural types in place of Node's stream classes: `Dumps.fromNodeReadable` takes `() => Dumps.NodeReadableLike`, and `Dumps.Decompressor` is `() => Dumps.NodeDuplexLike`. Node streams such as `fs.createReadStream(...)`, `Readable.from(...)`, `zlib.createGunzip()` and any `Transform` still fit both, so code that passes them compiles unchanged. Code that uses what a `Decompressor` returns, such as `Dumps.gunzipTransform()`, now gets a `NodeDuplexLike` rather than a Node `Duplex`; cast it back to `Duplex` to call other stream methods on it.

Because the structural type also admits plain objects, a `Decompressor` that returns a value `node:stream` doesn't recognise as a stream now fails `Dumps.fromFile` / `Dumps.decompressWith` with a `SourceError` instead of hanging (pass a real Node stream: the check is a heuristic, and a plain object with boolean `readable` / `writable` still hangs), and `Dumps.fromNodeReadable` fails with a `SourceError` when its `evaluate` throws rather than dying with a defect. Streams built from real Node streams behave as before.
