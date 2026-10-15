/**
 * Unit tests for the Node-only dump sources (`src/dumps/sources.ts`): the file
 * source with inline gzip decompression, the pluggable {@link Dumps.gunzip} /
 * {@link Dumps.decompressWith} stages (including bzip2 through `unbzip2-stream`,
 * a classic stream, #128), the **interruption teardown** guarantee
 * (cancelling the Effect destroys the decompression source — no orphaned
 * work), and the **resumable** HTTP range download (offset tracked across a
 * mid-stream failure). The network is stubbed at `FetchHttpClient.Fetch`.
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
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient } from "effect/http";
import { Core, Dumps } from "../../src/index.ts";
import { expectFailureInstanceOf, runTest, runTestExit } from "../helpers/effect.ts";

const DUMP = '[\n{"type":"item","id":"Q1"},\n{"type":"item","id":"Q2"}\n]\n';

let tmp: string;
beforeAll(() => (tmp = mkdtempSync(join(tmpdir(), "dumps-sources-"))));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const decodeUtf8 = (bytes: ReadonlyArray<Uint8Array>): string =>
  Buffer.concat(bytes.map((b) => Buffer.from(b))).toString("utf8");

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Settles as `promise` does, or with `"hung"` after 5 s, and clears the timer
 * either way: a regression that hangs fails promptly instead of timing out.
 */
const orHung = <A>(promise: Promise<A>): Promise<A | "hung"> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<"hung">((resolve) => {
    timer = setTimeout(() => resolve("hung"), 5000);
  });
  return Promise.race([promise, hung]).finally(() => clearTimeout(timer));
};

/**
 * Runs `body`, then fails if an uncaught exception surfaced while it ran: an
 * `error` event nobody listened for, which would crash a real process. The
 * listener makes the test fail on its own (Vitest would otherwise only fail
 * the run, unattributed).
 */
const withoutUncaught = async (body: () => Promise<void>): Promise<void> => {
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  try {
    await body();
    await wait(20); // let any error event surface
    expect(uncaught).toEqual([]);
  } finally {
    process.off("uncaughtException", onUncaught);
  }
};

// ── File source + decompression ──────────────────────────────────────────

describe("fromFile", () => {
  it("reads a plain file as bytes", async () => {
    const path = join(tmp, "plain.ndjson");
    writeFileSync(path, DUMP);
    const bytes = await runTest(Stream.runCollect(Dumps.fromFile(path)));
    expect(decodeUtf8(bytes)).toBe(DUMP);
  });

  it("auto-detects gzip from a .gz extension", async () => {
    const path = join(tmp, "auto.json.gz");
    writeFileSync(path, gzipSync(Buffer.from(DUMP)));
    const bytes = await runTest(Stream.runCollect(Dumps.fromFile(path)));
    expect(decodeUtf8(bytes)).toBe(DUMP);
  });

  it("uses an explicit decompressor when given", async () => {
    const path = join(tmp, "explicit.bin");
    writeFileSync(path, gzipSync(Buffer.from(DUMP)));
    const bytes = await runTest(
      Stream.runCollect(Dumps.fromFile(path, { decompressor: Dumps.gunzipTransform })),
    );
    expect(decodeUtf8(bytes)).toBe(DUMP);
  });

  it("destroys the decompressor when opening the file throws", async () => {
    // A NUL byte in the path makes `createReadStream` throw synchronously,
    // after the decompressor was created.
    let stage: PassThrough | undefined;
    await expectFailureInstanceOf(
      Stream.runDrain(
        Dumps.fromFile(join(tmp, "bad\0path.gz"), {
          decompressor: () => (stage = new PassThrough()),
        }),
      ),
      Dumps.SourceError,
    );
    expect(stage?.destroyed).toBe(true);
  });
});

describe("decompression stages", () => {
  it("gunzip stage decompresses a byte source that is not a file", async () => {
    const source = Dumps.fromNodeReadable(() => Readable.from([gzipSync(Buffer.from(DUMP))]));
    const bytes = await runTest(Stream.runCollect(source.pipe(Dumps.gunzip)));
    expect(decodeUtf8(bytes)).toBe(DUMP);
  });

  it("decompressWith accepts an injected transform (the bz2 extension point)", async () => {
    // gzip stands in for an injected bzip2 transform — the point is that the
    // decompressor is a caller-supplied factory, not a bundled codec.
    const source = Dumps.fromNodeReadable(() => Readable.from([gzipSync(Buffer.from(DUMP))]));
    const bytes = await runTest(
      Stream.runCollect(source.pipe(Dumps.decompressWith(Dumps.gunzipTransform))),
    );
    expect(decodeUtf8(bytes)).toBe(DUMP);
  });
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

describe("bzip2 through unbzip2-stream, a classic stream (#128)", () => {
  // `unbzip2-stream` returns a classic `through` stream: no `read()`, and
  // `end` / `close` but never `finish`, so `stream.compose` failed it with
  // "Premature close". The stage is adapted into a streams2 Duplex first.
  it("streams a .bz2 dump through fromFile to its entities", async () => {
    const ids = await runTest(
      Stream.runCollect(
        Dumps.fromFile(SLICE_BZ2, { decompressor: () => unbzip2() }).pipe(
          Dumps.entityRecords,
          Dumps.onlyEntities,
          Stream.map((item) => item.id),
        ),
      ),
    );
    expect(ids).toEqual(["Q1", "Q42", "Q64", "P31", "Q5"]);
  });

  it("streams a .bz2 source through decompressWith to its bytes", async () => {
    const source = Dumps.fromNodeReadable(() => createReadStream(SLICE_BZ2));
    const bytes = await runTest(
      Stream.runCollect(source.pipe(Dumps.decompressWith(() => unbzip2()))),
    );
    expect(decodeUtf8(bytes)).toBe(SLICE);
  });

  it("decodes a multi-stream input without a hang", async () => {
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
    const bytes = await orHung(
      runTest(Stream.runCollect(source.pipe(Dumps.decompressWith(() => unbzip2())))),
    );
    expect(bytes).not.toBe("hung");
    if (bytes === "hung") return;
    expect(decodeUtf8(bytes)).toBe(SLICE.repeat(copies));
  });

  it("stops writing to a classic stage while its output is unread", async () => {
    // Small chunks and a slow consumer: the adapter must pause the decoder
    // when its own buffer fills (so its `write()` returns `false`) and must
    // not write again until the decoder drains. Skipping either step leaves
    // memory unbounded for a slow consumer of a large dump.
    const copies = 400;
    const compressed = Buffer.concat(Array.from({ length: copies }, () => readFileSync(SLICE_BZ2)));
    const chunks = Array.from(
      { length: Math.ceil(compressed.length / 4096) },
      (_, i) => new Uint8Array(compressed.subarray(i * 4096, (i + 1) * 4096)),
    );
    const stage = unbzip2() as ReturnType<typeof unbzip2> & { paused: boolean };
    const write = stage.write.bind(stage);
    let refused = 0;
    let writesWhilePaused = 0;
    stage.write = ((chunk: Uint8Array) => {
      if (stage.paused) writesWhilePaused++;
      const accepted = write(chunk);
      if (accepted === false) refused++;
      return accepted;
    }) as typeof stage.write;
    const bytes = await orHung(
      runTest(
        Stream.runCollect(
          Stream.fromIterable(chunks).pipe(
            Dumps.decompressWith(() => stage),
            Stream.tap(() => Effect.promise(() => wait(0))),
          ),
        ),
      ),
    );
    expect(bytes).not.toBe("hung");
    if (bytes === "hung") return;
    expect(decodeUtf8(bytes)).toBe(SLICE.repeat(copies));
    expect(refused).toBeGreaterThan(0);
    expect(writesWhilePaused).toBe(0);
  });

  // The decoder reports truncated input with the `TypeError` its bit reader
  // throws on running out of bytes, so that case pins only the prefix.
  it.each([
    ["corrupt", Buffer.from("BZh1 is not bzip2 data, though it starts like it"), "not valid bzip"],
    ["truncated", readFileSync(SLICE_BZ2).subarray(0, -8), "dumps/source-read-failed: "],
  ])("fails with a SourceError on %s input", async (_, input, message) => {
    const source = Stream.make(new Uint8Array(input));
    await withoutUncaught(async () => {
      const error = await failsPromptly(source.pipe(Dumps.decompressWith(() => unbzip2())));
      expect(error).toMatchObject({ description: expect.stringContaining(message) });
    });
  });

  /**
   * A hand-built classic duplex: a legacy `Stream` with the given `write`. It
   * has no `destroyed` or async iterator, as `unbzip2-stream`'s has none
   * (its types claim a `Transform`), so it is cast to the decompressor type.
   */
  const classicStream = (
    write: (this: LegacyStream) => unknown,
  ): LegacyStream & { readable: boolean; writable: boolean } & Dumps.NodeDuplexLike => {
    const stream = Object.assign(new LegacyStream(), {
      readable: true,
      writable: true,
      write,
      end: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      destroy: () => {
        stream.readable = stream.writable = false;
        stream.emit("close");
      },
    });
    return stream as typeof stream & Dumps.NodeDuplexLike;
  };

  it("fails with a SourceError when a classic stage's write() throws", async () => {
    const stage = classicStream(() => {
      throw new Error("write exploded");
    });
    const error = await failsPromptly(
      Stream.make(new Uint8Array([1])).pipe(Dumps.decompressWith(() => stage)),
    );
    expect(error).toMatchObject({ description: expect.stringContaining("write exploded") });
    expect(throughDestroyed(stage)).toBe(true);
  });

  it("fails with a SourceError when a classic stage closes before its output ends", async () => {
    const stage = classicStream(function () {
      this.emit("close");
      return true;
    });
    const error = await failsPromptly(
      Stream.make(new Uint8Array([1])).pipe(Dumps.decompressWith(() => stage)),
    );
    expect(error).toMatchObject({ description: expect.stringContaining("closed before") });
  });

  it("rejects a classic stage that has already ended", async () => {
    const stage = unbzip2();
    stage.end();
    const error = await failsPromptly(Dumps.fromFile(SLICE_BZ2, { decompressor: () => stage }));
    expect(error).toMatchObject({ description: expect.stringContaining("fresh Node stream") });
  });
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

  it("runs a caller-supplied Transform that is not a zlib stream", async () => {
    // An identity stage: the point is a plain `stream.Transform` subclass,
    // the shape a third-party bzip2 decoder has, through `decompressWith`.
    const source = Dumps.fromNodeReadable(() => Readable.from([Buffer.from(DUMP)]));
    const bytes = await runTest(
      Stream.runCollect(source.pipe(Dumps.decompressWith(() => new PassThrough()))),
    );
    expect(decodeUtf8(bytes)).toBe(DUMP);
  });
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
const failsPromptly = async <A, E>(stream: Stream.Stream<A, E>): Promise<E> => {
  const outcome = await orHung(runTestExit(Stream.runDrain(stream)));
  if (outcome === "hung") throw new Error("the stream hung instead of failing");
  return expectFailureInstanceOf(outcome, Dumps.SourceError);
};

describe("a decompressor that is not a Node stream", () => {
  // The structural type admits it, so the runtime must reject it.
  it("fails fromFile with a SourceError", async () => {
    const path = join(tmp, "fake-decompressor.bin");
    writeFileSync(path, gzipSync(Buffer.from(DUMP)));
    const error = await failsPromptly(Dumps.fromFile(path, { decompressor: fakeDuplex }));
    expect(error).toMatchObject({ description: expect.stringContaining("Node stream") });
  });

  it("fails decompressWith with a SourceError", async () => {
    const source = Dumps.fromNodeReadable(() => Readable.from([gzipSync(Buffer.from(DUMP))]));
    const error = await failsPromptly(source.pipe(Dumps.decompressWith(fakeDuplex)));
    expect(error).toMatchObject({ description: expect.stringContaining("Node stream") });
  });

  it("tears down decompressWith's upstream source when it rejects the stage", async () => {
    // The upstream is already running by the time the stage is checked, so
    // the rejection must cancel it, or the source (an HTTP body, a file)
    // stays open. This source never pushes and never ends: only teardown
    // closes it, and it must, even while stalled (#83).
    let opened = false;
    const readable = new Readable({ read() {} });
    const closed = new Promise<"closed">((resolve) =>
      readable.once("close", () => resolve("closed")),
    );
    const source = Dumps.fromNodeReadable(() => {
      opened = true;
      return readable;
    });
    await failsPromptly(source.pipe(Dumps.decompressWith(fakeDuplex)));
    const outcome = await orHung(closed);
    expect(opened).toBe(true);
    expect(outcome).toBe("closed");
    expect(readable.destroyed).toBe(true);
  });

  it("fails without an unhandled rejection when the upstream has already failed", async () => {
    // A source that fails as it starts leaves the bridged web stream errored,
    // so cancelling it rejects; that rejection must not escape. The listener
    // makes this test fail on its own (Vitest would otherwise only fail the
    // run, unattributed).
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const error = await failsPromptly(Stream.fail("boom").pipe(Dumps.decompressWith(fakeDuplex)));
      expect(error).toMatchObject({ description: expect.stringContaining("Node stream") });
      await wait(20); // let any rejection surface
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
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

  it.each(usedStages)(
    "fails decompressWith with a SourceError and releases the upstream when the stage is %s",
    async (_, used) => {
      const stage = await used();
      // This source never pushes and never ends: only cancelling the bridged
      // web stream closes it.
      const readable = new Readable({ read() {} });
      const closed = new Promise<"closed">((resolve) =>
        readable.once("close", () => resolve("closed")),
      );
      const source = Dumps.fromNodeReadable(() => readable);
      await withoutUncaught(async () => {
        const error = await failsPromptly(source.pipe(Dumps.decompressWith(() => stage)));
        expect(await orHung(closed)).toBe("closed");
        expect(error).toMatchObject({ description: expect.stringContaining("fresh Node stream") });
      });
    },
  );

  it.each(usedStages)(
    "fails fromFile with a SourceError and leaks no file descriptor when the stage is %s",
    async (_, used) => {
      const stage = await used();
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
      try {
        await withoutUncaught(async () => {
          const error = await failsPromptly(Dumps.fromFile(path, { decompressor: () => stage }));
          await wait(0); // let any `_construct` tick run
          const closed = opened().map((file) =>
            file.closed
              ? Promise.resolve("closed" as const)
              : new Promise<"closed">((resolve) => file.once("close", () => resolve("closed"))),
          );
          expect(await orHung(Promise.all(closed))).not.toBe("hung");
          // Rejected before the file is opened at all.
          expect(opened()).toEqual([]);
          expect(error).toMatchObject({
            description: expect.stringContaining("fresh Node stream"),
          });
        });
      } finally {
        construct.mockRestore();
      }
    },
  );
});

// ── Interruption teardown ────────────────────────────────────────────────

/** A Node Readable that emits gzip data forever and records whether it was destroyed. */
class TrackedGzSource extends Readable {
  destroyedFlag = false;
  private readonly chunk = gzipSync(Buffer.from("x".repeat(1024)));
  override _read(): void {
    setTimeout(() => this.push(this.chunk), 5);
  }
  override _destroy(error: Error | null, callback: (e?: Error | null) => void): void {
    this.destroyedFlag = true;
    callback(error);
  }
}

describe("interruption teardown", () => {
  it("destroys the decompression source when the Effect is interrupted", async () => {
    const source = new TrackedGzSource();
    const program = Stream.runDrain(
      Dumps.fromNodeReadable(() => source).pipe(
        Dumps.gunzip,
        Stream.decodeText(),
        Stream.splitLines,
      ),
    );
    const fiber = Effect.runFork(program);
    await wait(120);
    await runTest(Fiber.interrupt(fiber));
    await wait(60);
    expect(source.destroyedFlag).toBe(true);
  });

  /**
   * A Readable that never pushes, and a promise that settles on its first
   * `read()`. Node's async iterator calls `read()` from inside `next()`, so
   * once `reading` settles a `next()` is pending that no data will settle.
   */
  const stalledReadable = (
    options: { readonly emitClose?: boolean } = {},
  ): { readonly readable: Readable; readonly reading: Promise<void> } => {
    let onRead = (): void => undefined;
    const reading = new Promise<void>((resolve) => (onRead = resolve));
    return { readable: new Readable({ ...options, read: () => onRead() }), reading };
  };

  // A stalled Readable's async iterator queues `return()` behind the pending
  // `next()`, so a teardown that waits on `return()` before destroying hangs
  // (#83). Interrupting only once `reading` settles makes the test exercise
  // that pending `next()` rather than pass before the drain reaches it.
  const interruptsPromptly = async (
    stream: Stream.Stream<unknown, unknown>,
    reading: Promise<void>,
  ): Promise<void> => {
    const fiber = Effect.runFork(Stream.runDrain(stream));
    expect(await orHung(reading)).toBeUndefined();
    const outcome = await orHung(
      runTest(Fiber.interrupt(fiber)).then(() => "interrupted" as const),
    );
    expect(outcome).toBe("interrupted");
  };

  it("destroys a stalled Readable when the Effect is interrupted", async () => {
    const { readable, reading } = stalledReadable();
    await interruptsPromptly(
      Dumps.fromNodeReadable(() => readable),
      reading,
    );
    expect(readable.destroyed).toBe(true);
  });

  it("destroys a stalled source behind a decompression stage when the Effect is interrupted", async () => {
    const { readable, reading } = stalledReadable();
    await interruptsPromptly(Dumps.fromNodeReadable(() => readable).pipe(Dumps.gunzip), reading);
    expect(readable.destroyed).toBe(true);
  });

  // Node's iterator settles its pending `next()`, and so the queued
  // `return()`, only on `close`. A source whose `destroy()` never gets there
  // would hold the interrupt up for good, so teardown waits for `close` only
  // up to a bound (#94); these fail with "hung" without it.
  it("completes the interrupt within a bound when the stalled Readable's destroy() never emits close", async () => {
    const { readable, reading } = stalledReadable({ emitClose: false });
    await interruptsPromptly(
      Dumps.fromNodeReadable(() => readable),
      reading,
    );
    expect(readable.destroyed).toBe(true);
  });

  // `mkfifo` is POSIX-only; CI runs on Linux.
  it.skipIf(process.platform === "win32")(
    "completes the interrupt within a bound on a fromFile read of a FIFO whose writer is idle",
    async () => {
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
      const stream = (): ReadStream | undefined => {
        const context = read.mock.contexts[0];
        return context instanceof ReadStream ? context : undefined;
      };
      try {
        await interruptsPromptly(
          Dumps.fromFile(fifo),
          reading.then(() => undefined),
        );
        expect(stream()?.destroyed).toBe(true);
      } finally {
        const source = stream();
        read.mockRestore();
        // With no writer left the read returns end-of-file and the stream
        // finishes closing: the fd is released after all, just not before the
        // interrupt returned.
        const closed =
          source === undefined || source.closed
            ? Promise.resolve("closed" as const)
            : new Promise<"closed">((resolve) => source.once("close", () => resolve("closed")));
        closeSync(writer);
        expect(await orHung(closed)).toBe("closed");
      }
    },
  );

  it("waits for a slow-closing Readable to close before the interrupt returns", async () => {
    // `_destroy` finishes 200 ms after `destroy()`: inside the bound, so the
    // interrupt must wait for it; a near-zero bound would return first.
    let onRead = (): void => undefined;
    const reading = new Promise<void>((resolve) => (onRead = resolve));
    const readable = new Readable({
      read: () => onRead(),
      destroy: (error, callback) => void setTimeout(() => callback(error), 200),
    });
    await interruptsPromptly(
      Dumps.fromNodeReadable(() => readable),
      reading,
    );
    expect(readable.closed).toBe(true);
  });

  it("swallows the delegated return()'s rejection when it settles after the bound", async () => {
    // A source whose `return()` outlives the bound and then rejects: the
    // interrupt has already completed, so the rejection has nowhere to go and
    // must not escape as an unhandled rejection.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let destroyed = false;
      let rejectReturn: (error: Error) => void = () => undefined;
      let onRead = (): void => undefined;
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
      await interruptsPromptly(
        Dumps.fromNodeReadable(() => source),
        reading,
      );
      expect(destroyed).toBe(true);
      rejectReturn(new Error("closed too late"));
      await wait(20); // let any rejection surface
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("destroys the Readable when interrupted before the iterator's return() is registered", async () => {
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
    const exit = await orHung(runTestExit(Stream.runDrain(Dumps.fromNodeReadable(() => readable))));
    expect(exit).not.toBe("hung");
    if (exit === "hung") return;
    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(readable.destroyed).toBe(true);
  });

  it("destroys a hand-built source whose iterator's return() doesn't, exactly once", async () => {
    // A Node Readable's own iterator destroys the stream in `return()`, which
    // would mask a teardown that never calls `destroy()` (#80). This source's
    // `return()` leaves it open, so only `fromNodeReadable`'s teardown can
    // destroy it; and `fromNodeReadable`'s wrapping `return()` and its scope
    // finalizer both run, so the `destroyed` guard is what keeps it to one
    // `destroy()`.
    let destroyCalls = 0;
    let pulled = 0;
    let onThirdPull = (): void => undefined;
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
        return: (value?: unknown) => Promise.resolve({ done: true as const, value }),
      }),
    };
    const fiber = Effect.runFork(Stream.runDrain(Dumps.fromNodeReadable(() => source)));
    expect(await orHung(thirdPull)).toBeUndefined();
    const exit = await orHung(
      runTest(Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))),
    );
    expect(exit).not.toBe("hung");
    if (exit === "hung") return;
    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(destroyCalls).toBe(1);
  });

  it("destroys the Readable when interrupted as soon as evaluate returns it", async () => {
    // An interruption the fiber observes right after `evaluate` returns, before
    // anything else runs, must still destroy the Readable: opening it and
    // registering its teardown are one uninterruptible step (#95). Interrupting
    // from inside `evaluate` lands it there deterministically.
    const readable = new Readable({ read() {} });
    const exit = await orHung(
      runTestExit(
        Stream.runDrain(
          Dumps.fromNodeReadable(() => {
            Fiber.getCurrent()?.interruptUnsafe();
            return readable;
          }),
        ),
      ),
    );
    expect(exit).not.toBe("hung");
    if (exit === "hung") return;
    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(readable.destroyed).toBe(true);
  });

  it("releases decompressWith's upstream source when interrupted before the stage is opened", async () => {
    // Bridging the source to a web stream starts it on a fiber of its own,
    // which only cancelling the web stream stops. An interruption that lands
    // after the source has started but before `fromNodeReadable` opens the
    // stage must still stop it, or the upstream (an HTTP body, which parks
    // holding its socket once a chunk is buffered) stays open (#109). The
    // source's first step interrupts the consuming fiber, which lands the
    // interruption in that window deterministically; the source then parks.
    let outer: Fiber.Fiber<unknown, unknown> | undefined;
    let started = false;
    let onReleased = (): void => undefined;
    const released = new Promise<"released">((resolve) => (onReleased = () => resolve("released")));
    const source = Stream.fromEffect(
      Effect.sync(() => {
        started = true;
        outer?.interruptUnsafe();
        return new Uint8Array(gzipSync(Buffer.from(DUMP)));
      }),
    ).pipe(Stream.concat(Stream.never), Stream.ensuring(Effect.sync(() => onReleased())));
    const stream = Stream.unwrap(
      Effect.sync(() => {
        outer = Fiber.getCurrent();
        return source.pipe(Dumps.decompressWith(Dumps.gunzipTransform));
      }),
    );
    await withoutUncaught(async () => {
      const exit = await orHung(runTestExit(Stream.runDrain(stream)));
      expect(exit).not.toBe("hung");
      if (exit === "hung") return;
      expect(started).toBe(true);
      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(await orHung(released)).toBe("released");
    });
  });

  it("destroys a classic bzip2 stage behind decompressWith, without an uncaught error, when interrupted while stalled", async () => {
    const { readable, reading } = stalledReadable();
    const stage = unbzip2();
    await withoutUncaught(async () => {
      await interruptsPromptly(
        Dumps.fromNodeReadable(() => readable).pipe(Dumps.decompressWith(() => stage)),
        reading,
      );
    });
    expect(readable.destroyed).toBe(true);
    expect(throughDestroyed(stage)).toBe(true);
  });

  it("destroys a classic bzip2 stage behind fromFile, without an uncaught error, when interrupted as soon as it is opened", async () => {
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
    await withoutUncaught(async () => {
      const exit = await orHung(
        runTestExit(Stream.runDrain(Dumps.fromFile(SLICE_BZ2, { decompressor }))),
      );
      expect(exit).not.toBe("hung");
      if (exit === "hung") return;
      expect(Exit.hasInterrupts(exit)).toBe(true);
    });
    expect(stages.length).toBe(1);
    expect(stages.every(throughDestroyed)).toBe(true);
  });

  it("destroys fromFile's decompression chain, without an uncaught error, when interrupted as soon as it is opened", async () => {
    // `fromFile` opens a `.gz` as a `stream.compose` chain, which emits an
    // `AbortError` when it is destroyed before it finishes. Destroyed by the
    // scope finalizer before the stream is first pulled, nothing listens for
    // that error, and a real process would crash on it (#109). The
    // decompressor interrupts the fiber, which lands the interruption right
    // after the open, as in the #95 test above.
    const path = join(tmp, "interrupted-open.json.gz");
    writeFileSync(path, gzipSync(Buffer.from(DUMP)));
    let stage: Transform | undefined;
    const decompressor = (): Transform => {
      Fiber.getCurrent()?.interruptUnsafe();
      return (stage = createGunzip());
    };
    await withoutUncaught(async () => {
      const exit = await orHung(
        runTestExit(Stream.runDrain(Dumps.fromFile(path, { decompressor }))),
      );
      expect(exit).not.toBe("hung");
      if (exit === "hung") return;
      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(stage?.destroyed).toBe(true);
    });
  });
});

// ── Resumable HTTP range download ────────────────────────────────────────

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

/** A fetch stub over `Range` requests; `onCall` decides each response. */
const stubFetch = (onCall: (call: number, start: number) => Response) => {
  const ranges: string[] = [];
  const userAgents: (string | null)[] = [];
  let call = 0;
  const fetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    const range = request.headers.get("range") ?? "";
    ranges.push(range);
    userAgents.push(request.headers.get("user-agent"));
    const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? "0");
    call += 1;
    return Promise.resolve(onCall(call, start));
  };
  const layer = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  return { ranges, userAgents, layer };
};

const collectRange = (
  layer: Layer.Layer<HttpClient.HttpClient>,
): Promise<ReadonlyArray<Uint8Array>> =>
  runTest(
    Stream.runCollect(Dumps.fromHttpRange("https://dumps.example.org/x.gz")).pipe(
      Effect.provide(layer),
    ),
  );

describe("fromHttpRange", () => {
  it("downloads a body with a bytes=0- range request", async () => {
    const encoder = new TextEncoder();
    const { ranges, layer } = stubFetch(
      () => new Response(encoder.encode(ALPHABET), { status: 206 }),
    );
    const bytes = await collectRange(layer);
    expect(decodeUtf8(bytes)).toBe(ALPHABET);
    expect(ranges).toEqual(["bytes=0-"]);
  });

  it("resumes from the last received byte after a mid-stream failure", async () => {
    const encoder = new TextEncoder();
    const { ranges, layer } = stubFetch((call, start) => {
      if (call === 1) {
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) controller.enqueue(encoder.encode(ALPHABET.slice(0, 10)));
            else controller.error(new Error("connection reset"));
          },
        });
        return new Response(body, { status: 206 });
      }
      return new Response(encoder.encode(ALPHABET.slice(start)), { status: 206 });
    });

    const bytes = await collectRange(layer);
    expect(decodeUtf8(bytes)).toBe(ALPHABET);
    expect(ranges).toEqual(["bytes=0-", "bytes=10-"]);
  });

  it("sends the package's default User-Agent when the caller sets none", async () => {
    const { userAgents, layer } = stubFetch(() => new Response("abc", { status: 206 }));
    await collectRange(layer);
    expect(userAgents).toEqual([Core.USER_AGENT]);
  });

  it("sends no Api-User-Agent: the dump host is not an API, unlike Core.WikimediaClient's", async () => {
    const apiUserAgents: (string | null)[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      apiUserAgents.push(new Request(input, init).headers.get("api-user-agent"));
      return Promise.resolve(new Response("abc", { status: 206 }));
    };
    await collectRange(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
    );
    expect(apiUserAgents).toEqual([null]);
  });

  it("sends the Core.UserAgent reference's value when one is provided", async () => {
    const userAgent = "my-bot/1.2 (bot@example.org)";
    const { userAgents, layer } = stubFetch(() => new Response("abc", { status: 206 }));
    await runTest(
      Stream.runCollect(Dumps.fromHttpRange("https://dumps.example.org/x.gz")).pipe(
        Effect.provide(layer),
        Effect.provideService(Core.UserAgent, userAgent),
      ),
    );
    expect(userAgents).toEqual([userAgent]);
  });

  it("sends the userAgent option, over the reference, on every resumed request", async () => {
    const userAgent = "my-dump-loader/2.0 (bot@example.org)";
    const encoder = new TextEncoder();
    const { userAgents, layer } = stubFetch((call, start) => {
      if (call === 1) {
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) controller.enqueue(encoder.encode(ALPHABET.slice(0, 10)));
            else controller.error(new Error("connection reset"));
          },
        });
        return new Response(body, { status: 206 });
      }
      return new Response(encoder.encode(ALPHABET.slice(start)), { status: 206 });
    });
    const bytes = await runTest(
      Stream.runCollect(Dumps.fromHttpRange("https://dumps.example.org/x.gz", { userAgent })).pipe(
        Effect.provide(layer),
        Effect.provideService(Core.UserAgent, "ignored/0 (reference loses to the option)"),
      ),
    );
    expect(decodeUtf8(bytes)).toBe(ALPHABET);
    expect(userAgents).toEqual([userAgent, userAgent]);
  });

  // One program that uses both the client and a dump download: where the
  // reference is provided decides which of the two sees it.
  const bothUserAgents = (
    provideUserAgent: (
      layer: typeof Core.wikimediaClientLayer,
    ) => Layer.Layer<Core.WikimediaClient, never, HttpClient.HttpClient>,
  ) => {
    const userAgents: { client?: string | null; dumps?: string | null } = {};
    const fetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      const ua = request.headers.get("user-agent");
      if (request.url.startsWith("https://dumps.example.org/")) {
        userAgents.dumps = ua;
        return Promise.resolve(new Response("abc", { status: 206 }));
      }
      userAgents.client = ua;
      return Promise.resolve(new Response("ok", { status: 200 }));
    };
    const http = FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
    );
    const program = Effect.gen(function* () {
      const client = yield* Core.WikimediaClient;
      yield* client.getText({ host: "en.wikipedia.org", path: "/w/api.php", params: {} });
      yield* Stream.runCollect(Dumps.fromHttpRange("https://dumps.example.org/x.gz"));
    });
    return runTest(
      program.pipe(
        Effect.provide(provideUserAgent(Core.wikimediaClientLayer).pipe(Layer.provideMerge(http))),
      ),
    ).then(() => userAgents);
  };

  it("sends a Core.UserAgent given with Layer.provideMerge from both the client and the dump download", async () => {
    const userAgent = "my-bot/1.2 (bot@example.org)";
    const sent = await bothUserAgents((layer) =>
      layer.pipe(Layer.provideMerge(Layer.succeed(Core.UserAgent, userAgent))),
    );
    expect(sent).toEqual({ client: userAgent, dumps: userAgent });
  });

  it("sends a Core.UserAgent given with Layer.provide from the client only", async () => {
    const userAgent = "my-bot/1.2 (bot@example.org)";
    const sent = await bothUserAgents((layer) =>
      layer.pipe(Layer.provide(Layer.succeed(Core.UserAgent, userAgent))),
    );
    expect(sent).toEqual({ client: userAgent, dumps: Core.USER_AGENT });
  });

  it("fails once resumes are exhausted", async () => {
    const { layer } = stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("always fails"));
            },
          }),
          { status: 206 },
        ),
    );
    const exit = await runTestExit(
      Stream.runDrain(
        Dumps.fromHttpRange("https://dumps.example.org/x.gz", { maxResumes: 0 }),
      ).pipe(Effect.provide(layer)),
    );
    expect(exit._tag).toBe("Failure");
  });
});
