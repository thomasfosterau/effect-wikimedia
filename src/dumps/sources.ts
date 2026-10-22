/// <reference types="node" />
/**
 * **Dump sources & decompression** — the only Node-only exports in
 * `@thomasfosterau/effect-wikimedia`. A dump is ultimately a
 * `Stream<Uint8Array>`; this module supplies that byte stream from a local
 * file or a resumable HTTP range download, and the pluggable decompression
 * stages that sit in front of the `Dumps` entity / XML pipelines.
 *
 * **Why Node-only, and why it is quarantined here.** Streaming a
 * multi-gigabyte compressed dump wants `node:fs` / `node:zlib` / `node:stream`
 * — capabilities a Worker / browser build does not have. Node imports are
 * confined to this module; the rest of the package (including the
 * `dumps/entities` and `dumps/xml` pipelines themselves) stays
 * runtime-agnostic, so a consumer that brings its **own** `Stream<Uint8Array>`
 * never pulls these Node imports.
 *
 * **bz2 decompression is a pluggable stage, not a dependency.** Node's `zlib`
 * ships gzip ({@link gunzipTransform}) but no bzip2, and pure-JS bzip2
 * decoders are heavy and slow — against the package's lean-dependency
 * posture. So decompression is modelled as an injectable Node stream
 * factory ({@link Decompressor}): gzip is built in, and a caller who needs the
 * `.json.bz2` variant supplies their own bzip2 decoder, such as
 * `unbzip2-stream`, to {@link fromFile} or {@link decompressWith} (the
 * {@link Decompressor} docs show how). No bzip2 code, and no bzip2
 * dependency, ships here.
 *
 * **Node at runtime, not in the declarations.** The stream parameters are
 * typed structurally ({@link NodeReadableLike}, {@link NodeDuplexLike}), so
 * the published `.d.ts` imports nothing from `node:*`. A browser or Worker
 * consumer that type-checks the package's declarations needs no
 * `@types/node`, and real Node streams still fit the parameters.
 *
 * @copyright Thomas Foster
 * @module dumps/sources
 */

import { createReadStream } from "node:fs";
import { compose, Duplex, isReadable, isWritable, Readable } from "node:stream";
import { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";
import { UserAgent } from "../core.ts";

// ── Error & etiquette ────────────────────────────────────────────────────

/** A failure reading or decompressing a dump source. */
export class SourceError extends Schema.TaggedError<SourceError>()("SourceError", {
  description: Schema.String,
}) {}

const describe = (reason: unknown): string =>
  Predicate.isError(reason) ? reason.message : String(reason);

/**
 * Turns an effect-produced web stream back into a Node `Readable`, for a Node
 * `Transform` stage. `@types/node` and the `dom` lib each declare their own
 * `ReadableStream`, and the `effect` `Stream` combinators are typed against
 * the DOM one; in Node they are one class, so the `instanceof` test always
 * passes, and it narrows the value to the type `Readable.fromWeb` takes. A
 * runtime where they differ fails the stream with a {@link SourceError}.
 */
type WebByteStream = ReadableStream<Uint8Array>;
const webToNode = (web: WebByteStream): Readable => {
  if (!(web instanceof NodeWebReadableStream)) {
    throw new TypeError("the runtime's ReadableStream is not Node's `stream/web` ReadableStream");
  }
  return Readable.fromWeb(web);
};

const sourceError = (reason: unknown): SourceError =>
  new SourceError({ description: `dumps/source-read-failed: ${describe(reason)}` });

/** Runs a synchronous Node call, failing with a {@link SourceError} if it throws. */
const tryNode = <A>(step: () => A): Effect.Effect<A, SourceError> =>
  Effect.try({ try: step, catch: sourceError });

// ── Structural stream types ──────────────────────────────────────────────

/**
 * The part of a Node `Readable` that {@link fromNodeReadable} uses: async
 * iteration over byte chunks, plus `destroyed` / `destroy()` for teardown.
 * Every Node `Readable` fits it (`fs.createReadStream`, `Readable.from`, a
 * `zlib` stream); it is declared structurally so the package's declarations
 * need no `node:stream` types. The stream should yield `Uint8Array` chunks
 * (a `Buffer` is one); one in object mode or with an encoding set yields
 * other values, which the byte pipelines can't decode.
 */
export interface NodeReadableLike extends AsyncIterable<Uint8Array> {
  /** Whether the stream has been destroyed; teardown skips `destroy()` when it is. */
  readonly destroyed: boolean;
  /** Destroys the stream and releases what it holds (a file descriptor, a decompressor). */
  destroy(): void;
}

/**
 * The part of a Node `Duplex` that a {@link Decompressor} returns: writable
 * (compressed bytes in) and readable (decompressed bytes out). Declared
 * structurally so the package's declarations need no `node:stream` types.
 * At runtime the value must be a fresh Node `Duplex` or `Transform` (such as
 * `zlib.createGunzip()`), or a fresh classic duplex stream (such as the one
 * `unbzip2-stream` returns), which this type can't express: it is passed to
 * Node's `stream.compose`, a classic stream after it has been adapted into a
 * `Duplex`. A value that `node:stream` doesn't recognise as a stream, or a
 * stream already destroyed or ended, fails the stream with a
 * {@link SourceError}; pass a new Node stream each time.
 */
export interface NodeDuplexLike extends NodeReadableLike {
  /** Writes a chunk of compressed input. */
  write(chunk: Uint8Array): void;
  /** Signals the end of the compressed input. */
  end(): void;
}

/**
 * Recovers the Node `Duplex` a {@link Decompressor} returns from its
 * structural type, for `compose`, and fails unless it is a fresh one; a
 * classic stream is adapted into a `Duplex` once it has passed the check. The
 * contract on {@link NodeDuplexLike} is that the value is a real Node stream,
 * but the type admits a plain object, and `compose` doesn't reject one: the
 * composed stream never settles. Nor is a used stream safe: `compose` throws
 * on one destroyed or whose input has ended, but only once the upstream has
 * been opened, which then leaks (#111), and accepts one whose output has
 * ended, which yields nothing or never settles. So this checks first, before
 * anything is opened, and fails with a {@link SourceError}. `isReadable` / `isWritable` return `true`
 * only for a Node stream that is neither destroyed nor ended on that side (a
 * new `zlib.createGunzip()` gives `true` for both), `false` for a used one or
 * an object without a stream's `pipe` / `write` / `on`, and `null` for a
 * value whose `readable` / `writable` aren't booleans. `compose` checks the
 * stage with the same `isWritable`, so a stage that passes here passes there.
 * The check is a heuristic, not a proof: a plain object with
 * `readable: true`, `writable: true` and `pipe` / `write` / `on` functions
 * still passes it, is adapted as a classic stream, and hangs in `compose`.
 */
const asNodeDuplex = (stream: NodeDuplexLike): Effect.Effect<Duplex, SourceError> => {
  // SAFETY: only `isReadable` / `isWritable` read the value as a `Duplex`
  // before the check below; they test any value at runtime, and the value
  // is returned as one only once both have passed.
  const duplex = stream as Duplex;
  if (isReadable(duplex) !== true || isWritable(duplex) !== true) {
    return Effect.fail(
      sourceError(
        "the decompressor must return a fresh Node stream (a Duplex, a Transform or a classic duplex stream), not a plain object or a stream already destroyed or ended",
      ),
    );
  }
  return Effect.succeed(hasStreamState(duplex) ? duplex : adaptClassicDuplex(duplex));
};

/** Calls a {@link Decompressor} and checks the stage it returns ({@link asNodeDuplex}). */
const openStage = (decompressor: Decompressor): Effect.Effect<Duplex, SourceError> =>
  Effect.flatMap(tryNode(decompressor), asNodeDuplex);

/**
 * Whether `stream` is a streams2 `Duplex` (a `Transform`, a `zlib` stream, a
 * `readable-stream` one), which keeps its state in `_readableState` and
 * `_writableState`, rather than a classic stream, which has neither. Node's
 * stream utilities tell the two apart by the same fields; `compose` needs
 * both sides, as it reads the stage with `read()` and waits for its `finish`.
 */
const hasStreamState = (stream: Duplex): boolean =>
  Predicate.hasProperty(stream, "_readableState") &&
  Predicate.isObjectOrArray(stream._readableState) &&
  Predicate.hasProperty(stream, "_writableState") &&
  Predicate.isObjectOrArray(stream._writableState);

/**
 * A failure inside a classic-stream adapter, raised in Node land where an
 * `Error` is what a stream is destroyed with. Its `message` becomes the
 * {@link SourceError} description the stream fails with.
 */
class StageError extends Schema.TaggedError<StageError>()("StageError", {
  message: Schema.String,
}) {}

/**
 * Returns what `step` returns, or passes what it throws to `callback` and
 * returns `undefined`: a classic stream's `write()` may throw, and a throw
 * from a Duplex's `_write` would escape the stream.
 */
const attempt = <A>(step: () => A, callback: (error: Error) => void): A | undefined => {
  try {
    return step();
  } catch (error) {
    callback(Predicate.isError(error) ? error : new StageError({ message: describe(error) }));
    return undefined;
  }
};

/**
 * Adapts a classic (pre-streams2) duplex, such as the `through` stream that
 * `unbzip2-stream` returns, into a streams2 `Duplex` for `compose` (#128). A
 * classic stream has no `read()` and emits `data`, `end` and `close` but never
 * `finish`, so `compose` fails it with "Premature close"; Node's
 * `Duplex.from` doesn't help, as it treats one as readable only. Compressed
 * bytes go in through the classic stream's `write()`, waiting for its `drain`
 * when it returns `false`, and `end()`. Its `data` is pushed out, pausing it
 * while the adapter's buffer is full and resuming it on the next read, and
 * its `end` ends the output. Its `error` destroys the adapter with that
 * error, as does a throwing `write()` or `end()` (Node reports the latter
 * itself), and a `close` before its
 * `end` fails the adapter rather than leaving it waiting. Destroying the
 * adapter destroys the classic stream. Its own `error` listener means an
 * error the classic stream emits after teardown is dropped, not thrown.
 */
const adaptClassicDuplex = (classic: Duplex): Duplex => {
  let ended = false;
  const adapter = new Duplex({
    write: (chunk: Uint8Array, _encoding, callback) => {
      const written = attempt(() => classic.write(chunk) !== false, callback);
      if (written === true) callback();
      else if (written === false) classic.once("drain", () => callback());
    },
    // Node turns a synchronous throw from `_final` into an `error` event, so
    // a throwing `end()` needs no guard here.
    final: (callback) => {
      classic.end();
      callback();
    },
    read: () => void classic.resume(),
    destroy: (error, callback) => {
      classic.destroy();
      callback(error);
    },
  });
  classic.on("data", (chunk: Uint8Array) => {
    if (!adapter.push(chunk)) classic.pause();
  });
  classic.on("end", () => {
    ended = true;
    adapter.push(null);
  });
  classic.on("error", (error: Error) => adapter.destroy(error));
  classic.on("close", () => {
    if (!ended)
      adapter.destroy(
        new StageError({ message: "the decompressor closed before its output ended" }),
      );
  });
  return adapter;
};

/**
 * Composes `head` into `stage`, destroying both if `compose` throws (the
 * failure is a {@link SourceError}): nothing else owns them yet, so a throw
 * would otherwise leave `head` (an open file, a source behind a web stream)
 * open. {@link asNodeDuplex} already rejects
 * the stages `compose` throws on, so this is a second line of defence. Both
 * go through `destroyReadable`, which adds a no-op `error` listener first:
 * destroying a fresh `fs.ReadStream` still runs its pending open, and if that
 * open fails (a missing file) the `error` it emits would otherwise crash the
 * process as an uncaught exception, as in #109.
 */
const composeOrDestroy = (head: Readable, stage: Duplex): Effect.Effect<Duplex, SourceError> =>
  tryNode(() => compose(head, stage)).pipe(
    Effect.tap((composed) =>
      Effect.sync(() => {
        ignoreLateErrors(stage);
        ignoreLateErrors(composed);
      }),
    ),
    Effect.tapError(() =>
      Effect.sync(() => {
        destroyReadable(head);
        destroyReadable(stage);
      }),
    ),
  );

/**
 * Gives `stream` an `error` listener that drops the error, so one emitted
 * once nothing else listens cannot crash the process as an uncaught
 * exception. A stage can emit `error` after its output has ended, when
 * `compose` has removed its listeners and the stream has already completed
 * (#139). It costs no error the stream should report: while the stream is
 * read, `compose` and the async iterator (which also reads the errored state
 * a stream keeps) still see every error.
 */
const ignoreLateErrors = (stream: Duplex): void => {
  stream.on("error", () => undefined);
};

// ── Node Readable → Stream<Uint8Array> ───────────────────────────────────

/**
 * Destroys `readable` for teardown, unless it already is. Teardown passes no
 * error, but a `stream.compose` chain (what {@link fromFile} opens with a
 * decompressor, and what {@link decompressWith} opens) emits an `AbortError`
 * when it is destroyed before it finishes. Before the stream is first pulled
 * nothing listens for it, and Node throws an `error` event nobody listens for
 * as an uncaught exception, which crashes the process (#109). The stream's
 * outcome is already settled, so a listener that drops the error goes on
 * first.
 */
const destroyReadable = (readable: NodeReadableLike): void => {
  if (readable.destroyed) return;
  if (Predicate.hasProperty(readable, "on") && Predicate.isFunction(readable.on)) {
    readable.on("error", () => undefined);
  }
  readable.destroy();
};

/**
 * How long, in milliseconds, stream teardown waits for a destroyed Readable to
 * finish closing before it gives up (#94). A well-behaved Readable (a file
 * read, a gunzip, an HTTP body) closes within milliseconds of `destroy()`,
 * far inside this bound, so it is released before the interruption returns;
 * the bound only stops the interruption hanging on a Readable that never
 * emits `close`, while staying short enough that an `Effect.timeout` over
 * such a source still returns promptly. Internal, so it can be retuned in a
 * patch; `fromNodeReadable` documents it.
 */
const CLOSE_WAIT_MS = 1000;

/**
 * Settles as `promise` does if it settles within `ms`, or with `fallback`
 * after that. The timer is cleared once the race settles. A rejection of
 * `promise` after the bound is swallowed rather than crashing the process as
 * an unhandled rejection: `Promise.race` has already subscribed to `promise`,
 * so that rejection is handled even though the race has settled.
 */
const settleWithin = <A>(promise: Promise<A>, ms: number, fallback: A): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<A>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, elapsed]).finally(() => clearTimeout(timer));
};

/**
 * Iterates `readable` through an iterator whose `return()` destroys the
 * Readable before delegating. `Stream.fromAsyncIterable` awaits `return()` on
 * teardown, and a Node Readable's iterator queues `return()` behind a pending
 * `next()`; while the Readable is stalled that `next()` never settles, so
 * teardown would hang (#83). Destroying first settles the pending `next()`
 * once the Readable emits `close`, and the queued `return()` then completes.
 * A Readable that never emits `close` (`emitClose: false`, or a file read
 * blocked on a FIFO whose writer is idle) would still hang it, so the wait
 * for the delegated `return()` is bounded by `CLOSE_WAIT_MS`, after
 * which teardown carries on without it (#94).
 */
const destroyOnReturn = (readable: NodeReadableLike): AsyncIterable<Uint8Array> => ({
  [Symbol.asyncIterator]: () => {
    const iterator = readable[Symbol.asyncIterator]();
    return {
      next: () => iterator.next(),
      return: (value?: unknown) => {
        destroyReadable(readable);
        const done: IteratorReturnResult<unknown> = { done: true, value };
        return iterator.return !== undefined
          ? settleWithin(iterator.return(value), CLOSE_WAIT_MS, done)
          : Promise.resolve(done);
      },
    };
  },
});

/**
 * Wraps any Node `Readable` ({@link NodeReadableLike}) as a
 * `Stream<Uint8Array>`; a read failure, or `evaluate` throwing, fails the
 * stream with a {@link SourceError}. The bytes are pulled through the Readable's **async
 * iterator**, one chunk at a time — that is the constant-memory guarantee:
 * async iteration applies native backpressure, so a fast producer (a gunzip
 * decompressing a tiny `.gz` into hundreds of MB) is paused between pulls and
 * the whole file is never buffered.
 *
 * Stream teardown destroys the Readable, which is the interruption
 * guarantee: cancelling the consuming Effect destroys the Readable and
 * anything composed into it — an open file descriptor, an in-flight gunzip —
 * so no decompression work is orphaned. Two mechanisms make it hold: the
 * wrapping iterator's `return()` destroys it once the stream has been pulled,
 * and a scope finalizer, registered in the same uninterruptible step that
 * opens it, destroys it if teardown comes before that. It holds while the
 * Readable is stalled waiting for data, too: the interruption completes once
 * the Readable's own `destroy()` does (it emits `close`), without waiting for
 * that data. That wait is bounded at one second: if the Readable hasn't
 * emitted `close` by then, the interruption completes anyway, and the
 * Readable, already destroyed, may not have released what it holds yet. A
 * well-behaved Readable closes within milliseconds; the bound is for one
 * whose `destroy()` never finishes, such as one built with `emitClose: false`,
 * or a {@link fromFile} read of a FIFO whose writer is open but idle, which
 * keeps its file descriptor until the writer writes or closes.
 */
export const fromNodeReadable = (
  evaluate: () => NodeReadableLike,
): Stream.Stream<Uint8Array, SourceError> => openNodeReadable(tryNode(evaluate));

/**
 * {@link fromNodeReadable} over an `open` effect: the stream of the Readable
 * it succeeds with, or its failure. `open` runs uninterruptibly, so it must
 * be short and synchronous in effect, as opening a Node stream is.
 */
const openNodeReadable = (
  open: Effect.Effect<NodeReadableLike, SourceError>,
): Stream.Stream<Uint8Array, SourceError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // Opening the Readable and registering its `destroy()` as a scope
      // finalizer are one uninterruptible step, so no interruption can land
      // between them and leave it open (#95); opening is synchronous, so
      // that costs nothing. The finalizer covers teardown that lands before
      // `Stream.fromAsyncIterable` has created the iterator and registered its
      // `return()` as a finalizer: an interruption the fiber observes between
      // this step and that one.
      const readable = yield* Effect.acquireRelease(open, (readable) =>
        Effect.sync(() => destroyReadable(readable)),
      );
      return Stream.fromAsyncIterable(destroyOnReturn(readable), sourceError);
    }),
  );

// ── Decompression stages ─────────────────────────────────────────────────

/**
 * A decompression stage: a factory for a fresh Node stream that turns
 * compressed bytes into bytes, called once per stream. Typed as {@link NodeDuplexLike}, so any
 * Node `Duplex` or `Transform` fits, and so does a classic (pre-streams2)
 * duplex stream, which is adapted for Node's `stream.compose`. Return a new
 * Node stream on each call: a value that `node:stream` doesn't recognise as a
 * stream, or a stream already destroyed or ended, fails the stream it feeds
 * with a {@link SourceError}.
 *
 * For bzip2 (Wikidata's `.json.bz2` entity dumps), which Node's `zlib` lacks,
 * pass a bzip2 decoder from a library. `unbzip2-stream` works, though its
 * stream is a classic one rather than the `Transform` that
 * `@types/unbzip2-stream` declares:
 *
 * ```ts
 * import unbzip2 from "unbzip2-stream";
 *
 * const items = Dumps.fromFile("latest-all.json.bz2", {
 *   decompressor: () => unbzip2(),
 * }).pipe(Dumps.entityRecords, Dumps.onlyEntities);
 *
 * // Or over a download, or any other byte stream:
 * const remote = Dumps.fromHttpRange(
 *   "https://dumps.wikimedia.org/wikidatawiki/entities/latest-all.json.bz2",
 * ).pipe(Dumps.decompressWith(() => unbzip2()));
 * ```
 *
 * A decoding failure (corrupt or truncated input) fails the stream with a
 * {@link SourceError}. `unbzip2-stream` is pure JavaScript and decodes on the
 * event loop, so where a dump is also published as `.json.gz` the built-in
 * {@link gunzipTransform} avoids that cost.
 */
export type Decompressor = () => NodeDuplexLike;

/** The built-in gzip decompressor — `zlib.createGunzip()`. Covers `.json.gz`. */
export const gunzipTransform: Decompressor = () => createGunzip();

/**
 * Lifts a {@link Decompressor} into a `Stream` stage: `Stream<Uint8Array>` →
 * `Stream<Uint8Array>`, pushing the bytes through a fresh Node transform. A
 * decompressor that returns a value `node:stream` doesn't recognise as a
 * stream, or a stream already destroyed or ended, fails the stage with a
 * {@link SourceError} and cancels the source. Use
 * it to decompress a source that is *not* a local file — e.g. an
 * {@link fromHttpRange} download — or to inject a bzip2 decoder the package
 * does not ship (see {@link Decompressor}). Composes with any byte source.
 */
export const decompressWith =
  (transform: Decompressor) =>
  <E, R>(source: Stream.Stream<Uint8Array, E, R>): Stream.Stream<Uint8Array, SourceError, R> =>
    Stream.unwrap(
      // `compose` (not `.pipe`) so tearing the output down destroys the whole
      // chain — the web-source reader and the transform — leaving no orphaned
      // decompression work behind.
      Effect.map(Effect.context<R>(), (context) =>
        openNodeReadable(
          Effect.gen(function* () {
            // Building `web` starts the source on a fiber of its own that only
            // `web.cancel()` stops, so build it here, inside the uninterruptible
            // open: an interruption can't then land between starting the
            // source and registering the teardown that cancels it (#109). A
            // rejected stage must cancel it too, or the upstream (an HTTP
            // body, a file) stays open.
            const web = yield* tryNode(() => Stream.toReadableStreamWith(source, context));
            // Cancel only here: once `webToNode` has run, `web` is locked, and
            // destroying the Node Readable it returns is what cancels it. If
            // the source has already failed, `web` is errored and `cancel()`
            // rejects with that error; swallow it, since the stage rejection
            // is what this stream reports, and an unhandled rejection would
            // crash the process.
            const stage = yield* openStage(transform).pipe(
              Effect.tapError(() =>
                Effect.sync(() => {
                  web.cancel().catch(() => undefined);
                }),
              ),
            );
            const head = yield* tryNode(() => webToNode(web));
            return yield* composeOrDestroy(head, stage);
          }),
        ),
      ),
    );

/** The built-in gzip {@link Stream} stage — {@link decompressWith} over {@link gunzipTransform}. */
export const gunzip = <E, R>(
  source: Stream.Stream<Uint8Array, E, R>,
): Stream.Stream<Uint8Array, SourceError, R> => decompressWith(gunzipTransform)(source);

// ── File source ──────────────────────────────────────────────────────────

/** Options for {@link fromFile}. */
export interface FromFileOptions {
  /**
   * Decompression stage to pipe the file through. Omit to auto-detect from
   * the path extension (`.gz` → gzip; anything else → no decompression). Pass
   * an explicit {@link Decompressor} for `.bz2` (supply your own bzip2
   * decoder, as the {@link Decompressor} docs show) or to force a codec.
   */
  readonly decompressor?: Decompressor;
}

/** Chooses a decompressor for a path when the caller did not pin one. */
function decompressorFor(path: string, override: Decompressor | undefined): Decompressor | null {
  if (override !== undefined) return override;
  if (path.endsWith(".gz")) return gunzipTransform;
  return null;
}

/**
 * Opens a dump file as a `Stream<Uint8Array>`, decompressing inline when a
 * stage is given or auto-detected from the extension. The read and any
 * decompression are piped in Node land and wrapped once, so interruption
 * tears the whole chain down (see {@link fromNodeReadable}). A `.json.gz`
 * dump needs no options; a `.json.bz2` dump needs an injected bzip2
 * {@link Decompressor} (its docs show one).
 */
export const fromFile = (
  path: string,
  options?: FromFileOptions,
): Stream.Stream<Uint8Array, SourceError> => {
  const decompressor = decompressorFor(path, options?.decompressor);
  const open = (): Effect.Effect<NodeReadableLike, SourceError> =>
    decompressor === null
      ? tryNode(() => createReadStream(path))
      : Effect.gen(function* () {
          // Check the stage before opening the file, so a rejected one leaks no fd.
          const stage = yield* openStage(decompressor);
          // `compose` so destroying the decompressor also destroys the file
          // read — the fd is closed on interruption, not orphaned. If opening
          // the file throws, destroy the stage, which nothing else owns yet.
          const file = yield* tryNode(() => createReadStream(path)).pipe(
            Effect.tapError(() => Effect.sync(() => stage.destroy())),
          );
          return yield* composeOrDestroy(file, stage);
        });
  return openNodeReadable(Effect.suspend(open));
};

// ── HTTP range source (resumable) ────────────────────────────────────────

/** Options for {@link fromHttpRange}. */
export interface FromHttpRangeOptions {
  /** Byte offset to start from (for an explicit resume). Defaults to `0`. */
  readonly startByte?: number;
  /** Extra attempts after a mid-stream transport failure, each resuming from the last received byte. Defaults to `3`. */
  readonly maxResumes?: number;
  /**
   * The `User-Agent` header to send on every range request, verbatim.
   * Defaults to the `Core.UserAgent` reference in context when the stream
   * runs, which itself defaults to `Core.USER_AGENT`. Set it, or that
   * reference, to your own UA with your contact details, as Wikimedia's
   * User-Agent policy asks (https://meta.wikimedia.org/wiki/User-Agent_policy).
   * No `Api-User-Agent` is sent, unlike `Core.WikimediaClient` requests: that
   * header is for browser clients of Wikimedia's APIs, and this is a Node
   * download from the dump host, where `User-Agent` arrives as given.
   */
  readonly userAgent?: string | undefined;
}

const DEFAULT_MAX_RESUMES = 3;

/** Issues a ranged GET from `offset` and returns its body byte stream. */
const rangeRequest = (
  url: string,
  offset: number,
  userAgent: string | undefined,
): Stream.Stream<Uint8Array, SourceError, HttpClient.HttpClient> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const ua = userAgent ?? (yield* UserAgent);
      const request = HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeaders({ range: `bytes=${offset}-`, "user-agent": ua }),
      );
      const response = yield* client
        .execute(request)
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceError({ description: `dumps/http-range-failed: ${describe(error)}` }),
          ),
        );
      return response.stream.pipe(
        Stream.mapError(
          (error) =>
            new SourceError({ description: `dumps/http-range-failed: ${describe(error)}` }),
        ),
      );
    }),
  );

/**
 * A **resumable** HTTP range download as a `Stream<Uint8Array>`. Streams the
 * body of a ranged GET; on a mid-stream transport failure it re-requests
 * `bytes=<bytes-received>-` and continues, up to `maxResumes` times, so a
 * dropped connection part-way through a multi-gigabyte dump does not restart
 * from zero. The server must honour `Range` (Wikimedia's dump host does); a
 * server that ignores it would re-send from the start on resume.
 *
 * Compose {@link gunzip} (or an injected bzip2 stage via {@link decompressWith})
 * downstream to decompress. Requires an {@link HttpClient.HttpClient} in
 * context. Sends the `userAgent` option, else the `Core.UserAgent` reference
 * (see {@link FromHttpRangeOptions.userAgent}).
 */
export const fromHttpRange = (
  url: string,
  options?: FromHttpRangeOptions,
): Stream.Stream<Uint8Array, SourceError, HttpClient.HttpClient> => {
  const maxResumes = options?.maxResumes ?? DEFAULT_MAX_RESUMES;
  const attempt = (
    offset: number,
    resumesLeft: number,
  ): Stream.Stream<Uint8Array, SourceError, HttpClient.HttpClient> => {
    let received = offset;
    return rangeRequest(url, offset, options?.userAgent).pipe(
      Stream.tap((chunk) => Effect.sync(() => (received += chunk.length))),
      // Resume only on a transport SourceError — never on interruption, which
      // must propagate and tear the download down (see the interruption test).
      Stream.catchTag("SourceError", (error) =>
        resumesLeft > 0 ? attempt(received, resumesLeft - 1) : Stream.fail(error),
      ),
    );
  };
  return attempt(options?.startByte ?? 0, maxResumes);
};
