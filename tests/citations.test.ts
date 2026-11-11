/**
 * The citation view (#209): every `<ref>` with its name and group, a body
 * parsed with spans in the page, the citation templates in it, and reuses
 * linked to their definition.
 *
 * @module tests/citations
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import { citations, filter, parse, serializeNodes, templateName } from "../src/wikitext/index.ts";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

/** The value of `option`, failing the test when it is `None`. */
const some = <A>(option: Option.Option<A>, what: string): A =>
  Option.match(option, { onNone: () => expect.unreachable(`no ${what}`), onSome: (a) => a });

describe("citations", () => {
  it("parses each body with spans in the page and finds its citation templates", () => {
    const page =
      'Intro.<ref name="nyt">{{cite news|title=Hi|url=x}} and [[Link]]</ref> More.<ref>Plain.</ref>';
    const all = citations(parse(page));
    expect(all.map((c) => [Option.getOrNull(c.name), c.reuse])).toEqual([
      ["nyt", false],
      [null, false],
    ]);
    const first = some(Arr.head(all), "citation");
    Arr.forEach(
      filter(some(first.body, "body"), () => true),
      (node) => {
        expect(page.slice(node.span.start, node.span.end)).toBe(serializeNodes([node]));
      },
    );
    expect(first.templates.map((t) => page.slice(t.span.start, t.span.end))).toEqual([
      "{{cite news|title=Hi|url=x}}",
    ]);
    expect(all.map((c) => c.templates.length)).toEqual([1, 0]);
  });

  it("links a reuse to the first definition of its name in its group", () => {
    const doc = parse(
      '<ref name=a>A</ref><ref name="b" group="note">B</ref><ref name="a" /><ref name=b group=note></ref><ref name="b" />',
    );
    const all = citations(doc);
    expect(all.map((c) => [c.reuse, Option.getOrNull(c.definition)])).toEqual([
      [false, null],
      [false, null],
      [true, 0],
      [true, 1],
      [true, null],
    ]);
    expect(all.map((c) => Option.getOrNull(c.group))).toEqual([null, "note", null, "note", null]);
    expect(all[2]?.ref).toBe(doc.children[2]);
  });

  it("finds a ref inside a template parameter, and counts extra citation names", () => {
    const doc = parse("{{Infobox|note=<ref>{{Literatur|Titel=X}} {{Citation|title=Y}}</ref>}}");
    const [only] = citations(doc, { names: ["literatur"] });
    expect(only?.templates.map(templateName)).toEqual(["Literatur", "Citation"]);
    expect(citations(doc)[0]?.templates.map(templateName)).toEqual(["Citation"]);
  });

  it("reads the corpus fixture's refs", () => {
    const page = fixture("ada-lovelace.txt");
    const all = citations(parse(page));
    expect(all.length).toBeGreaterThan(0);
    expect(all[0]?.name).toEqual(Option.some("bio"));
    Arr.forEach(all, (c) =>
      Option.match(c.body, {
        onNone: () => undefined,
        onSome: (body) => expect(page.slice(body.span.start, body.span.end)).toBe(body.source),
      }),
    );
  });

  it("returns nothing without refs", () => {
    expect(citations(parse("No refs, just {{cite web|url=x}}."))).toEqual([]);
  });
});
