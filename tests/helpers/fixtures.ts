/**
 * Recorded-fixture readers and scratch-file helpers for the unit suite, through
 * Effect's `FileSystem` and `Path` services (#224) rather than `node:fs` /
 * `node:path` / `node:url`.
 *
 * Every reader is an Effect: a test `yield*`s it inside `it.effect` / `it.live`
 * and gets the Node implementations from `@effect/vitest`'s
 * `layer(NodeServices.layer)`, which also builds {@link TempDir.layer} on top
 * of them for suites that write files.
 *
 * @module tests/helpers/fixtures
 */

import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";

/** The absolute path of `tests/fixtures/<name>`, for APIs that open a file by path. */
export const fixturePath = Effect.fn("fixturePath")(function* (name: string) {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(new URL(`../fixtures/${name}`, import.meta.url));
});

/** Reads `tests/fixtures/<name>` as UTF-8 text. */
export const readFixture = Effect.fn("readFixture")(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* fixturePath(name);
  return yield* fs.readFileString(file, "utf8");
});

/** Reads `tests/fixtures/<name>` and parses it as JSON. */
export const readFixtureJson = Effect.fn("readFixtureJson")(function* (name: string) {
  const text = yield* readFixture(name);
  return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(text);
});

/** Reads `tests/fixtures/<name>` as raw bytes. */
export const readFixtureBytes = Effect.fn("readFixtureBytes")(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* fixturePath(name);
  return yield* fs.readFile(file);
});

/** The names of the `tests/fixtures/*<suffix>` files. */
export const readFixtureNames = Effect.fn("readFixtureNames")(function* (suffix: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* path.fromFileUrl(new URL("../fixtures/", import.meta.url));
  const names = yield* fs.readDirectory(dir);
  return names.filter((name) => name.endsWith(suffix));
});

/**
 * A scoped temporary directory: built once for a `layer(...)` block and
 * deleted when the block's scope closes.
 */
export class TempDir extends Context.Service<
  TempDir,
  {
    /** The path of `name` inside the directory. */
    readonly join: (name: string) => string;
  }
>()("effect-wikimedia/tests/TempDir") {
  /** Makes a directory whose name starts with `prefix`; needs `FileSystem` and `Path`. */
  static readonly layer = (
    prefix: string,
  ): Layer.Layer<TempDir, PlatformError, FileSystem.FileSystem | Path.Path> =>
    Layer.effect(TempDir)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix });
        return { join: (name: string): string => path.join(dir, name) };
      }),
    );
}

/** The path of `name` inside the suite's {@link TempDir}. */
export const tempPath = (name: string): Effect.Effect<string, never, TempDir> =>
  TempDir.useSync((dir) => dir.join(name));

/** Writes `data` to `path`, replacing the file. */
export const writeTestFile = (
  path: string,
  data: string | Uint8Array,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) =>
    P.isString(data) ? fs.writeFileString(path, data) : fs.writeFile(path, data),
  );

/** Gzips `data` with the Web `CompressionStream`, available on Node and in browsers. */
export const gzip = (data: Uint8Array): Effect.Effect<Uint8Array, Cause.UnknownError> =>
  Effect.tryPromise(
    async () =>
      new Uint8Array(
        await new Response(
          new Blob([new Uint8Array(data)]).stream().pipeThrough(new CompressionStream("gzip")),
        ).arrayBuffer(),
      ),
  );
