/**
 * Unit tests for the Node-only dump sources (`src/dumps/sources.ts`): the file
 * source with inline gzip decompression, the pluggable {@link Dumps.gunzip} /
 * {@link Dumps.decompressWith} stages, the **interruption teardown** guarantee
 * (cancelling the Effect destroys the decompression source — no orphaned
 * work), and the **resumable** HTTP range download (offset tracked across a
 * mid-stream failure). The network is stubbed at `FetchHttpClient.Fetch`.
 *
 * @module tests/dumps/sources
 */

import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compose, Duplex, PassThrough, Readable, Transform } from "node:stream";
import { createGunzip, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
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

describe("a decompressor that is not a Node stream", () => {
  // The structural type admits it, so the runtime must reject it. Without
  // that check the stream never settles and ignores interruption, so
  // `Effect.timeout` can't bound it; racing a timer turns a regression into
  // a prompt failure instead of a test timeout.
  const failsPromptly = async <A, E>(stream: Stream.Stream<A, E>): Promise<E> => {
    const outcome = await Promise.race([
      runTestExit(Stream.runDrain(stream)),
      wait(1000).then(() => "hung" as const),
    ]);
    if (outcome === "hung") throw new Error("the stream hung instead of failing");
    return expectFailureInstanceOf(outcome, Dumps.SourceError);
  };

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
