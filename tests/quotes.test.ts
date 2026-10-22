/**
 * The apostrophe jungle — bold/italic resolution against MediaWiki's
 * `doQuotes`. These assert the semantic {@link Formatting.mode} annotation;
 * the literal apostrophes always round-trip regardless (proven elsewhere).
 *
 * @module tests/quotes
 */

import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import { describe, expect, it } from "vite-plus/test";
import { type Formatting, type Node, parse } from "../src/wikitext/index.ts";

const isFormatting = (n: Node): n is Formatting => Predicate.isTagged(n, "Formatting");

function formatting(src: string): Formatting[] {
  return Arr.filter(parse(src).children, isFormatting);
}

describe("apostrophe run normalisation", () => {
  it("maps run lengths to italic / bold / bold-italic", () => {
    expect(formatting("''i''")[0].mode).toBe("italic");
    expect(formatting("'''b'''")[0].mode).toBe("bold");
    expect(formatting("'''''bi'''''")[0].mode).toBe("bold-italic");
  });

  it("treats a run of four as one literal apostrophe plus bold", () => {
    const f = formatting("''''x''''")[0];
    expect(f.mode).toBe("bold");
    expect(f.leadingLiterals).toBe(1);
    expect(f.marks).toBe("''''"); // literal text preserved verbatim
  });

  it("treats surplus over five as leading literals plus bold-italic", () => {
    const f = formatting("'''''''x")[0]; // seven apostrophes
    expect(f.mode).toBe("bold-italic");
    expect(f.leadingLiterals).toBe(2);
  });
});

describe("odd-bold single-letter heuristic", () => {
  it("reinterprets a lone bold opener after a single-letter word as italic", () => {
    // "I'''m" — MediaWiki reads the ''' as '' + a literal apostrophe, so the
    // run becomes italic (the classic apostrophe-jungle case).
    const f = formatting("I'''m sure''");
    expect(f[0].mode).toBe("italic");
    expect(f[0].leadingLiterals).toBe(1);
  });

  it("leaves an even number of bold markers as bold", () => {
    const runs = formatting("'''a''' and '''b'''");
    expect(runs.every((r) => r.mode === "bold")).toBe(true);
  });

  it("resolves each line independently", () => {
    const runs = formatting("'''one line\n''second line''");
    // Line 1 has a single (odd) bold marker; line 2 is a clean italic pair.
    expect(runs[runs.length - 1].mode).toBe("italic");
  });
});

describe("odd-bold heuristic matches doQuotes (#137)", () => {
  /** Which run on a one-line `src` is a reinterpreted `'''` (`-1` for none), checking it reads as `'` + `''`. */
  const reinterpreted = (src: string): number => {
    const runs = formatting(src);
    const isReinterpreted = (r: Formatting): boolean =>
      r.marks.length >= 3 && r.marks.length - r.leadingLiterals === 2;
    expect(runs.filter(isReinterpreted).map((r) => r.mode)).not.toContain("bold");
    return runs.findIndex(isReinterpreted);
  };

  it("leaves a lone bold run bold when the line has no italics (the issue's repro)", () => {
    const [f] = formatting("The '''bold");
    expect(f).toMatchObject({ mode: "bold", leadingLiterals: 0 });
  });

  it("leaves odd bold with even italics alone", () => {
    expect(reinterpreted("The '''bold and ''it'' too")).toBe(-1);
  });

  it("reinterprets one bold run when both counts are odd", () => {
    expect(reinterpreted("The '''bold and ''it")).toBe(0);
    // A ''''' counts as one bold and one italic: these lines have even bold.
    expect(reinterpreted("a '''b '''''c")).toBe(-1);
    expect(reinterpreted("x a'''b '''''c ''d")).toBe(-1);
  });

  it("prefers a single-letter word, then a longer word, then a space", () => {
    // Runs: after a space, after a multi-letter word, after a single-letter word.
    expect(reinterpreted("x '''a bc'''d e'''f ''g")).toBe(2);
    // No single-letter word: the multi-letter one beats the space.
    expect(reinterpreted("x '''a bc'''d '''e ''f")).toBe(1);
    // Only spaces: the first.
    expect(reinterpreted("x '''a b '''c d '''e ''f")).toBe(0);
  });

  it("counts the line start as a longer word, not a space", () => {
    expect(reinterpreted("'''a bc'''d '''e ''f")).toBe(0);
    expect(formatting("z\n'''a bc'''d '''e ''f")[0]).toMatchObject({
      mode: "italic",
      leadingLiterals: 1,
    });
  });

  it("reads the apostrophe a run of four sheds as part of the preceding text", () => {
    // `x ''''a`: MediaWiki sees `x '` before the `'''`, a single-letter word.
    const runs = formatting("x ''''a bc'''d '''e ''f");
    expect(runs[0]).toMatchObject({ mode: "italic", leadingLiterals: 2 });
    expect(runs[1].mode).toBe("bold");
  });
});
