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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient } from "effect/http";
import { Core, Dumps } from "../../src/index.ts";
import { runTest, runTestExit } from "../helpers/effect.ts";

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
