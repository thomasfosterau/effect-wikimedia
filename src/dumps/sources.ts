/// <reference types="node" />
/**
 * @copyright Thomas Foster
 *
 * **Dump sources & decompression** — the one Node-only entry point in
 * `@thomasfosterau/effect-wikimedia`. A dump is ultimately a
 * `Stream<Uint8Array>`; this module supplies that byte stream from a local
 * file or a resumable HTTP range download, and the pluggable decompression
 * stages that sit in front of the {@link "./entities"} / {@link "./xml"}
 * pipelines.
 *
 * **Why Node-only, and why it is quarantined here.** Streaming a
 * multi-gigabyte compressed dump wants `node:fs` / `node:zlib` / `node:stream`
 * — capabilities a Worker / browser build does not have. The issue sanctions
 * a Node-only entry *for this module*; the rest of the package (including the
 * {@link "./entities"} and {@link "./xml"} pipelines themselves) stays
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
 * @module dumps/sources
 */

import { createReadStream } from "node:fs";
import { compose, Readable } from "node:stream";
import type { Duplex } from "node:stream";
import { createGunzip } from "node:zlib";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

// ── Error & etiquette ────────────────────────────────────────────────────

/** A failure reading or decompressing a dump source. */
export class SourceError extends Schema.TaggedErrorClass<SourceError>()("SourceError", {
  description: Schema.String,
}) {}

/** Polite UA for HTTP range downloads (mirrors {@link "../core".USER_AGENT}). */
const USER_AGENT =
  "effect-wikimedia/0.0.0 (+https://github.com/thomasfosterau/website; mailto:me@thomasfoster.au)";

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

// ── Node Readable → Stream<Uint8Array> ───────────────────────────────────

/**
 * Wraps any Node `Readable` as a `Stream<Uint8Array>`. The bytes are pulled
 * through the Readable's **async iterator**, one chunk at a time — that is the
 * constant-memory guarantee: async iteration applies native backpressure, so
 * a fast producer (a gunzip decompressing a tiny `.gz` into hundreds of MB) is
 * paused between pulls and the whole file is never buffered.
 *
 * A scope finalizer destroys the Readable on stream teardown, which is the
 * interruption guarantee: cancelling the consuming Effect destroys the
 * Readable and anything composed into it — an open file descriptor, an
 * in-flight gunzip — so no decompression work is orphaned.
 */
export const fromNodeReadable = (
  evaluate: () => Readable,
): Stream.Stream<Uint8Array, SourceError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const readable = evaluate();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (!readable.destroyed) readable.destroy();
        }),
      );
      return Stream.fromAsyncIterable(readable as AsyncIterable<Uint8Array>, sourceError);
    }),
  );

// ── Decompression stages ─────────────────────────────────────────────────

/** A decompression stage: a factory for a fresh Node `Transform` (bytes → bytes). */
export type Decompressor = () => Duplex;

/** The built-in gzip decompressor — `zlib.createGunzip()`. Covers `.json.gz`. */
export const gunzipTransform: Decompressor = () => createGunzip();

/**
 * Lifts a {@link Decompressor} into a `Stream` stage: `Stream<Uint8Array>` →
 * `Stream<Uint8Array>`, pushing the bytes through a fresh Node transform. Use
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
        fromNodeReadable(() => compose(webToNode(web), transform()) as unknown as Readable),
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
    const file = createReadStream(path);
    // `compose` so destroying the decompressor also destroys the file read —
    // the fd is closed on interruption, not orphaned.
    return decompressor === null ? file : (compose(file, decompressor()) as unknown as Readable);
  });
};

// ── HTTP range source (resumable) ────────────────────────────────────────

/** Options for {@link fromHttpRange}. */
export interface FromHttpRangeOptions {
  /** Byte offset to start from (for an explicit resume). Defaults to `0`. */
  readonly startByte?: number;
  /** Extra attempts after a mid-stream transport failure, each resuming from the last received byte. Defaults to `3`. */
  readonly maxResumes?: number;
}

const DEFAULT_MAX_RESUMES = 3;

/** Issues a ranged GET from `offset` and returns its body byte stream. */
const rangeRequest = (
  url: string,
  offset: number,
): Stream.Stream<Uint8Array, SourceError, HttpClient.HttpClient> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request = HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeaders({ range: `bytes=${offset}-`, "user-agent": USER_AGENT }),
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
 * context.
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
    return rangeRequest(url, offset).pipe(
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
