/**
 * An in-process stand-in for a platform's workers, for the `Dumps` worker
 * tests: each "worker" is a `MessageChannel`, so every message crosses a
 * real `structuredClone` boundary, and its runner side is the layer `serve`
 * builds, launched in the worker's scope. No threads and no network.
 *
 * @module tests/helpers/workers
 */

import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { Worker, WorkerRunner } from "effect/workers";

/** A runner platform over one end of a channel, speaking the worker platform's `[kind, data]` frames. */
const runnerPlatformOn = (port: MessagePort): Layer.Layer<WorkerRunner.WorkerRunnerPlatform> =>
  Layer.succeed(WorkerRunner.WorkerRunnerPlatform, {
    start: <O, I>() => {
      /** The runner's `run` on this end of the channel: answers `[0, input]` frames with `handler`. */
      const runOn = Effect.fn("inProcessWorkers.run")(function* <A, E, R>(
        handler: (portId: number, message: I) => Effect.Effect<A, E, R> | void,
      ) {
        const fibers = yield* FiberSet.make<A, E>();
        const fork = yield* FiberSet.runtime(fibers)<R>();
        port.addEventListener("message", (event: MessageEvent<readonly [0, I] | readonly [1]>) => {
          const frame = event.data;
          if (frame[0] !== 0) return;
          const result = handler(0, frame[1]);
          if (Effect.isEffect(result)) fork(result);
        });
        port.start();
        // The worker platform's handshake: `[0]` says the worker is ready.
        port.postMessage([0]);
        return yield* Effect.never;
      });
      return Effect.succeed<WorkerRunner.WorkerRunner<O, I>>({
        run: (handler) => Effect.scoped(runOn(handler)),
        send: (_, message) => Effect.sync(() => port.postMessage([1, message])),
        sendUnsafe: (_, message) => port.postMessage([1, message]),
      });
    },
  });

/** Opens a worker's channel in `scope`, launching `serve`'s runner layer on its far end. */
const openWorker = Effect.fn("inProcessWorkers.setup")(function* <E>(
  serve: (runner: Layer.Layer<WorkerRunner.WorkerRunnerPlatform>) => Layer.Layer<never, E>,
  scope: Scope.Scope,
) {
  const channel = new MessageChannel();
  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => {
      channel.port1.close();
      channel.port2.close();
    }),
  );
  yield* Layer.launch(serve(runnerPlatformOn(channel.port2))).pipe(Effect.forkIn(scope));
  return channel.port1;
});

/**
 * A `WorkerPlatform` and `Spawner` whose workers run `serve`'s layer in
 * process: spawning one opens a channel and launches `serve(runner)` on its
 * far end, and closing the worker's scope stops it.
 */
export const inProcessWorkers = <E>(
  serve: (runner: Layer.Layer<WorkerRunner.WorkerRunnerPlatform>) => Layer.Layer<never, E>,
): Layer.Layer<Worker.WorkerPlatform | Worker.Spawner> =>
  Layer.merge(
    Layer.succeed(
      Worker.WorkerPlatform,
      Worker.makePlatform<number>()({
        setup: ({ scope }) => openWorker(serve, scope),
        listen: ({ port, emit }) =>
          Effect.sync(() => {
            port.addEventListener("message", (event: MessageEvent) => emit(event.data));
            port.start();
          }),
      }),
    ),
    Worker.layerSpawner((id) => id),
  );
