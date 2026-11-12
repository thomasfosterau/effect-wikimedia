# Type-checking against the package

`effect` is a peer dependency (`^4.0.0`), so the package shares your copy: two copies would break `Context`, `Layer` and `Schema` identity at runtime.

The package's declarations need no `@types/node`: the Node-only `Dumps` byte sources type their stream parameters structurally. A project that type-checks dependencies' declarations (`skipLibCheck: false`) still needs a `lib` that covers `effect`'s own: `ESNext.Disposable` (or `ESNext`) for `Disposable` / `AsyncDisposable`, and `DOM` for the web types they name (`URL`, `Request`, `ReadableStream`; `WebWorker` alone lacks the `Storage` that `effect/persistence` names).
