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
 * posture. So decompression is modelled as an injectable Node `Transform`
 * factory ({@link Decompressor}): gzip is built in, and a caller who needs the
 * `.json.bz2` variant supplies their own bzip2 transform to {@link fromFile}
 * or {@link decompressWith}. No bzip2 code, and no bzip2 dependency, ships
 * here.
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
import { compose, isReadable, isWritable, Readable } from "node:stream";
import type { Duplex } from "node:stream";
import { createGunzip } from "node:zlib";
import * as Effect from "effect/Effect";
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
  reason instanceof Error ? reason.message : String(reason);

/**
 * Bridges Node's web-stream types to the DOM `ReadableStream` the `effect`
 * `Stream` combinators are typed against. `@types/node` and the `dom` lib
 * each declare an incompatible `ReadableStream`; the cast (through `unknown`)
 * is the sanctioned reconciliation at the one interop seam — used only to turn
 * an effect-produced web stream back into a Node `Readable` for a Node
 * `Transform` stage.
 */
type WebByteStream = ReadableStream<Uint8Array>;
const webToNode = (web: WebByteStream): Readable =>
  Readable.fromWeb(web as unknown as Parameters<typeof Readable.fromWeb>[0]);

const sourceError = (reason: unknown): SourceError =>
  new SourceError({ description: `dumps/source-read-failed: ${describe(reason)}` });

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
  destroy(): unknown;
}

/**
 * The part of a Node `Duplex` that a {@link Decompressor} returns: writable
 * (compressed bytes in) and readable (decompressed bytes out). Declared
 * structurally so the package's declarations need no `node:stream` types.
 * At runtime the value must be a real Node `Duplex` or `Transform` (such as
 * `zlib.createGunzip()` or a bzip2 transform from a library), which this type
 * can't express: it is passed to Node's `stream.compose`. A value that
 * `node:stream` doesn't recognise as a stream fails the stream with a
 * {@link SourceError}; pass a real Node stream.
 */
export interface NodeDuplexLike extends NodeReadableLike {
  /** Writes a chunk of compressed input. */
  write(chunk: Uint8Array): unknown;
  /** Signals the end of the compressed input. */
  end(): unknown;
}

/**
 * Recovers the Node `Duplex` a {@link Decompressor} returns from its
 * structural type, for `compose`. The contract on {@link NodeDuplexLike} is
 * that the value is a real Node stream, but the type admits a plain object,
 * and `compose` doesn't reject one: the composed stream never settles. So
 * this checks first and throws, which {@link fromNodeReadable} turns into a
 * {@link SourceError}. The check is a heuristic, not a proof: `isReadable` /
 * `isWritable` return `null` only when the value's `readable` / `writable`
 * aren't booleans (a destroyed or ended Node stream gives `false`), so a
 * plain object with `readable: true, writable: true` still passes it and
 * hangs in `compose`.
 */
const asNodeDuplex = (stream: NodeDuplexLike): Duplex => {
  const duplex = stream as unknown as Duplex;
  if (isReadable(duplex) === null || isWritable(duplex) === null) {
    throw new TypeError(
      "the decompressor must return a Node stream Duplex or Transform, not a plain object",
    );
  }
  return duplex;
};

// ── Node Readable → Stream<Uint8Array> ───────────────────────────────────

const destroyReadable = (readable: NodeReadableLike): void => {
  if (!readable.destroyed) readable.destroy();
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
 * `promise` after the bound is swallowed: the race has already settled, and
 * an unhandled rejection would crash the process.
 */
const settleWithin = <A>(promise: Promise<A>, ms: number, fallback: A): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<A>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  promise.catch(() => undefined);
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
 * A scope finalizer destroys the Readable on stream teardown, which is the
 * interruption guarantee: cancelling the consuming Effect destroys the
 * Readable and anything composed into it — an open file descriptor, an
 * in-flight gunzip — so no decompression work is orphaned. It holds while the
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
): Stream.Stream<Uint8Array, SourceError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const readable = yield* Effect.try({ try: evaluate, catch: sourceError });
      // Covers teardown that lands before `Stream.fromAsyncIterable` has
      // created the iterator and registered its `return()` as a finalizer: an
      // interruption the fiber observes between this step and that one.
      yield* Effect.addFinalizer(() => Effect.sync(() => destroyReadable(readable)));
      return Stream.fromAsyncIterable(destroyOnReturn(readable), sourceError);
    }),
  );

// ── Decompression stages ─────────────────────────────────────────────────

/**
 * A decompression stage: a factory for a fresh Node `Transform` (bytes →
 * bytes), called once per stream. Typed as {@link NodeDuplexLike}, so any
 * Node `Duplex` or `Transform` fits. Pass a real Node stream: a value that
 * `node:stream` doesn't recognise as a stream fails the stream it feeds with
 * a {@link SourceError}.
 */
export type Decompressor = () => NodeDuplexLike;

/** The built-in gzip decompressor — `zlib.createGunzip()`. Covers `.json.gz`. */
export const gunzipTransform: Decompressor = () => createGunzip();

/**
 * Lifts a {@link Decompressor} into a `Stream` stage: `Stream<Uint8Array>` →
 * `Stream<Uint8Array>`, pushing the bytes through a fresh Node transform. A
 * decompressor that returns a value `node:stream` doesn't recognise as a
 * stream fails the stage with a {@link SourceError} and cancels the source. Use
 * it to decompress a source that is *not* a local file — e.g. an
 * {@link fromHttpRange} download — or to inject a bzip2 transform the package
 * does not ship. Composes with any byte source.
 */
export const decompressWith =
  (transform: Decompressor) =>
  <E, R>(source: Stream.Stream<Uint8Array, E, R>): Stream.Stream<Uint8Array, SourceError, R> =>
    Stream.unwrap(
      // `compose` (not `.pipe`) so tearing the output down destroys the whole
      // chain — the web-source reader and the transform — leaving no orphaned
      // decompression work behind.
      Effect.map(Stream.toReadableStreamEffect(source), (web) =>
        fromNodeReadable(() => {
          // Building `web` already started the source, so a rejected stage
          // must cancel it, or the upstream (an HTTP body, a file) stays open.
          // Cancel only here: once `webToNode` has run, `web` is locked. If
          // the source has already failed, `web` is errored and `cancel()`
          // rejects with that error; swallow it, since the stage rejection is
          // what this stream reports, and an unhandled rejection would crash
          // the process.
          let stage: Duplex;
          try {
            stage = asNodeDuplex(transform());
          } catch (error) {
            web.cancel().catch(() => undefined);
            throw error;
          }
          return compose(webToNode(web), stage);
        }),
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
   * transform) or to force a codec.
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
 * {@link Decompressor}.
 */
export const fromFile = (
  path: string,
  options?: FromFileOptions,
): Stream.Stream<Uint8Array, SourceError> => {
  const decompressor = decompressorFor(path, options?.decompressor);
  return fromNodeReadable(() => {
    if (decompressor === null) return createReadStream(path);
    // Check the stage before opening the file, so a rejected one leaks no fd.
    const stage = asNodeDuplex(decompressor());
    // `compose` so destroying the decompressor also destroys the file read —
    // the fd is closed on interruption, not orphaned. If opening the file
    // throws, destroy the stage, which nothing else owns yet.
    try {
      return compose(createReadStream(path), stage);
    } catch (error) {
      stage.destroy();
      throw error;
    }
  });
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
