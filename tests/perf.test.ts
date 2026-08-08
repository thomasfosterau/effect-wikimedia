/**
 * Performance floor (issue #1065): a full large article parses in
 * single-digit milliseconds — this parser is meant for dump pipelines, where
 * per-article cost is multiplied by millions.
 *
 * The threshold is a deliberately loose ceiling (well above the observed
 * single-digit figure) so the gate survives slow/contended CI runners while
 * still catching an order-of-magnitude regression. The measured best time is
 * logged for visibility.
 *
 * **The ceiling was raised 30 ms → 60 ms (#1540).** The old value did not in
 * fact survive a contended runner, despite the paragraph above claiming it
 * would: after #1523 collapsed CI into a single job, every task shares one
 * runner, and this test failed four times across three different heads —
 * including `trunk` itself — at 37.97, 33.28, 31.25 and 30.71 ms. Off that
 * runner the same measurement is **1.16 ms** on a developer machine and
 * **2.57 ms** in a loaded container, so the CI numbers are ~12–33× the real
 * cost and are measuring runner contention, not the parser.
 *
 * This is a **deliberate loosening of a real gate**, made knowingly rather than
 * by drift: `docs/performance.md` is explicit that performance regresses
 * silently in this repo, and a 60 ms ceiling against a 1–3 ms baseline is 20×
 * headroom at worst, so only an order-of-magnitude regression now trips it.
 * That is the stated intent of this test, but the margin for anything subtler
 * is gone. The alternative directions — a calibration-relative ratio, or
 * giving timing-sensitive tasks their own runner — stay open on #1540.
 *
 * @module tests/perf
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { parse, serialize } from "../src/wikitext/index.ts";

const ada = readFileSync(
  fileURLToPath(new URL("./fixtures/ada-lovelace.txt", import.meta.url)),
  "utf8",
);

// A large, realistic article: the fixture repeated to a substantial size.
const largeArticle = `${ada}\n`.repeat(60);

describe("performance floor", () => {
  it(`parses a large article (${largeArticle.length} chars) fast`, () => {
    // Warm up the JIT so the measurement reflects steady state.
    for (let i = 0; i < 5; i++) serialize(parse(largeArticle));

    let best = Number.POSITIVE_INFINITY;
    const runs = 30;
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      parse(largeArticle);
      best = Math.min(best, performance.now() - t0);
    }

    // eslint-disable-next-line no-console
    console.log(`[perf] parse ${largeArticle.length} chars: best ${best.toFixed(2)} ms`);

    // Single-digit ms is the target (1.16 ms uncontended); 60 ms is the
    // regression ceiling — sized to clear the worst contended measurement
    // observed under the single-job CI (37.97 ms) while still catching an
    // order-of-magnitude regression. See the module doc for the trade.
    expect(best).toBeLessThan(60);
  });

  it("round-trips the large article without error", () => {
    expect(serialize(parse(largeArticle))).toBe(largeArticle);
  });
});
