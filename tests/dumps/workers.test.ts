/**
 * Multistream decoding on workers (#211, slice 4): the record schemas'
 * round trip, the worker handlers, and the main side over an in-process
 * worker pool whose messages cross a real `structuredClone` boundary
 * (`tests/helpers/workers.ts`). The fixture dump is the synthetic
 * three-stream one `tests/dumps/multistream.test.ts` reads.
 *
 * @module tests/dumps/workers
 */

import unbzip2 from "unbzip2-stream";
import { layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assertInstanceOf } from "@effect/vitest/utils";
import { expect } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RpcClient, RpcServer } from "effect/rpc";
import type { WorkerError } from "effect/workers";
import { Dumps } from "../../src/index.ts";
import { fixturePath } from "../helpers/fixtures.ts";
import { inProcessWorkers } from "../helpers/workers.ts";

/** The worker's `open` failing, as a disk read can. */
class DiskGone extends Schema.TaggedError<DiskGone>()("DiskGone", { message: Schema.String }) {}

/** The multistream fixture's range listing and range opener, over the fixture paths. */
const multistream = Effect.fn("multistream")(function* () {
  const dumpPath = yield* fixturePath("dumps/multistream.xml.bz2");
  const indexPath = yield* fixturePath("dumps/multistream-index.txt.bz2");
  const ranges = (): Stream.Stream<
    Dumps.MultistreamRange,
    Dumps.SourceError | Dumps.MultistreamIndexError
  > =>
    Dumps.fromFile(indexPath, { decompressor: () => unbzip2() }).pipe(
      Dumps.multistreamIndexRecords,
      Dumps.multistreamRanges(),
    );
  const openRange = (range: Dumps.MultistreamRange) =>
    Dumps.fromMultistreamRange(dumpPath, range, () => unbzip2());
  return { ranges, openRange };
});

const collect = <A, E>(stream: Stream.Stream<A, E>): Effect.Effect<ReadonlyArray<A>, E> =>
  Stream.runCollect(stream);

const titles = (records: ReadonlyArray<Dumps.PageRevisionRecord>) =>
  Arr.map(records, (r) => Option.getOrNull(r.page.title));

/** A worker pool of `size` in-process workers serving `open`'s ranges, as an `RpcClient.Protocol`. */
const pool = <E>(
  size: number,
  open: (range: Dumps.MultistreamRange) => Stream.Stream<Uint8Array, E>,
): Layer.Layer<RpcClient.Protocol, WorkerError.WorkerError> =>
  RpcClient.layerProtocolWorker({ size, concurrency: 2 }).pipe(
    Layer.provide(
      inProcessWorkers((runner) =>
        RpcServer.layer(Dumps.MultistreamRpcs).pipe(
          Layer.provide(Dumps.multistreamWorkerHandlers(open)),
          Layer.provide(RpcServer.layerProtocolWorkerRunner),
          Layer.provide(runner),
          Layer.orDie,
        ),
      ),
    ),
  );

layer(NodeServices.layer)("record schemas", (it) => {
  it.effect("round-trips every fixture record through JSON and structuredClone", () =>
    Effect.gen(function* () {
      const { ranges, openRange } = yield* multistream();
      const records = yield* collect(ranges().pipe(Dumps.multistreamPageRecords(openRange)));
      expect(records.length).toBeGreaterThan(0);
      const json = Schema.fromJsonString(Schema.toCodecJson(Dumps.PageRevisionRecord));
      Arr.forEach(records, (record) => {
        const wire = structuredClone(Schema.encodeSync(Dumps.PageRevisionRecord)(record));
        expect(Schema.decodeSync(Dumps.PageRevisionRecord)(wire)).toEqual(record);
        expect(Schema.decodeSync(json)(Schema.encodeSync(json)(record))).toEqual(record);
      });
    }),
  );

  it("writes an absent field as null on the wire", () => {
    const range: Dumps.MultistreamRange = {
      start: 0,
      end: Option.none(),
      pageCount: 1,
      firstPageId: 1,
      lastPageId: 1,
    };
    expect(Schema.encodeSync(Dumps.MultistreamRange)(range)).toEqual({ ...range, end: null });
  });
});

/** A byte stream that fails at once with `DiskGone`. */
const failingStream = (): Stream.Stream<Uint8Array, DiskGone> =>
  Stream.fail(new DiskGone({ message: "disk gone" }));

layer(NodeServices.layer)("multistreamPageRecordsInWorkers", (it) => {
  it.effect("decodes every range on the pool, with the records the main thread would decode", () =>
    Effect.gen(function* () {
      const { ranges, openRange } = yield* multistream();
      const local = yield* collect(ranges().pipe(Dumps.multistreamPageRecords(openRange)));
      const remote = yield* collect(
        ranges().pipe(
          Dumps.multistreamPageRecordsInWorkers({ concurrency: 4 }),
          Stream.provide(pool(2, openRange)),
        ),
      );
      expect(remote).toHaveLength(local.length);
      expect(remote).toEqual(expect.arrayContaining([...local]));
      expect(titles(remote)).toEqual(expect.arrayContaining(["Ada Lovelace", "Zebra"]));
    }),
  );

  it.effect("keeps the range order at concurrency 1", () =>
    Effect.gen(function* () {
      const { ranges, openRange } = yield* multistream();
      const local = yield* collect(ranges().pipe(Dumps.multistreamPageRecords(openRange)));
      const remote = yield* collect(
        ranges().pipe(
          Dumps.multistreamPageRecordsInWorkers({ concurrency: 1 }),
          Stream.provide(pool(1, openRange)),
        ),
      );
      expect(remote).toEqual(local);
    }),
  );

  it.effect(
    "fails with MultistreamRangeFailed, carrying the range and message, when a worker cannot open it",
    () =>
      Effect.gen(function* () {
        const { ranges } = yield* multistream();
        const [first] = yield* collect(ranges());
        const error = yield* Effect.flip(
          Stream.runDrain(
            ranges().pipe(
              Dumps.multistreamPageRecordsInWorkers({ concurrency: 1 }),
              Stream.provide(pool(1, failingStream)),
            ),
          ),
        );
        assertInstanceOf(error, Dumps.MultistreamRangeFailed);
        expect(error.description).toBe("disk gone");
        expect(error.range).toEqual(first);
      }),
  );
});
