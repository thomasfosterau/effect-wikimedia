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

/** The best of `runs` timed parses of `src`, in ms, after a JIT warm-up. */
function bestParseTime(src: string, runs = 20): number {
  for (let i = 0; i < 3; i++) parse(src);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    parse(src);
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

// The table scans step over nested constructs (#132) using one linear
// bracket-matching pass. These guard against that turning quadratic, which
// recursive descent does on unclosed braces: each failed `{{` rescans the rest
// of the input (a first attempt that skipped with the parser's own `try*`
// methods took 84 ms on a fifth of `strayTable`, growing as the square of its
// length). Uncontended, each
// parse takes a few ms; the 250 ms ceiling leaves the same contended-runner
// headroom as the article test above while staying far below a quadratic scan.
describe("performance floor: wikitables (#132)", () => {
  const row =
    '|-\n| {{flagicon|FRA}} [[France]] || style="x" | 1<ref>{{cite web|url=http://x|title=y}}</ref>' +
    ' || {{Infobox\n|a=b\n}}\n! scope="row" | {{abbr|A|B}} !! [[a|b]] <!-- c -->\n';
  const largeTable = `{|\n${row.repeat(250)}|}\n`;
  const strayTable = `{|\n${"|-\n| {{stray a || b\n| c\n".repeat(2000)}|}\n`;
  // Long closing runs: matching must consume a run of `}` or `]` in one pass,
  // not rescan the rest of the run after each 2- or 3-character match.
  const cell = (content: string): string => `{|\n| ${content}\n|}\n`;
  const braceRunTable = cell(`${"{".repeat(40_000)}${"}".repeat(40_000)}`);
  const linkRunTable = cell(`${"[[".repeat(20_000)}${"]]".repeat(20_000)}`);
  const mixedRunTable = cell(`${"[[{{".repeat(10_000)}${"}}".repeat(10_000)}`);

  for (const [name, src] of [
    ["a table of templates and citations", largeTable],
    ["a table with an unclosed {{ in every row", strayTable],
    ["a cell holding one long run of { then of }", braceRunTable],
    ["a cell holding one long run of [[ then of ]]", linkRunTable],
    ["a cell holding [[{{ runs closed only by }}", mixedRunTable],
  ] as const) {
    it(`parses ${name} (${src.length} chars) in linear time`, () => {
      const best = bestParseTime(src);
      // eslint-disable-next-line no-console
      console.log(`[perf] parse ${name}, ${src.length} chars: best ${best.toFixed(2)} ms`);
      expect(best).toBeLessThan(250);
      expect(serialize(parse(src))).toBe(src);
    });
  }
});
