/**
 * Multistream decoding on a pool of workers (#211, slice 4): each
 * {@link MultistreamRange} is sent to a worker as one RPC, which opens,
 * decompresses and decodes it there and streams its
 * {@link PageRevisionRecord}s back. Built on `effect/rpc`'s worker protocol,
 * so the pool, its size and the transport are the caller's: this module
 * imports no platform code and stays `platform: "neutral"`.
 *
 * The caller writes the worker's entry file, serving {@link MultistreamRpcs}
 * with {@link multistreamWorkerHandlers}, and provides the main side's
 * `RpcClient.layerProtocolWorker` and their platform's `Worker` spawner; the
 * README has a Node `worker_threads` recipe.
 *
 * @copyright Thomas Foster
 * @module dumps/workers
 */

import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Rpc, RpcClient, type RpcClientError, RpcGroup } from "effect/rpc";
import { MultistreamRange } from "./multistream.ts";
import { PageRevisionRecord, pageRecords } from "./xml.ts";

/**
 * A worker failed to open or read a range's bytes: whatever the worker's
 * `open` failed with, described as text, since a failure of the caller's own
 * type cannot cross the thread boundary. Per-record decode problems are not
 * this: they arrive as {@link PageRevisionError} records.
 */
export class MultistreamRangeFailed extends Schema.TaggedError<
  MultistreamRangeFailed,
  { readonly brand: unique symbol }
>()("MultistreamRangeFailed", {
  /** The range whose bytes could not be read. */
  range: MultistreamRange,
  /** The `open` failure's message (its `message` when it has one), for logs. */
  description: Schema.String,
}) {}

/**
 * The RPC contract between the main side and its workers: one `DecodeRange`
 * request per {@link MultistreamRange}, answered with a stream of that
 * range's {@link PageRevisionRecord}s, in order, or a
 * {@link MultistreamRangeFailed}. Serve it in the worker entry file with
 * `RpcServer.layer(MultistreamRpcs)` and {@link multistreamWorkerHandlers}.
 */
export const MultistreamRpcs = RpcGroup.make(
  Rpc.make("DecodeRange", {
    payload: MultistreamRange,
    success: PageRevisionRecord,
    error: MultistreamRangeFailed,
    stream: true,
  }),
);

/**
 * The worker side's handler layer for {@link MultistreamRpcs}: each request's
 * range is opened with `open` (the decompressed bytes, as
 * {@link multistreamPageRecords} takes) and decoded with {@link pageRecords}.
 * A failure of `open`'s stream becomes a {@link MultistreamRangeFailed}
 * carrying its message. Provide it, with `RpcServer.layer(MultistreamRpcs)`
 * and `RpcServer.layerProtocolWorkerRunner`, in the worker's entry file.
 */
export const multistreamWorkerHandlers = <E, R>(
  open: (range: MultistreamRange) => Stream.Stream<Uint8Array, E, R>,
): Layer.Layer<Rpc.Handler<"DecodeRange">, never, R> =>
  MultistreamRpcs.toLayer({
    DecodeRange: (range) =>
      pageRecords(open(range)).pipe(
        // The failure's text for the error: its `message` when it has a string one.
        Stream.mapError(
          (error) =>
            new MultistreamRangeFailed({
              range,
              description:
                P.hasProperty(error, "message") && P.isString(error.message)
                  ? error.message
                  : String(error),
            }),
        ),
      ),
  });

/** Options for {@link multistreamPageRecordsInWorkers}. */
export interface MultistreamPageRecordsInWorkersOptions {
  /**
   * How many ranges to have in flight at once, across the pool. Size it to
   * the pool: its worker count times each worker's RPC `concurrency`. Their
   * records interleave as they arrive, though each range's own records stay
   * in order.
   */
  readonly concurrency: number;
}

/**
 * Decodes a range stream's pages on a pool of workers: each range goes to a
 * worker as one `DecodeRange` request ({@link MultistreamRpcs}), and the
 * records stream back. Needs an `RpcClient.Protocol`, such as
 * `RpcClient.layerProtocolWorker({ size })` over the platform's `Worker`
 * spawner, whose workers serve {@link multistreamWorkerHandlers}:
 *
 * ```ts
 * const pages = ranges.pipe(
 *   Dumps.multistreamPageRecordsInWorkers({ concurrency: 8 }),
 *   Stream.provide(protocol),
 * );
 * ```
 *
 * The same record stream as {@link multistreamPageRecords} gives, decoded
 * off the main thread. Fails with what the range stream fails with, a
 * {@link MultistreamRangeFailed} when a worker cannot read a range, or an
 * `RpcClientError` when the transport fails. To resume, record checkpoints
 * as {@link fromCheckpoint} describes, per range.
 */
export const multistreamPageRecordsInWorkers =
  (options: MultistreamPageRecordsInWorkersOptions) =>
  <E, R>(
    ranges: Stream.Stream<MultistreamRange, E, R>,
  ): Stream.Stream<
    PageRevisionRecord,
    E | MultistreamRangeFailed | RpcClientError.RpcClientError,
    R | RpcClient.Protocol
  > =>
    Stream.unwrap(
      Effect.map(RpcClient.make(MultistreamRpcs), (client) =>
        ranges.pipe(
          Stream.flatMap((range) => client.DecodeRange(range), {
            concurrency: options.concurrency,
          }),
        ),
      ),
    );
