/**
 * The paragraph view (#209): prose runs split at blank and block-level
 * lines, lossless back to their source, with the document's own nodes kept.
 *
 * @module tests/paragraphs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import { describe, expect, it } from "vite-plus/test";
import {
  type Document,
  type Paragraph,
  paragraphs,
  parse,
  sections,
  serializeNodes,
} from "../src/wikitext/index.ts";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

/** Each paragraph's nodes serialise to exactly its span's source, and every node's span holds its own text. */
function expectLossless(doc: Document, all: readonly Paragraph[]): void {
  Arr.forEach(all, (p) => {
    expect(serializeNodes(p.nodes)).toBe(doc.source.slice(p.span.start, p.span.end));
    Arr.forEach(p.nodes, (node) =>
      expect(doc.source.slice(node.span.start, node.span.end)).toBe(serializeNodes([node])),
    );
  });
}

describe("paragraphs", () => {
  it("splits prose at blank lines, joining a paragraph's lines", () => {
    const doc = parse("First line\nsecond line.\n\nNext paragraph.\n  \nLast.");
    const all = paragraphs(doc);
    expectLossless(doc, all);
    expect(all.map((p) => p.text)).toEqual([
      "First line\nsecond line.",
      "Next paragraph.",
      "Last.",
    ]);
  });

  it("ends a paragraph at a list, a rule, preformatted text, a table or a heading", () => {
    const doc = parse(
      "Intro.\n* item\nAfter list.\n----\nAfter rule.\n pre\nAfter pre.\n{|\n| c\n|}\nAfter table.\n== H ==\nAfter heading.",
    );
    const all = paragraphs(doc);
    expectLossless(doc, all);
    expect(all.map((p) => p.text)).toEqual([
      "Intro.",
      "After list.",
      "After rule.",
      "After pre.",
      "After table.",
      "After heading.",
    ]);
  });

  it("keeps the document's own inline nodes", () => {
    const doc = parse("See [[Berlin]] and {{lang|de|Stadt}}.");
    const [only] = paragraphs(doc);
    expect(only?.nodes.find(P.isTagged("Wikilink"))).toBe(
      doc.children.find(P.isTagged("Wikilink")),
    );
    expect(only?.text).toBe("See Berlin and .");
  });

  it("reads a section's own nodes on the corpus fixture", () => {
    const doc = parse(fixture("ada-lovelace.txt"));
    const biography = sections(doc).find((s) =>
      Option.exists(s.title, (title) => title === "Biography"),
    );
    expect(biography).toBeDefined();
    const all = paragraphs(biography?.nodes ?? []);
    expectLossless(doc, all);
    expect(all[0]?.text).toMatch(/^She was the only legitimate child/);
  });

  it("returns nothing for empty input or input without prose", () => {
    expect(paragraphs(parse(""))).toEqual([]);
    expect(paragraphs(parse("* a\n* b\n\n----"))).toEqual([]);
  });
});
