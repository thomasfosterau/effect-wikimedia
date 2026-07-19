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
 * @module tests/perf
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { parse, serialize } from "../src/wikitext";

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

    // Single-digit ms is the target; 30 ms is the regression ceiling.
    expect(best).toBeLessThan(30);
  });

  it("round-trips the large article without error", () => {
    expect(serialize(parse(largeArticle))).toBe(largeArticle);
  });
});
