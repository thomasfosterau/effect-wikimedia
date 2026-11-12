/**
 * `parse(source, { offset })` (#209): spans in a larger text, for a fragment
 * parsed out of a page such as a `<ref>` body.
 *
 * @module tests/parse-offset
 */

import * as Struct from "effect/Struct";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import { describe, expect, it } from "vite-plus/test";
import {
  type Document,
  filter,
  type Node,
  parse,
  serializeNodes,
  type Tag,
} from "../src/wikitext/index.ts";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

/** Every node at any depth, in document order. */
const allNodes = (doc: Document): readonly Node[] => filter(doc, () => true);

describe("parse with an offset", () => {
  it.each(["ada-lovelace.txt", "tables-and-autolinks.txt", "pathological.txt"])(
    "shifts every span in %s by the offset and changes nothing else",
    (name) => {
      const source = fixture(name);
      const plain = parse(source);
      const shifted = parse(source, { offset: 1000 });
      expect(shifted.source).toBe(source);
      expect(shifted.span).toEqual({ start: 1000, end: 1000 + source.length });
      const before = allNodes(plain);
      const after = allNodes(shifted);
      expect(after).toHaveLength(before.length);
      Arr.forEach(Arr.zip(before, after), ([a, b]) => {
        expect(Struct.get(b, "_tag")).toBe(Struct.get(a, "_tag"));
        expect(b.span).toEqual({ start: a.span.start + 1000, end: a.span.end + 1000 });
        expect(serializeNodes([b])).toBe(serializeNodes([a]));
      });
    },
  );

  it("gives a <ref> body spans in its page, so the page's text slices to each node", () => {
    const page =
      "Ada wrote notes.<ref>See [[Charles Babbage]] and {{cite book|title=Notes}}.</ref> End.";
    const ref = filter(parse(page), P.isTagged("Tag")).find(
      (node): node is Tag => P.isTagged(node, "Tag") && node.name === "ref",
    );
    expect(ref).toBeDefined();
    if (ref === undefined || Option.isNone(ref.rawContent)) return;
    const offset = page.indexOf(ref.rawContent.value);
    const body = parse(ref.rawContent.value, { offset });
    const link = filter(body, P.isTagged("Wikilink"))[0];
    expect(link).toBeDefined();
    if (link === undefined) return;
    expect(page.slice(link.span.start, link.span.end)).toBe("[[Charles Babbage]]");
    Arr.forEach(allNodes(body), (node) => {
      expect(page.slice(node.span.start, node.span.end)).toBe(serializeNodes([node]));
    });
  });

  it("is the plain parse for offset 0 or no options", () => {
    expect(parse("a [[b]] {{c}}", { offset: 0 })).toEqual(parse("a [[b]] {{c}}"));
    expect(parse("a [[b]]", {})).toEqual(parse("a [[b]]"));
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])(
    "throws a RangeError for the offset %s",
    (offset) => {
      expect(() => parse("x", { offset })).toThrow(RangeError);
    },
  );
});
