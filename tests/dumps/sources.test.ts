/**
 * Unit tests for the Node-only dump sources (`src/dumps/sources.ts`): the file
 * source with inline gzip decompression, the pluggable {@link Dumps.gunzip} /
 * {@link Dumps.decompressWith} stages (including bzip2 through `unbzip2-stream`,
 * a classic stream, #128), the **interruption teardown** guarantee
 * (cancelling the Effect destroys the decompression source — no orphaned
 * work), and the **resumable** HTTP range download (offset tracked across a
 * mid-stream failure). The network is stubbed at `FetchHttpClient.Fetch`.
 *
 * The Node-stream tests run under `it.live`: the sources wait on real Node
 * streams (a `close` event, bounded by an Effect timeout), and the tests bound
 * a hang with a real 5 s timer, neither of which a `TestClock` would advance.
 * The HTTP range tests run under `it.effect`, as no time passes in them.
 *
 * @module tests/dumps/sources
 */

import { execFileSync } from "node:child_process";
import {
  closeSync,
  createReadStream,
  mkdtempSync,
  openSync,
  readFileSync,
  ReadStream,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compose,
  Duplex,
  Stream as LegacyStream,
  PassThrough,
  Readable,
  Transform,
} from "node:stream";
import { createGunzip, gzipSync } from "node:zlib";
import unbzip2 from "unbzip2-stream";
import { it, layer } from "@effect/vitest";
import { assertInstanceOf } from "@effect/vitest/utils";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  onTestFinished,
  vi,
} from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient } from "effect/http";
import { Core, Dumps } from "../../src/index.ts";

const DUMP = '[\n{"type":"item","id":"Q1"},\n{"type":"item","id":"Q2"}\n]\n';

let tmp: string;
beforeAll(() => (tmp = mkdtempSync(join(tmpdir(), "dumps-sources-"))));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const decodeUtf8 = (bytes: ReadonlyArray<Uint8Array>): string =>
  Buffer.concat(bytes.map((b) => Buffer.from(b))).toString("utf8");

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A callback that does nothing, the placeholder a deferred resolver holds until it is assigned. */
const noop = (): void => undefined;

/** The failure a fake stage, source or fetch body raises; its `message` is what a test asserts on. */
class FakeFailure extends Schema.TaggedError<FakeFailure>()("FakeFailure", {
  message: Schema.String,
}) {}

/**
 * Collects what `process` emits as `event` until the test finishes, when the
 * listener is removed. The listener makes the test fail on its own (Vitest
 * would otherwise only fail the run, unattributed).
 */
const collectProcessEvents = (event: "uncaughtException" | "unhandledRejection"): unknown[] => {
  const seen: unknown[] = [];
  const listener: NodeJS.UnhandledRejectionListener = (reason) => seen.push(reason);
  process.on(event, listener);
  onTestFinished(() => void process.off(event, listener));
  return seen;
};

/**
 * Runs `effect` on a detached fiber and gives that fiber's `Exit`, or
 * `"hung"` after 5 s of real time (these tests run under `it.live`): a
 * regression that hangs fails promptly instead of timing out. Only the wait
 * for the fiber is timed out, so an effect that hangs and ignores
 * interruption can't hold the timeout up, as it would hold up
 * `Effect.timeout` on the effect itself. An interruption the effect raises
 * against its own fiber (`Fiber.getCurrent()`) lands in the `Exit`.
 */
const exitOrHung = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<Exit.Exit<A, E> | "hung"> =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkDetach(effect);
    const settled = yield* Effect.timeoutOption(Fiber.await(fiber), "5 seconds");
    return Option.getOrElse(settled, () => "hung" as const);
  });

/** Settles as `effect` does, or with `"hung"`, as {@link exitOrHung} decides. */
const orHung = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A | "hung", E> =>
  Effect.gen(function* () {
    const outcome = yield* exitOrHung(effect);
    return outcome === "hung" ? outcome : yield* outcome;
  });

/** {@link orHung} for a promise a Node stream or callback settles. */
const promiseOrHung = <A>(promise: Promise<A>): Effect.Effect<A | "hung", Cause.UnknownError> =>
  orHung(Effect.tryPromise(() => promise));

/**
 * Runs `body`, then fails if an uncaught exception surfaced while it ran: an
 * `error` event nobody listened for, which would crash a real process. The
 * listener makes the test fail on its own (Vitest would otherwise only fail
 * the run, unattributed).
 */
const withoutUncaught = <A, E>(body: Effect.Effect<A, E>): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    const uncaught = collectProcessEvents("uncaughtException");
    yield* body;
    yield* Effect.sleep("20 millis"); // let any error event surface
    expect(uncaught).toEqual([]);
  });

// ── File source + decompression ──────────────────────────────────────────

describe("fromFile", () => {
  it.live("reads a plain file as bytes", () =>
    Effect.gen(function* () {
      const path = join(tmp, "plain.ndjson");
      writeFileSync(path, DUMP);
      const bytes = yield* Stream.runCollect(Dumps.fromFile(path));
      expect(decodeUtf8(bytes)).toBe(DUMP);
    }),
  );

  it.live("auto-detects gzip from a .gz extension", () =>
    Effect.gen(function* () {
      const path = join(tmp, "auto.json.gz");
      writeFileSync(path, gzipSync(Buffer.from(DUMP)));
      const bytes = yield* Stream.runCollect(Dumps.fromFile(path));
      expect(decodeUtf8(bytes)).toBe(DUMP);
    }),
  );

  it.live("uses an explicit decompressor when given", () =>
    Effect.gen(function* () {
      const path = join(tmp, "explicit.bin");
      writeFileSync(path, gzipSync(Buffer.from(DUMP)));
      const bytes = yield* Stream.runCollect(
        Dumps.fromFile(path, { decompressor: Dumps.gunzipTransform }),
      );
      expect(decodeUtf8(bytes)).toBe(DUMP);
    }),
  );

  it.live("destroys the decompressor when opening the file throws", () =>
    Effect.gen(function* () {
      // A NUL byte in the path makes `createReadStream` throw synchronously,
      // after the decompressor was created.
      const created = { stage: Option.none<PassThrough>() };
      assertInstanceOf(
        yield* Effect.flip(
          Stream.runDrain(
            Dumps.fromFile(join(tmp, "bad\0path.gz"), {
              decompressor: () => {
                const stage = new PassThrough();
                created.stage = Option.some(stage);
                return stage;
              },
            }),
          ),
        ),
        Dumps.SourceError,
      );
      expect(Option.map(created.stage, (stage) => stage.destroyed)).toEqual(Option.some(true));
    }),
  );
});

/**
 * A stage that errors in a later tick, after its output has ended, once the
 * stream has completed and nothing listens any more (#139).
 */
const lateErroringStage = (): PassThrough => {
  const stage = new PassThrough();
  stage.once("end", () =>
    setImmediate(() => stage.emit("error", new FakeFailure({ message: "late error" }))),
  );
  return stage;
};

describe("decompression stages", () => {
  it.live("gunzip stage decompresses a byte source that is not a file", () =>
    Effect.gen(function* () {
      const source = Dumps.fromNodeReadable(() => Readable.from([gzipSync(Buffer.from(DUMP))]));
      const bytes = yield* Stream.runCollect(source.pipe(Dumps.gunzip));
      expect(decodeUtf8(bytes)).toBe(DUMP);
    }),
  );

  it.live("decompressWith accepts an injected transform (the bz2 extension point)", () =>
    Effect.gen(function* () {
      // gzip stands in for an injected bzip2 transform — the point is that the
      // decompressor is a caller-supplied factory, not a bundled codec.
      const source = Dumps.fromNodeReadable(() => Readable.from([gzipSync(Buffer.from(DUMP))]));
      const bytes = yield* Stream.runCollect(
        source.pipe(Dumps.decompressWith(Dumps.gunzipTransform)),
      );
      expect(decodeUtf8(bytes)).toBe(DUMP);
    }),
  );

  it.live("survives a decompressWith stage that errors after its output ended", () =>
    withoutUncaught(
      Effect.gen(function* () {
        const source = Dumps.fromNodeReadable(() => Readable.from([Buffer.from(DUMP)]));
        const bytes = yield* Stream.runCollect(
          source.pipe(Dumps.decompressWith(lateErroringStage)),
        );
        expect(decodeUtf8(bytes)).toBe(DUMP);
      }),
    ),
  );
});

// ── bzip2 through a classic stream (#128) ────────────────────────────────

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/dumps/${name}`, import.meta.url));

/**
 * `entities-slice.ndjson`, bzip2-compressed: made with
 * `bzip2 -1 -c tests/fixtures/dumps/entities-slice.ndjson > tests/fixtures/dumps/entities-slice.ndjson.bz2`
 * (bzip2 1.0.8). `-1` (100k blocks) rather than the default `-9` (900k)
 * only changes the header's block-size digit, since the slice fits in one
 * block either way; it lowers the input `unbzip2-stream` buffers before it
 * decodes during `write()` from about 925 kB to 125 kB, so the multi-stream
 * test below reaches that path with a small input.
 */
const SLICE_BZ2 = fixturePath("entities-slice.ndjson.bz2");
const SLICE = readFileSync(fixturePath("entities-slice.ndjson"), "utf8");

/** Whether a classic `through` stream, which has no `destroyed`, has been destroyed. */
const throughDestroyed = (stream: LegacyStream & { readable: boolean; writable: boolean }) =>
  !stream.readable && !stream.writable;

/**
 * A hand-built classic duplex: a legacy `Stream` with the given `write`,
 * which keeps none of the streams2 state (`_readableState` /
 * `_writableState`) the adapter checks for, as `unbzip2-stream`'s keeps
 * none. Its `destroyed` flag and empty async iterator are only there to
 * meet {@link Dumps.NodeDuplexLike}: nothing iterates a stage.
 */
const classicStream = (
  write: (this: LegacyStream) => void,
): LegacyStream & { readable: boolean; writable: boolean } & Dumps.NodeDuplexLike => {
  const stream = Object.assign(new LegacyStream(), {
    readable: true,
    writable: true,
    destroyed: false,
    write,
    end: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    destroy: () => {
      stream.readable = stream.writable = false;
      stream.destroyed = true;
      stream.emit("close");
    },
    [Symbol.asyncIterator]: () => Readable.from([])[Symbol.asyncIterator](),
  });
  return stream;
};

/** A classic stage's `write`, which throws as `unbzip2-stream`'s does on corrupt input. */
const explodingWrite = (): never => {
  throw new FakeFailure({ message: "write exploded" });
};

describe("bzip2 through unbzip2-stream, a classic stream (#128)", () => {
  // `unbzip2-stream` returns a classic `through` stream: no `read()`, and
  // `end` / `close` but never `finish`, so `stream.compose` failed it with
  // "Premature close". The stage is adapted into a streams2 Duplex first.
  it.live("streams a .bz2 dump through fromFile to its entities", () =>
    Effect.gen(function* () {
      const ids = yield* Stream.runCollect(
        Dumps.fromFile(SLICE_BZ2, { decompressor: () => unbzip2() }).pipe(
          Dumps.entityRecords,
          Dumps.onlyEntities,
          Stream.map((item) => item.id),
        ),
      );
      expect(ids).toEqual(["Q1", "Q42", "Q64", "P31", "Q5"]);
    }),
  );

  it.live("streams a .bz2 source through decompressWith to its bytes", () =>
    Effect.gen(function* () {
      const source = Dumps.fromNodeReadable(() => createReadStream(SLICE_BZ2));
      const bytes = yield* Stream.runCollect(source.pipe(Dumps.decompressWith(() => unbzip2())));
      expect(decodeUtf8(bytes)).toBe(SLICE);
    }),
  );

  it.live("decodes a multi-stream input without a hang", () =>
    Effect.gen(function* () {
      // Concatenated bzip2 streams (what parallel compressors such as `pbzip2`
      // write), in one 212 kB chunk: past 125 kB of input the decoder decodes
      // inside `write()`, and that one write's output outruns the adapter's
      // buffer, so a write left waiting on a `drain` that never comes would
      // hang here.
      const copies = 400;
      const compressed = readFileSync(SLICE_BZ2);
      const source = Stream.make(
        new Uint8Array(Buffer.concat(Array.from({ length: copies }, () => compressed))),
      );
      const bytes = yield* orHung(
        Stream.runCollect(source.pipe(Dumps.decompressWith(() => unbzip2()))),
      );
      expect(bytes).not.toBe("hung");
      if (bytes === "hung") return;
      expect(decodeUtf8(bytes)).toBe(SLICE.repeat(copies));
    }),
  );

  it.live("stops writing to a classic stage while its output is unread", () =>
    Effect.gen(function* () {
      // Small chunks and a slow consumer: the adapter must pause the decoder
      // when its own buffer fills (so its `write()` returns `false`) and must
      // not write again until the decoder drains. Skipping either step leaves
      // memory unbounded for a slow consumer of a large dump.
      const copies = 400;
      const compressed = Buffer.concat(
        Array.from({ length: copies }, () => readFileSync(SLICE_BZ2)),
      );
      const chunks = Array.from(
        { length: Math.ceil(compressed.length / 4096) },
        (_, i) => new Uint8Array(compressed.subarray(i * 4096, (i + 1) * 4096)),
      );
      const stage = unbzip2();
      const write = stage.write.bind(stage);
      let refused = 0;
      let writesWhilePaused = 0;
      // unbzip2-stream's `through` stream carries a `paused` flag its type
      // declarations omit, so it is read through a guard.
      const through: unknown = stage;
      const paused = (): boolean => P.hasProperty(through, "paused") && through.paused === true;
      vi.spyOn(stage, "write").mockImplementation((chunk: Uint8Array) => {
        if (paused()) writesWhilePaused++;
        const accepted = write(chunk);
        if (!accepted) refused++;
        return accepted;
      });
      const bytes = yield* orHung(
        Stream.runCollect(
          Stream.fromIterable(chunks).pipe(
            Dumps.decompressWith(() => stage),
            Stream.tap(() => Effect.tryPromise(() => wait(0))),
          ),
        ),
      );
      expect(bytes).not.toBe("hung");
      if (bytes === "hung") return;
      expect(decodeUtf8(bytes)).toBe(SLICE.repeat(copies));
      expect(refused).toBeGreaterThan(0);
      expect(writesWhilePaused).toBe(0);
    }),
  );

  // The decoder reports truncated input with the `TypeError` its bit reader
  // throws on running out of bytes, so that case pins only the prefix.
  it.live.each([
    {
      label: "corrupt",
      input: Buffer.from("BZh1 is not bzip2 data, though it starts like it"),
      message: "not valid bzip",
    },
    {
      label: "truncated",
      input: readFileSync(SLICE_BZ2).subarray(0, -8),
      message: "dumps/source-read-failed: ",
    },
  ])("fails with a SourceError on $label input", ({ input, message }) =>
    Effect.gen(function* () {
      const source = Stream.make(new Uint8Array(input));
      yield* withoutUncaught(
        Effect.gen(function* () {
          const error = yield* failsPromptly(source.pipe(Dumps.decompressWith(() => unbzip2())));
          expect(error).toMatchObject({ description: expect.stringContaining(message) });
        }),
      );
    }),
  );

  it.live("fails with a SourceError when a classic stage's write() throws", () =>
    Effect.gen(function* () {
      const stage = classicStream(explodingWrite);
      const error = yield* failsPromptly(
        Stream.make(new Uint8Array([1])).pipe(Dumps.decompressWith(() => stage)),
      );
      expect(error).toMatchObject({ description: expect.stringContaining("write exploded") });
      expect(throughDestroyed(stage)).toBe(true);
    }),
  );

  it.live("fails with a SourceError when a classic stage closes before its output ends", () =>
    Effect.gen(function* () {
      const stage = classicStream(function () {
        this.emit("close");
        return true;
      });
      const error = yield* failsPromptly(
        Stream.make(new Uint8Array([1])).pipe(Dumps.decompressWith(() => stage)),
      );
      expect(error).toMatchObject({ description: expect.stringContaining("closed before") });
    }),
  );

  it.live("rejects a classic stage that has already ended", () =>
    Effect.gen(function* () {
      const stage = unbzip2();
      stage.end();
      const error = yield* failsPromptly(Dumps.fromFile(SLICE_BZ2, { decompressor: () => stage }));
      expect(error).toMatchObject({
        description: expect.stringContaining("neither destroyed nor ended"),
      });
    }),
  );
});

// ── Structural stream types ──────────────────────────────────────────────

describe("structural stream types", () => {
  // The public signatures name `NodeReadableLike` / `NodeDuplexLike` rather
  // than `node:stream` classes, so the published declarations need no
  // `@types/node` (#73). These pin that real Node streams still fit them.
  it("accept real Node readables", () => {
    expectTypeOf<ReturnType<typeof createReadStream>>().toExtend<Dumps.NodeReadableLike>();
    expectTypeOf<ReturnType<typeof Readable.from>>().toExtend<Dumps.NodeReadableLike>();
    expectTypeOf<ReturnType<typeof createGunzip>>().toExtend<Dumps.NodeReadableLike>();
    expectTypeOf<ReturnType<typeof compose>>().toExtend<Dumps.NodeReadableLike>();
    expectTypeOf<Readable>().toExtend<Dumps.NodeReadableLike>();
    expectTypeOf<TrackedGzSource>().toExtend<Dumps.NodeReadableLike>();
  });

  it("accept real Node duplexes and transforms as decompressors", () => {
    expectTypeOf<ReturnType<typeof createGunzip>>().toExtend<Dumps.NodeDuplexLike>();
    expectTypeOf<Duplex>().toExtend<Dumps.NodeDuplexLike>();
    expectTypeOf<Transform>().toExtend<Dumps.NodeDuplexLike>();
    expectTypeOf<PassThrough>().toExtend<Dumps.NodeDuplexLike>();
    expectTypeOf(() => createGunzip()).toExtend<Dumps.Decompressor>();
    expectTypeOf(() => new PassThrough()).toExtend<Dumps.Decompressor>();
    // A readable-only stream is not a decompressor: it has no writable side.
    expectTypeOf<Readable>().not.toExtend<Dumps.NodeDuplexLike>();
  });

  it.live("runs a caller-supplied Transform that is not a zlib stream", () =>
    Effect.gen(function* () {
      // An identity stage: the point is a plain `stream.Transform` subclass,
      // the shape a third-party bzip2 decoder has, through `decompressWith`.
      const source = Dumps.fromNodeReadable(() => Readable.from([Buffer.from(DUMP)]));
      const bytes = yield* Stream.runCollect(
        source.pipe(Dumps.decompressWith(() => new PassThrough())),
      );
      expect(decodeUtf8(bytes)).toBe(DUMP);
    }),
  );
});

/**
 * A value that fits {@link Dumps.NodeDuplexLike} but is not a Node stream: it
 * has none of the internals `stream.compose` relies on, so composing it would
 * hang rather than fail.
 */
const fakeDuplex = (): Dumps.NodeDuplexLike => ({
  destroyed: false,
  destroy: () => undefined,
  write: () => true,
  end: () => undefined,
  async *[Symbol.asyncIterator]() {},
});

/**
 * Drains `stream`, expecting it to fail with a {@link Dumps.SourceError}, and
 * returns that error. A stage the runtime fails to reject can leave the
 * stream never settling and ignoring interruption, so `Effect.timeout` can't
 * bound it; racing a timer turns a regression into a prompt failure instead
 * of a test timeout.
 */
const failsPromptly = <A, E>(stream: Stream.Stream<A, E>): Effect.Effect<Dumps.SourceError, void> =>
  Effect.gen(function* () {
    const outcome = yield* exitOrHung(Stream.runDrain(stream));
    if (outcome === "hung") return expect.unreachable("the stream hung instead of failing");
    const error = yield* Effect.flip(outcome);
    assertInstanceOf(error, Dumps.SourceError);
    return error;
  });

describe("a decompressor that is not a Node stream", () => {
  // The structural type admits it, so the runtime must reject it.
  it.live("fails fromFile with a SourceError", () =>
    Effect.gen(function* () {
      const path = join(tmp, "fake-decompressor.bin");
      writeFileSync(path, gzipSync(Buffer.from(DUMP)));
      const error = yield* failsPromptly(Dumps.fromFile(path, { decompressor: fakeDuplex }));
      expect(error).toMatchObject({ description: expect.stringContaining("Node stream") });
    }),
  );

  it.live("fails decompressWith with a SourceError", () =>
    Effect.gen(function* () {
      const source = Dumps.fromNodeReadable(() => Readable.from([gzipSync(Buffer.from(DUMP))]));
      const error = yield* failsPromptly(source.pipe(Dumps.decompressWith(fakeDuplex)));
      expect(error).toMatchObject({ description: expect.stringContaining("Node stream") });
    }),
  );

  it.live("rejects decompressWith's stage before it starts the upstream source", () =>
    Effect.gen(function* () {
      // The stage is checked before the source is started, as `fromFile` checks
      // it before opening its file, so a rejected stage opens nothing that
      // teardown would have to close (an HTTP body, a file). Whether a source
      // started and cancelled at once ever opens differs by Effect version
      // (#235), so the check must come first for this to hold on every one.
      let opened = false;
      const source = Dumps.fromNodeReadable(() => {
        opened = true;
        return new Readable({ read() {} });
      });
      yield* failsPromptly(source.pipe(Dumps.decompressWith(fakeDuplex)));
      yield* Effect.sleep("20 millis"); // give a source started in the background time to open
      expect(opened).toBe(false);
    }),
  );

  it.live("fails without an unhandled rejection when the upstream has already failed", () =>
    Effect.gen(function* () {
      // A source that fails as it starts leaves the bridged web stream errored,
      // so cancelling it rejects; that rejection must not escape. The listener
      // makes this test fail on its own (Vitest would otherwise only fail the
      // run, unattributed).
      const unhandled = collectProcessEvents("unhandledRejection");
      const error = yield* failsPromptly(
        Stream.fail("boom").pipe(Dumps.decompressWith(fakeDuplex)),
      );
      expect(error).toMatchObject({ description: expect.stringContaining("Node stream") });
      yield* Effect.sleep("20 millis"); // let any rejection surface
      expect(unhandled).toEqual([]);
    }),
  );
});

describe("a decompressor that returns a used stream", () => {
  // `isReadable` / `isWritable` give `false`, not `null`, for a used stage, so
  // the not-a-stream check let it through (#111). `compose` then throws on a
  // destroyed stage or one whose input has ended, but only once the upstream
  // has been opened, which leaked; and it accepts one whose output has
  // already ended, which never settles. The stage must be rejected before
  // anything is opened, and a `compose` that throws anyway must release what
  // it was given. Each case builds its stage before the stream runs.
  const usedStages: ReadonlyArray<readonly [string, () => Promise<Duplex>]> = [
    [
      "destroyed",
      async () => {
        const stage = createGunzip();
        stage.destroy();
        return stage;
      },
    ],
    ["ended", async () => new PassThrough().end()],
    [
      "read to its end",
      async () => {
        const stage = new Duplex({ read() {}, write: (_chunk, _encoding, done) => done() });
        stage.push(null);
        stage.resume();
        await new Promise((resolve) => stage.once("end", resolve));
        return stage;
      },
    ],
  ];

  it.live.each(usedStages)(
    "fails decompressWith with a SourceError and opens no upstream when the stage is %s",
    ([, used]) =>
      Effect.gen(function* () {
        const stage = yield* Effect.tryPromise(used);
        let opened = false;
        const source = Dumps.fromNodeReadable(() => {
          opened = true;
          return new Readable({ read() {} });
        });
        yield* withoutUncaught(
          Effect.gen(function* () {
            const error = yield* failsPromptly(source.pipe(Dumps.decompressWith(() => stage)));
            expect(error).toMatchObject({
              description: expect.stringContaining("neither destroyed nor ended"),
            });
          }),
        );
        expect(opened).toBe(false);
      }),
  );

  it.live.each(usedStages)(
    "fails fromFile with a SourceError and leaks no file descriptor when the stage is %s",
    ([, used]) =>
      Effect.gen(function* () {
        const stage = yield* Effect.tryPromise(used);
        const path = join(tmp, "used-decompressor.bin");
        writeFileSync(path, gzipSync(Buffer.from(DUMP)));
        // Every `fs.ReadStream` calls `_construct`, which opens the file, on a
        // `nextTick` after it is constructed; collect the ones for this path to
        // check each is closed again.
        const construct = vi.spyOn(ReadStream.prototype, "_construct");
        const opened = (): ReadonlyArray<ReadStream> =>
          construct.mock.contexts.filter(
            (context): context is ReadStream =>
              context instanceof ReadStream && context.path === path,
          );
        onTestFinished(() => construct.mockRestore());
        yield* withoutUncaught(
          Effect.gen(function* () {
            const error = yield* failsPromptly(Dumps.fromFile(path, { decompressor: () => stage }));
            yield* Effect.sleep("1 millis"); // let any `_construct` tick run
            const closed = opened().map((file) =>
              file.closed
                ? Promise.resolve("closed" as const)
                : new Promise<"closed">((resolve) => file.once("close", () => resolve("closed"))),
            );
            expect(yield* promiseOrHung(Promise.all(closed))).not.toBe("hung");
            // Rejected before the file is opened at all.
            expect(opened()).toEqual([]);
            expect(error).toMatchObject({
              description: expect.stringContaining("neither destroyed nor ended"),
            });
          }),
        );
      }),
  );
});

// ── Interruption teardown ────────────────────────────────────────────────

/** A Node Readable that emits gzip data forever and records whether it was destroyed. */
class TrackedGzSource extends Readable {
  private readonly chunk = gzipSync(Buffer.from("x".repeat(1024)));
  override _read(): void {
    setTimeout(() => this.push(this.chunk), 5);
  }
}

/**
 * A Readable that never pushes, and a promise that settles on its first
 * `read()`. Node's async iterator calls `read()` from inside `next()`, so
 * once `reading` settles a `next()` is pending that no data will settle.
 */
interface StalledReadable {
  /** The Readable, which never pushes. */
  readonly readable: Readable;
  /** Settles on the Readable's first `read()`. */
  readonly reading: Promise<void>;
}
/** A Readable that never pushes, paired with the promise that settles on its first `read()`. */
const stalledReadable = (options: { readonly emitClose?: boolean } = {}): StalledReadable => {
  let onRead = noop;
  const reading = new Promise<void>((resolve) => (onRead = resolve));
  return { readable: new Readable({ ...options, read: () => onRead() }), reading };
};

/**
 * Interrupts the drain of `stream` once `reading` settles and asserts the
 * interrupt returns promptly. A stalled Readable's async iterator queues
 * `return()` behind the pending `next()`, so a teardown that waits on
 * `return()` before destroying hangs (#83). Interrupting only once `reading`
 * settles makes the test exercise that pending `next()` rather than pass
 * before the drain reaches it.
 */
const interruptsPromptly = <A, E>(
  stream: Stream.Stream<A, E>,
  reading: Promise<void>,
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkDetach(Stream.runDrain(stream));
    expect(yield* promiseOrHung(reading)).toBeUndefined();
    const outcome = yield* orHung(Fiber.interrupt(fiber).pipe(Effect.as("interrupted" as const)));
    expect(outcome).toBe("interrupted");
  });

describe("interruption teardown", () => {
  it.live("destroys the decompression source when the Effect is interrupted", () =>
    Effect.gen(function* () {
      const source = new TrackedGzSource();
      const program = Stream.runDrain(
        Dumps.fromNodeReadable(() => source).pipe(
          Dumps.gunzip,
          Stream.decodeText(),
          Stream.splitLines,
        ),
      );
      const fiber = yield* Effect.forkDetach(program);
      yield* Effect.sleep("120 millis");
      yield* Fiber.interrupt(fiber);
      yield* Effect.sleep("60 millis");
      expect(source.destroyed).toBe(true);
    }),
  );

  it.live("destroys a stalled Readable when the Effect is interrupted", () =>
    Effect.gen(function* () {
      const { readable, reading } = stalledReadable();
      yield* interruptsPromptly(
        Dumps.fromNodeReadable(() => readable),
        reading,
      );
      expect(readable.destroyed).toBe(true);
    }),
  );

  it.live(
    "destroys a stalled source behind a decompression stage when the Effect is interrupted",
    () =>
      Effect.gen(function* () {
        const { readable, reading } = stalledReadable();
        yield* interruptsPromptly(
          Dumps.fromNodeReadable(() => readable).pipe(Dumps.gunzip),
          reading,
        );
        expect(readable.destroyed).toBe(true);
      }),
  );

  // Node's iterator settles its pending `next()`, and so the queued
  // `return()`, only on `close`. A source whose `destroy()` never gets there
  // would hold the interrupt up for good, so teardown waits for `close` only
  // up to a bound (#94); these fail with "hung" without it.
  it.live(
    "completes the interrupt within a bound when the stalled Readable's destroy() never emits close",
    () =>
      Effect.gen(function* () {
        const { readable, reading } = stalledReadable({ emitClose: false });
        yield* interruptsPromptly(
          Dumps.fromNodeReadable(() => readable),
          reading,
        );
        expect(readable.destroyed).toBe(true);
      }),
  );

  // `mkfifo` is POSIX-only; CI runs on Linux.
  it.live.skipIf(process.platform === "win32")(
    "completes the interrupt within a bound on a fromFile read of a FIFO whose writer is idle",
    () =>
      Effect.gen(function* () {
        // `fs.ReadStream`'s `destroy()` waits for its in-flight read, which an
        // open writer that writes nothing never lets return. Opening the FIFO
        // read-write first holds a writer, so the source's open doesn't block.
        const fifo = join(tmp, "idle.fifo");
        execFileSync("mkfifo", [fifo]);
        const writer = openSync(fifo, "r+");
        // `_read` dispatches the blocking read, so once it has been called a read
        // is in flight and the drain's `next()` is pending on it.
        const read = vi.spyOn(ReadStream.prototype, "_read");
        const reading = vi.waitFor(() => expect(read).toHaveBeenCalled(), { timeout: 5000 });
        const stream = (): Option.Option<ReadStream> =>
          Option.filter(
            Option.fromUndefinedOr(read.mock.contexts[0]),
            (context): context is ReadStream => context instanceof ReadStream,
          );
        // Runs when the test's scope closes, after it passes or fails.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const source = stream();
            read.mockRestore();
            // With no writer left the read returns end-of-file and the stream
            // finishes closing: the fd is released after all, just not before the
            // interrupt returned.
            const closed = Option.match(source, {
              onNone: () => Promise.resolve("closed" as const),
              onSome: (open) =>
                open.closed
                  ? Promise.resolve("closed" as const)
                  : new Promise<"closed">((resolve) => open.once("close", () => resolve("closed"))),
            });
            closeSync(writer);
            expect(yield* promiseOrHung(closed)).toBe("closed");
          }).pipe(Effect.orDie),
        );
        yield* interruptsPromptly(
          Dumps.fromFile(fifo),
          reading.then(() => undefined),
        );
        expect(Option.map(stream(), (source) => source.destroyed)).toEqual(Option.some(true));
      }),
  );

  it.live("waits for a slow-closing Readable to close before the interrupt returns", () =>
    Effect.gen(function* () {
      // `_destroy` finishes 200 ms after `destroy()`: inside the bound, so the
      // interrupt must wait for it; a near-zero bound would return first.
      let onRead = noop;
      const reading = new Promise<void>((resolve) => (onRead = resolve));
      const readable = new Readable({
        read: () => onRead(),
        destroy: (error, callback) => void setTimeout(() => callback(error), 200),
      });
      yield* interruptsPromptly(
        Dumps.fromNodeReadable(() => readable),
        reading,
      );
      expect(readable.closed).toBe(true);
    }),
  );

  it.live("swallows the delegated return()'s rejection when it settles after the bound", () =>
    Effect.gen(function* () {
      // A source whose `return()` outlives the bound and then rejects: the
      // interrupt has already completed, so the rejection has nowhere to go and
      // must not escape as an unhandled rejection.
      const unhandled = collectProcessEvents("unhandledRejection");
      let destroyed = false;
      let rejectReturn: (error: Error) => void = noop;
      let onRead = noop;
      const reading = new Promise<void>((resolve) => (onRead = resolve));
      const source: Dumps.NodeReadableLike = {
        get destroyed() {
          return destroyed;
        },
        destroy: () => (destroyed = true),
        [Symbol.asyncIterator]: () => ({
          next: () => {
            onRead();
            return new Promise<IteratorResult<Uint8Array>>(() => undefined);
          },
          return: () =>
            new Promise<IteratorResult<Uint8Array>>((_, reject) => (rejectReturn = reject)),
        }),
      };
      yield* interruptsPromptly(
        Dumps.fromNodeReadable(() => source),
        reading,
      );
      expect(destroyed).toBe(true);
      rejectReturn(new FakeFailure({ message: "closed too late" }));
      yield* Effect.sleep("20 millis"); // let any rejection surface
      expect(unhandled).toEqual([]);
    }),
  );

  it.live(
    "destroys the Readable when interrupted before the iterator's return() is registered",
    () =>
      Effect.gen(function* () {
        // `Stream.fromAsyncIterable` registers `return()` as a finalizer only
        // after creating the iterator, so an interruption that lands between
        // `fromNodeReadable`'s own finalizer and that registration is covered by
        // the scope finalizer alone. Interrupting from inside the iterator's
        // creation lands it there deterministically: the fiber observes it at its
        // next step, before the registration.
        class InterruptsOnIterate extends Readable {
          override [Symbol.asyncIterator]() {
            Fiber.getCurrent()?.interruptUnsafe();
            return super[Symbol.asyncIterator]();
          }
        }
        const readable = new InterruptsOnIterate({ read() {} });
        const exit = yield* exitOrHung(Stream.runDrain(Dumps.fromNodeReadable(() => readable)));
        expect(exit).not.toBe("hung");
        if (exit === "hung") return;
        expect(Exit.hasInterrupts(exit)).toBe(true);
        expect(readable.destroyed).toBe(true);
      }),
  );

  it.live("destroys a hand-built source whose iterator's return() doesn't, exactly once", () =>
    Effect.gen(function* () {
      // A Node Readable's own iterator destroys the stream in `return()`, which
      // would mask a teardown that never calls `destroy()` (#80). This source's
      // `return()` leaves it open, so only `fromNodeReadable`'s teardown can
      // destroy it; and `fromNodeReadable`'s wrapping `return()` and its scope
      // finalizer both run, so the `destroyed` guard is what keeps it to one
      // `destroy()`.
      let destroyCalls = 0;
      let pulled = 0;
      let onThirdPull = noop;
      const thirdPull = new Promise<void>((resolve) => (onThirdPull = resolve));
      const source: Dumps.NodeReadableLike = {
        get destroyed() {
          return destroyCalls > 0;
        },
        destroy: () => (destroyCalls += 1),
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            pulled += 1;
            if (pulled === 3) onThirdPull();
            await wait(5);
            return { done: false, value: new Uint8Array([pulled]) };
          },
          return: () => Promise.resolve({ done: true as const, value: undefined }),
        }),
      };
      const fiber = yield* Effect.forkDetach(Stream.runDrain(Dumps.fromNodeReadable(() => source)));
      expect(yield* promiseOrHung(thirdPull)).toBeUndefined();
      const exit = yield* orHung(Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))));
      expect(exit).not.toBe("hung");
      if (exit === "hung") return;
      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(destroyCalls).toBe(1);
    }),
  );

  it.live("destroys the Readable when interrupted as soon as evaluate returns it", () =>
    Effect.gen(function* () {
      // An interruption the fiber observes right after `evaluate` returns, before
      // anything else runs, must still destroy the Readable: opening it and
      // registering its teardown are one uninterruptible step (#95). Interrupting
      // from inside `evaluate` lands it there deterministically.
      const readable = new Readable({ read() {} });
      const exit = yield* exitOrHung(
        Stream.runDrain(
          Dumps.fromNodeReadable(() => {
            Fiber.getCurrent()?.interruptUnsafe();
            return readable;
          }),
        ),
      );
      expect(exit).not.toBe("hung");
      if (exit === "hung") return;
      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(readable.destroyed).toBe(true);
    }),
  );

  it.live(
    "releases decompressWith's upstream source when interrupted before the stage is opened",
    () =>
      Effect.gen(function* () {
        // Bridging the source to a web stream starts it on a fiber of its own,
        // which only cancelling the web stream stops. An interruption that lands
        // after the source has started but before `fromNodeReadable` opens the
        // stage must still stop it, or the upstream (an HTTP body, which parks
        // holding its socket once a chunk is buffered) stays open (#109). The
        // source's first step interrupts the consuming fiber, which lands the
        // interruption in that window deterministically; the source then parks.
        const fibers = { outer: Option.none<Fiber.Fiber<unknown, unknown>>() };
        let started = false;
        let onReleased = noop;
        const released = new Promise<"released">(
          (resolve) => (onReleased = () => resolve("released")),
        );
        const source = Stream.fromEffect(
          Effect.sync(() => {
            started = true;
            Option.map(fibers.outer, (outer) => outer.interruptUnsafe());
            return new Uint8Array(gzipSync(Buffer.from(DUMP)));
          }),
        ).pipe(Stream.concat(Stream.never), Stream.ensuring(Effect.sync(() => onReleased())));
        const stream = Stream.unwrap(
          Effect.sync(() => {
            fibers.outer = Option.fromUndefinedOr(Fiber.getCurrent());
            return source.pipe(Dumps.decompressWith(Dumps.gunzipTransform));
          }),
        );
        yield* withoutUncaught(
          Effect.gen(function* () {
            const exit = yield* exitOrHung(Stream.runDrain(stream));
            expect(exit).not.toBe("hung");
            if (exit === "hung") return;
            expect(started).toBe(true);
            expect(Exit.hasInterrupts(exit)).toBe(true);
            expect(yield* promiseOrHung(released)).toBe("released");
          }),
        );
      }),
  );

  it.live(
    "destroys a classic bzip2 stage behind decompressWith, without an uncaught error, when interrupted while stalled",
    () =>
      Effect.gen(function* () {
        const { readable, reading } = stalledReadable();
        const stage = unbzip2();
        yield* withoutUncaught(
          interruptsPromptly(
            Dumps.fromNodeReadable(() => readable).pipe(Dumps.decompressWith(() => stage)),
            reading,
          ),
        );
        expect(readable.destroyed).toBe(true);
        expect(throughDestroyed(stage)).toBe(true);
      }),
  );

  it.live(
    "destroys a classic bzip2 stage behind fromFile, without an uncaught error, when interrupted as soon as it is opened",
    () =>
      Effect.gen(function* () {
        // As the gzip case below: the scope finalizer destroys the chain before
        // it is first pulled, and the adapter must pass that on to the classic
        // stream it wraps.
        const stages: Array<ReturnType<typeof unbzip2>> = [];
        const decompressor = () => {
          Fiber.getCurrent()?.interruptUnsafe();
          const stage = unbzip2();
          stages.push(stage);
          return stage;
        };
        yield* withoutUncaught(
          Effect.gen(function* () {
            const exit = yield* exitOrHung(
              Stream.runDrain(Dumps.fromFile(SLICE_BZ2, { decompressor })),
            );
            expect(exit).not.toBe("hung");
            if (exit === "hung") return;
            expect(Exit.hasInterrupts(exit)).toBe(true);
          }),
        );
        expect(stages.length).toBe(1);
        expect(stages.every(throughDestroyed)).toBe(true);
      }),
  );

  it.live(
    "destroys fromFile's decompression chain, without an uncaught error, when interrupted as soon as it is opened",
    () =>
      Effect.gen(function* () {
        // `fromFile` opens a `.gz` as a `stream.compose` chain, which emits an
        // `AbortError` when it is destroyed before it finishes. Destroyed by the
        // scope finalizer before the stream is first pulled, nothing listens for
        // that error, and a real process would crash on it (#109). The
        // decompressor interrupts the fiber, which lands the interruption right
        // after the open, as in the #95 test above.
        const path = join(tmp, "interrupted-open.json.gz");
        writeFileSync(path, gzipSync(Buffer.from(DUMP)));
        const created = { stage: Option.none<Transform>() };
        const decompressor = (): Transform => {
          Option.map(Option.fromUndefinedOr(Fiber.getCurrent()), (fiber) =>
            fiber.interruptUnsafe(),
          );
          const stage = createGunzip();
          created.stage = Option.some(stage);
          return stage;
        };
        yield* withoutUncaught(
          Effect.gen(function* () {
            const exit = yield* exitOrHung(Stream.runDrain(Dumps.fromFile(path, { decompressor })));
            expect(exit).not.toBe("hung");
            if (exit === "hung") return;
            expect(Exit.hasInterrupts(exit)).toBe(true);
            expect(Option.map(created.stage, (stage) => stage.destroyed)).toEqual(
              Option.some(true),
            );
          }),
        );
      }),
  );
});

// ── Byte ranges of a file ────────────────────────────────────────────────

/** Writes the alphabet fixture to the temp directory and returns its path. */
const alphabetFile = (): string => {
  const file = join(tmp, "alphabet.txt");
  writeFileSync(file, "abcdefghijklmnopqrstuvwxyz");
  return file;
};

/** Reads the alphabet fixture through `Dumps.fromFile` with `options`, decoded as UTF-8. */
const readAlphabet = (options: Dumps.FromFileOptions): Effect.Effect<string, Dumps.SourceError> =>
  Effect.map(Stream.runCollect(Dumps.fromFile(alphabetFile(), options)), decodeUtf8);

describe("fromFile with a byte range", () => {
  it.live("reads [start, end) with end exclusive", () =>
    Effect.gen(function* () {
      expect(yield* readAlphabet({ start: 3, end: 6 })).toBe("def");
      expect(yield* readAlphabet({ start: 0, end: 1 })).toBe("a");
    }),
  );

  it.live("reads from start to the end of the file, or from the start to end", () =>
    Effect.gen(function* () {
      expect(yield* readAlphabet({ start: 23 })).toBe("xyz");
      expect(yield* readAlphabet({ end: 3 })).toBe("abc");
    }),
  );

  it.live("reads to the end of the file for an end past it", () =>
    Effect.gen(function* () {
      expect(yield* readAlphabet({ start: 24, end: 1000 })).toBe("yz");
    }),
  );

  it.live("decompresses one member of a concatenated gzip file on its own", () =>
    Effect.gen(function* () {
      const first = gzipSync(Buffer.from("first member"));
      const second = gzipSync(Buffer.from("second member"));
      const file = join(tmp, "members.gz");
      writeFileSync(file, Buffer.concat([first, second]));
      const bytes = yield* Stream.runCollect(
        Dumps.fromFile(file, { start: first.length, end: first.length + second.length }),
      );
      expect(decodeUtf8(bytes)).toBe("second member");
    }),
  );

  it.live("closes the ranged file read when the stream is torn down early", () =>
    Effect.gen(function* () {
      const file = join(tmp, "large.bin");
      writeFileSync(file, Buffer.alloc(1 << 20, 1));
      const reads = vi.spyOn(ReadStream.prototype, "_read");
      onTestFinished(() => reads.mockRestore());
      const first = yield* Stream.runCollect(
        Dumps.fromFile(file, { start: 1024, end: 1 << 19 }).pipe(Stream.take(1)),
      );
      expect(first).toHaveLength(1);
      const stream = reads.mock.contexts[0];
      expect(stream).toBeInstanceOf(ReadStream);
      expect(stream instanceof ReadStream && stream.destroyed).toBe(true);
    }),
  );

  it.live.each([
    { label: "a negative start", options: { start: -1 } },
    { label: "a fractional start", options: { start: 1.5 } },
    { label: "an end equal to start", options: { start: 4, end: 4 } },
    { label: "an end before start", options: { start: 4, end: 2 } },
    { label: "a fractional end", options: { end: 2.5 } },
  ])("fails with a SourceError for $label, before opening the file", ({ options }) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Stream.runDrain(Dumps.fromFile(join(tmp, "does-not-exist.txt"), options)),
      );
      assertInstanceOf(error, Dumps.SourceError);
      expect(error.description).toContain("dumps/invalid-byte-range");
    }),
  );
});

// ── Resumable HTTP range download ────────────────────────────────────────

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

/** A fetch stub over `Range` requests; `onCall` decides each response. */
const stubFetch = (onCall: (call: number, start: number) => Response) => {
  const ranges: string[] = [];
  const userAgents: Array<Option.Option<string>> = [];
  let call = 0;
  const fetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    const range = request.headers.get("range") ?? "";
    ranges.push(range);
    userAgents.push(Option.fromNullOr(request.headers.get("user-agent")));
    const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? "0");
    call += 1;
    return Promise.resolve(onCall(call, start));
  };
  return { ranges, userAgents, provideFetch: Effect.provideService(FetchHttpClient.Fetch, fetch) };
};

/** Downloads the stub dump over the enclosing block's `HttpClient`. */
const collectRange: Effect.Effect<
  ReadonlyArray<Uint8Array>,
  Dumps.SourceError,
  HttpClient.HttpClient
> = Stream.runCollect(Dumps.fromHttpRange("https://dumps.example.org/x.gz"));

// No time passes in these: the stub answers at once and a resume retries
// without a delay, so they run on the test services `layer` provides.
layer(FetchHttpClient.layer)("fromHttpRange", (it) => {
  it.effect("downloads a body with a bytes=0- range request", () =>
    Effect.gen(function* () {
      const encoder = new TextEncoder();
      const { ranges, provideFetch } = stubFetch(
        () => new Response(encoder.encode(ALPHABET), { status: 206 }),
      );
      const bytes = yield* collectRange.pipe(provideFetch);
      expect(decodeUtf8(bytes)).toBe(ALPHABET);
      expect(ranges).toEqual(["bytes=0-"]);
    }),
  );

  it.effect("resumes from the last received byte after a mid-stream failure", () =>
    Effect.gen(function* () {
      const encoder = new TextEncoder();
      const { ranges, provideFetch } = stubFetch((call, start) => {
        if (call === 1) {
          let pulls = 0;
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls += 1;
              if (pulls === 1) controller.enqueue(encoder.encode(ALPHABET.slice(0, 10)));
              else controller.error(new FakeFailure({ message: "connection reset" }));
            },
          });
          return new Response(body, { status: 206 });
        }
        return new Response(encoder.encode(ALPHABET.slice(start)), { status: 206 });
      });

      const bytes = yield* collectRange.pipe(provideFetch);
      expect(decodeUtf8(bytes)).toBe(ALPHABET);
      expect(ranges).toEqual(["bytes=0-", "bytes=10-"]);
    }),
  );

  it.effect("asks for bytes=start-(endByte - 1) and resumes inside the range", () =>
    Effect.gen(function* () {
      const encoder = new TextEncoder();
      const { ranges, provideFetch } = stubFetch((call, start) => {
        if (call === 1) {
          let pulls = 0;
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls += 1;
              if (pulls === 1) controller.enqueue(encoder.encode(ALPHABET.slice(5, 8)));
              else controller.error(new FakeFailure({ message: "connection reset" }));
            },
          });
          return new Response(body, { status: 206 });
        }
        return new Response(encoder.encode(ALPHABET.slice(start, 12)), { status: 206 });
      });
      const bytes = yield* Stream.runCollect(
        Dumps.fromHttpRange("https://dumps.example.org/x.bz2", { startByte: 5, endByte: 12 }),
      ).pipe(provideFetch);
      expect(decodeUtf8(bytes)).toBe("fghijkl");
      expect(ranges).toEqual(["bytes=5-11", "bytes=8-11"]);
    }),
  );

  it.effect("ends without a resume when the connection drops after the range's last byte", () =>
    Effect.gen(function* () {
      const encoder = new TextEncoder();
      const { ranges, provideFetch } = stubFetch(() => {
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) controller.enqueue(encoder.encode("abc"));
            else controller.error(new FakeFailure({ message: "connection reset" }));
          },
        });
        return new Response(body, { status: 206 });
      });
      const bytes = yield* Stream.runCollect(
        Dumps.fromHttpRange("https://dumps.example.org/x", { endByte: 3 }),
      ).pipe(provideFetch);
      expect(decodeUtf8(bytes)).toBe("abc");
      expect(ranges).toEqual(["bytes=0-2"]);
    }),
  );

  it.effect.each([
    { label: "a negative startByte", options: { startByte: -1 } },
    { label: "an endByte equal to startByte", options: { startByte: 3, endByte: 3 } },
    { label: "a fractional endByte", options: { endByte: 2.5 } },
  ])("fails with a SourceError for $label, before any request", ({ options }) =>
    Effect.gen(function* () {
      const { ranges, provideFetch } = stubFetch(() => new Response("abc", { status: 206 }));
      const error = yield* Effect.flip(
        Stream.runDrain(Dumps.fromHttpRange("https://dumps.example.org/x", options)).pipe(
          provideFetch,
        ),
      );
      assertInstanceOf(error, Dumps.SourceError);
      expect(error.description).toContain("dumps/invalid-byte-range");
      expect(ranges).toEqual([]);
    }),
  );

  it.effect("sends the package's default User-Agent when the caller sets none", () =>
    Effect.gen(function* () {
      const { userAgents, provideFetch } = stubFetch(() => new Response("abc", { status: 206 }));
      yield* collectRange.pipe(provideFetch);
      expect(userAgents).toEqual([Option.some(Core.USER_AGENT)]);
    }),
  );

  it.effect(
    "sends no Api-User-Agent: the dump host is not an API, unlike Core.WikimediaClient's",
    () =>
      Effect.gen(function* () {
        const apiUserAgents: Array<Option.Option<string>> = [];
        const fetch: typeof globalThis.fetch = (input, init) => {
          apiUserAgents.push(
            Option.fromNullOr(new Request(input, init).headers.get("api-user-agent")),
          );
          return Promise.resolve(new Response("abc", { status: 206 }));
        };
        yield* collectRange.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
        expect(apiUserAgents).toEqual([Option.none()]);
      }),
  );

  it.effect("sends the Core.UserAgent reference's value when one is provided", () =>
    Effect.gen(function* () {
      const userAgent = "my-bot/1.2 (bot@example.org)";
      const { userAgents, provideFetch } = stubFetch(() => new Response("abc", { status: 206 }));
      yield* Stream.runCollect(Dumps.fromHttpRange("https://dumps.example.org/x.gz")).pipe(
        provideFetch,
        Effect.provideService(Core.UserAgent, userAgent),
      );
      expect(userAgents).toEqual([Option.some(userAgent)]);
    }),
  );

  it.effect("sends the userAgent option, over the reference, on every resumed request", () =>
    Effect.gen(function* () {
      const userAgent = "my-dump-loader/2.0 (bot@example.org)";
      const encoder = new TextEncoder();
      const { userAgents, provideFetch } = stubFetch((call, start) => {
        if (call === 1) {
          let pulls = 0;
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls += 1;
              if (pulls === 1) controller.enqueue(encoder.encode(ALPHABET.slice(0, 10)));
              else controller.error(new FakeFailure({ message: "connection reset" }));
            },
          });
          return new Response(body, { status: 206 });
        }
        return new Response(encoder.encode(ALPHABET.slice(start)), { status: 206 });
      });
      const bytes = yield* Stream.runCollect(
        Dumps.fromHttpRange("https://dumps.example.org/x.gz", { userAgent }),
      ).pipe(
        provideFetch,
        Effect.provideService(Core.UserAgent, "ignored/0 (reference loses to the option)"),
      );
      expect(decodeUtf8(bytes)).toBe(ALPHABET);
      expect(userAgents).toEqual([Option.some(userAgent), Option.some(userAgent)]);
    }),
  );

  /** The `User-Agent` each of the two requests sent, once it has been sent. */
  interface SentUserAgents {
    client?: Option.Option<string>;
    dumps?: Option.Option<string>;
  }

  // One program that uses both the client and a dump download: where the
  // reference is provided decides which of the two sees it. Each test below
  // runs it in a block whose layer provides the reference its own way.
  const bothUserAgents = Effect.fn("bothUserAgents")(function* () {
    const userAgents: SentUserAgents = {};
    const fetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      const ua = request.headers.get("user-agent");
      if (request.url.startsWith("https://dumps.example.org/")) {
        userAgents.dumps = Option.fromNullOr(ua);
        return Promise.resolve(new Response("abc", { status: 206 }));
      }
      userAgents.client = Option.fromNullOr(ua);
      return Promise.resolve(new Response("ok", { status: 200 }));
    };
    yield* Effect.gen(function* () {
      const client = yield* Core.WikimediaClient;
      yield* client.getText({ host: "en.wikipedia.org", path: "/w/api.php", params: {} });
      yield* Stream.runCollect(Dumps.fromHttpRange("https://dumps.example.org/x.gz"));
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
    return userAgents;
  });

  const callerUserAgent = "my-bot/1.2 (bot@example.org)";

  it.layer(
    Core.wikimediaClientLayer.pipe(
      Layer.provideMerge(Layer.succeed(Core.UserAgent, callerUserAgent)),
    ),
  )((it) => {
    it.effect(
      "sends a Core.UserAgent given with Layer.provideMerge from both the client and the dump download",
      () =>
        Effect.gen(function* () {
          const sent = yield* bothUserAgents();
          expect(sent).toEqual({
            client: Option.some(callerUserAgent),
            dumps: Option.some(callerUserAgent),
          });
        }),
    );
  });

  it.layer(
    Core.wikimediaClientLayer.pipe(Layer.provide(Layer.succeed(Core.UserAgent, callerUserAgent))),
  )((it) => {
    it.effect("sends a Core.UserAgent given with Layer.provide from the client only", () =>
      Effect.gen(function* () {
        const sent = yield* bothUserAgents();
        expect(sent).toEqual({
          client: Option.some(callerUserAgent),
          dumps: Option.some(Core.USER_AGENT),
        });
      }),
    );
  });

  it.effect("fails once resumes are exhausted", () =>
    Effect.gen(function* () {
      const { provideFetch } = stubFetch(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.error(new FakeFailure({ message: "always fails" }));
              },
            }),
            { status: 206 },
          ),
      );
      const exit = yield* Effect.exit(
        Stream.runDrain(
          Dumps.fromHttpRange("https://dumps.example.org/x.gz", { maxResumes: 0 }),
        ).pipe(provideFetch),
      );
      expect(exit).toMatchObject({ _tag: "Failure" });
    }),
  );
});
