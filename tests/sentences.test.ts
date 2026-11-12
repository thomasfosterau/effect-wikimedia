/**
 * The sentence view (#209, slice 7): a paragraph's text cut by
 * `Intl.Segmenter`, each sentence trimmed and located in the paragraph text.
 *
 * @module tests/sentences
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Arr from "effect/Array";
import { describe, expect, it } from "vite-plus/test";
import {
  type Paragraph,
  paragraphs,
  parse,
  type Sentence,
  sentences,
} from "../src/wikitext/index.ts";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

/** The paragraphs of a wikitext source. */
const paragraphsOf = (source: string): readonly Paragraph[] => paragraphs(parse(source));

/** The one paragraph of a wikitext source. */
const only = (source: string): Paragraph =>
  Arr.match(paragraphsOf(source), {
    onEmpty: () => expect.unreachable("no paragraph"),
    onNonEmpty: (all) => all[0],
  });

/** Every sentence's offsets slice exactly its text out of the paragraph's text. */
function expectLocated(paragraph: Paragraph, all: readonly Sentence[]): void {
  Arr.forEach(all, (s) => {
    expect(paragraph.text.slice(s.start, s.end)).toBe(s.text);
  });
}

describe("sentences", () => {
  it("splits a paragraph's plain text, markup stripped, at sentence ends", () => {
    const paragraph = only(
      "'''Douglas Adams''' was an English [[author]].  He wrote ''[[The Hitchhiker's Guide to the Galaxy|Hitchhiker]]''! Was it a radio series? Yes",
    );
    const all = sentences(paragraph, { locale: "en" });
    expect(Arr.map(all, (s) => s.text)).toEqual([
      "Douglas Adams was an English author.",
      "He wrote Hitchhiker!",
      "Was it a radio series?",
      "Yes",
    ]);
    expectLocated(paragraph, all);
    expect(all[1]?.start).toBe(38);
  });

  it("follows the locale's rules: CJK full stops end sentences without a space", () => {
    const paragraph = only("東京は日本の首都です。人口は多い。");
    expect(Arr.map(sentences(paragraph, { locale: "ja" }), (s) => s.text)).toEqual([
      "東京は日本の首都です。",
      "人口は多い。",
    ]);
  });

  it("adds no abbreviation rules of its own: `Mr. Adams` splits", () => {
    const paragraph = only("Mr. Adams arrived. He sat down.");
    expect(Arr.map(sentences(paragraph, { locale: "en" }), (s) => s.text)).toEqual([
      "Mr.",
      "Adams arrived.",
      "He sat down.",
    ]);
  });

  it("gives no sentences for a paragraph whose text is empty", () => {
    // A paragraph of a template only: its plain text renders as nothing.
    const paragraph = only("{{Use dmy dates}}");
    expect(paragraph.text).toBe("");
    expect(sentences(paragraph, { locale: "en" })).toEqual([]);
  });

  it("locates every sentence of the Ada Lovelace fixture's paragraphs", () => {
    const all = paragraphsOf(fixture("ada-lovelace.txt"));
    expect(all.length).toBeGreaterThan(0);
    Arr.forEach(all, (paragraph) => {
      const split = sentences(paragraph, { locale: "en" });
      expectLocated(paragraph, split);
      Arr.forEach(split, (s) => expect(s.text).toBe(s.text.trim()));
    });
    const first = Arr.flatMap(all, (paragraph) => sentences(paragraph, { locale: "en" }));
    expect(first.length).toBeGreaterThan(all.length);
  });

  it("throws a RangeError for a malformed locale tag, as Intl.Segmenter does", () => {
    expect(() => sentences(only("A."), { locale: "not a tag!" })).toThrow(RangeError);
  });
});
