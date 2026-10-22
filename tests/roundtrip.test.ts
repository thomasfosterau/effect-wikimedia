/**
 * The headline acceptance criteria for the wikitext parser (issue #1065):
 *
 * - **Corpus round-trip**: recorded real-article fixtures (including
 *   pathological nesting) parse without error and `serialize(parse(x)) === x`
 *   byte-for-byte.
 * - **Span fidelity**: every node in a freshly-parsed tree serializes to
 *   exactly its own source slice — the local invariant that composes to the
 *   whole-document guarantee and underpins splice edits.
 * - **Fuzz never-throws / always round-trips**: arbitrary byte strings parse
 *   without throwing and round-trip exactly.
 *
 * @module tests/roundtrip
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { type Node, parse, serialize, serializeNode, walk } from "../src/wikitext/index.ts";

/** `JSON.stringify` through the `Schema` JSON boundary (encoding `Unknown` is the identity). */
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** `f(0)`, …, `f(n - 1)` in order; empty when `n <= 0` (`Arr.makeBy` never is). */
const times = <A>(n: number, f: (i: number) => A): ReadonlyArray<A> =>
  n <= 0 ? [] : Arr.makeBy(n, f);

const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const fixtures = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".txt"))
  .map((f) => ({ name: f, text: readFileSync(fixturesDir + f, "utf8") }));

/** Asserts `serialize(node) === source.slice(span)` for every node, recursively. */
function assertSpanFidelity(source: string, doc: ReturnType<typeof parse>): void {
  walk(doc, (node: Node) => {
    const slice = source.slice(node.span.start, node.span.end);
    expect(serializeNode(node), `node ${node._tag} @ ${node.span.start}`).toBe(slice);
  });
}

describe("corpus round-trip", () => {
  it("has fixtures to test", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  Arr.forEach(fixtures, ({ name, text }) => {
    it(`round-trips ${name} byte-identically`, () => {
      const doc = parse(text);
      expect(serialize(doc)).toBe(text);
    });

    it(`preserves span fidelity for every node in ${name}`, () => {
      const doc = parse(text);
      assertSpanFidelity(text, doc);
    });

    it(`tiles ${name} contiguously with no gaps`, () => {
      const doc = parse(text);
      const cursor = Arr.reduce(doc.children, 0, (start, node) => {
        expect(node.span.start).toBe(start);
        return node.span.end;
      });
      expect(cursor).toBe(text.length);
    });
  });
});

// ── property-based fuzz ────────────────────────────────────────────────

/** A tiny deterministic xorshift PRNG so fuzz failures are reproducible. */
function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
}

// An alphabet skewed toward the structural delimiters that stress the
// parser, plus a little prose and whitespace.
const FUZZ_ALPHABET = "{}[]<>|='\"&#;-!/*abcde 12\nö".split("");

function randomWikitext(rand: () => number, maxLen: number): string {
  const len = Math.floor(rand() * maxLen);
  return times(len, () => FUZZ_ALPHABET[Math.floor(rand() * FUZZ_ALPHABET.length)]).join("");
}

describe("fuzz: never throws, always round-trips", () => {
  it("survives 5000 random structural strings", () => {
    const rand = prng(0x9e3779b9);
    Arr.forEach(
      times(5000, (i) => i),
      (i) => {
        const input = randomWikitext(rand, 200);
        let out: string;
        expect(
          () => {
            out = serialize(parse(input));
          },
          `input #${i}: ${encodeJson(input)}`,
        ).not.toThrow();
        out = serialize(parse(input));
        expect(out, `round-trip #${i}: ${encodeJson(input)}`).toBe(input);
      },
    );
  });

  it("survives adversarial delimiter storms", () => {
    const cases = [
      "{".repeat(500),
      "{{".repeat(300),
      "[".repeat(500),
      "'".repeat(400),
      "<".repeat(300),
      "=".repeat(200),
      "{{{{{{{{{{a}}}}}}}}}}".repeat(50),
      "[[".repeat(200) + "]]".repeat(200),
      "<!--".repeat(100),
      "&#".repeat(200),
      "|=".repeat(300),
    ];
    Arr.forEach(cases, (input) => {
      let out = "";
      expect(
        () => {
          out = serialize(parse(input));
        },
        `input: ${input.slice(0, 20)}…`,
      ).not.toThrow();
      expect(out).toBe(input);
    });
  });

  it("round-trips deeply nested input past the recursion bound without throwing", () => {
    const input = "{{".repeat(400) + "x" + "}}".repeat(400);
    let out = "";
    expect(() => {
      out = serialize(parse(input));
    }).not.toThrow();
    expect(out).toBe(input);
  });
});

// Table-heavy fuzz (#132): the table scans step over nested constructs, so
// mix table markers with their openers and closers, balanced or not.
const TABLE_ATOMS = [
  "|}",
  "\n|+",
  "\n|",
  "\n!",
  "\n|-",
  "||",
  "!!",
  "|",
  "!",
  "{|",
  "{{",
  "}}",
  "{{{",
  "}}}",
  "[[",
  "]]",
  "<!--",
  "-->",
  "<ref>",
  "</ref>",
  "<nowiki>",
  "</nowiki>",
  "<ref name=a/>",
  "\n",
  "a",
  " ",
  "=",
  "{",
  "}",
  "[",
  "]",
  "<",
  ">",
];

function randomTable(rand: () => number): string {
  const open = rand() < 0.3 ? "{|\n|+" : "{|\n";
  const len = Math.floor(rand() * 60);
  const out =
    open + times(len, () => TABLE_ATOMS[Math.floor(rand() * TABLE_ATOMS.length)]).join("");
  return rand() < 0.8 ? `${out}\n|}` : out;
}

describe("fuzz: tables with nested constructs (#132)", () => {
  it("round-trips 3000 random tables with every span its own source slice", () => {
    const rand = prng(0x13213213);
    Arr.forEach(
      times(3000, (i) => i),
      (i) => {
        const input = randomTable(rand);
        const doc = parse(input);
        expect(serialize(doc), `round-trip #${i}: ${encodeJson(input)}`).toBe(input);
        assertSpanFidelity(input, doc);
      },
    );
  });
});
