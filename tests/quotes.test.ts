/**
 * The apostrophe jungle — bold/italic resolution against MediaWiki's
 * `doQuotes`. These assert the semantic {@link Formatting.mode} annotation;
 * the literal apostrophes always round-trip regardless (proven elsewhere).
 *
 * @module tests/quotes
 */

import { describe, expect, it } from "vite-plus/test";
import { type Formatting, type Node, parse } from "../src/wikitext/index.ts";

function formatting(src: string): Formatting[] {
  const out: Formatting[] = [];
  const collect = (nodes: readonly Node[]): void => {
    for (const n of nodes) {
      if (n._tag === "Formatting") out.push(n);
    }
  };
  collect(parse(src).children);
  return out;
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
