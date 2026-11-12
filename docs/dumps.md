# Dumps: bzip2, multistream and workers

## bzip2 dumps

Wikidata publishes its entity dumps as `.json.gz` and `.json.bz2`. `Dumps.fromFile` decompresses a `.gz` file by itself, but Node has no bzip2, and the package ships no decoder. Bring one as the `decompressor`, for example [`unbzip2-stream`](https://www.npmjs.com/package/unbzip2-stream):

```ts
import * as Stream from "effect/Stream";
import unbzip2 from "unbzip2-stream";
import { Dumps } from "@thomasfosterau/effect-wikimedia";

const itemCount = Dumps.fromFile("latest-all.json.bz2", { decompressor: () => unbzip2() }).pipe(
  Dumps.entityRecords,
  Dumps.onlyEntities,
  Stream.runCount,
);
```

`Dumps.decompressWith(() => unbzip2())` decompresses any other byte stream, such as a `Dumps.fromHttpRange` download. Return a new decoder from each call. `unbzip2-stream` returns a classic (pre-streams2) Node stream, which `Dumps` adapts for `stream.compose`; a `Transform` from another library works as is. `unbzip2-stream` is pure JavaScript and decodes on the event loop, so where both are published the `.json.gz` dump avoids that cost.

## Multistream dumps

Wikipedia's `pages-articles-multistream.xml.bz2` dumps are a run of independent bzip2 streams of 100 pages each, listed by `pages-articles-multistream-index.txt.bz2`. `Dumps.multistreamIndexRecords` and `Dumps.multistreamRanges` turn the index into byte ranges, and `Dumps.fromMultistreamRange` reads one range straight from the compressed file, so a page can be read without decompressing everything before it:

```ts
const ranges = Dumps.fromFile("enwiki-pages-articles-multistream-index.txt.bz2", {
  decompressor: () => unbzip2(),
}).pipe(Dumps.multistreamIndexRecords, Dumps.multistreamRanges());

const pagesOf = (range: Dumps.MultistreamRange) =>
  Dumps.fromMultistreamRange("enwiki-pages-articles-multistream.xml.bz2", range, () =>
    unbzip2(),
  ).pipe(Dumps.pageRecords);
```

To read one page without scanning the dump, `Dumps.findMultistreamRange(Dumps.byTitle("Ada Lovelace"))` (or `Dumps.byPageId`) scans the index for the range that holds it. To process the whole dump, `Dumps.multistreamPageRecords(open, { concurrency })` decodes each range in turn, or several at once. To resume an interrupted run, `Dumps.fromCheckpoint(offset)` skips the ranges before the `end` of the last range you finished:

```ts
const pages = ranges.pipe(
  Dumps.fromCheckpoint(savedOffset),
  Dumps.multistreamPageRecords((range) =>
    Dumps.fromMultistreamRange("enwiki-pages-articles-multistream.xml.bz2", range, () => unbzip2()),
  ),
);
```

## Decoding on several cores

To decode on several cores, `Dumps.multistreamPageRecordsInWorkers({ concurrency })` sends each range to a pool of workers over `effect/rpc`, and the records stream back. The package imports no platform code, so you write the worker's entry file and pick the platform. In Node, with `@effect/platform-node`:

```ts
// worker.ts: serves the ranges the main thread sends.
import * as Layer from "effect/Layer";
import { RpcServer } from "effect/rpc";
import { NodeRuntime, NodeWorkerRunner } from "@effect/platform-node";

RpcServer.layer(Dumps.MultistreamRpcs).pipe(
  Layer.provide(
    Dumps.multistreamWorkerHandlers((range) =>
      Dumps.fromMultistreamRange("enwiki-pages-articles-multistream.xml.bz2", range, () =>
        unbzip2(),
      ),
    ),
  ),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
  Layer.launch,
  NodeRuntime.runMain,
);
```

```ts
// main.ts: a pool of 8 worker_threads, each decoding 2 ranges at a time.
import { Worker } from "node:worker_threads";
import { RpcClient } from "effect/rpc";
import { NodeWorker } from "@effect/platform-node";

const pool = RpcClient.layerProtocolWorker({ size: 8, concurrency: 2 }).pipe(
  Layer.provide(NodeWorker.layer(() => new Worker(new URL("./worker.js", import.meta.url)))),
);

const pages = ranges.pipe(
  Dumps.multistreamPageRecordsInWorkers({ concurrency: 16 }),
  Stream.provide(pool),
);
```

The records cross the thread boundary through their schemas (`Dumps.PageRevisionRecord`, `Dumps.MultistreamRange`, …), which encode an absent field as `null`, so they also suit persisting. A worker that can't read a range fails the stream with `Dumps.MultistreamRangeFailed`.

`Dumps.fromFile` takes `start` / `end` for any byte range of a file, and `Dumps.fromHttpRange` takes `startByte` / `endByte` to download one range (`end` and `endByte` are exclusive, as a range's `end` is).
