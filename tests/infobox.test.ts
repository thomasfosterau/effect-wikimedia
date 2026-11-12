/**
 * The infobox view (#209): infobox detection by name, fields as trimmed
 * fragments that keep the template's own nodes, and their text.
 *
 * @module tests/infobox
 */

import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import { layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import {
  filter,
  type Infobox,
  type InfoboxField,
  infoboxes,
  type Node,
  parse,
  serializeNodes,
  templateName,
} from "../src/wikitext/index.ts";
import { readFixture } from "./helpers/fixtures.ts";

/** The value of `option`, failing the test when it is `None`. */
const some = <A>(option: Option.Option<A>, what: string): A =>
  Option.match(option, { onNone: () => expect.unreachable(`no ${what}`), onSome: (a) => a });

const field = (box: Infobox, key: string): InfoboxField =>
  some(HashMap.get(box.fields, key), `field ${key}`);

const only = (boxes: readonly Infobox[]): Infobox => {
  expect(boxes).toHaveLength(1);
  return some(Arr.head(boxes), "infobox");
};

layer(NodeServices.layer)("infoboxes", (it) => {
  it.effect(
    "reads the fixture's Infobox person with fragment values that keep links and templates",
    () =>
      Effect.gen(function* () {
        const doc = parse(yield* readFixture("ada-lovelace.txt"));
        const box = only(infoboxes(doc));
        expect(box.name).toBe("Infobox person");
        expect(box.type).toEqual(Option.some("person"));
        expect(HashMap.size(box.fields)).toBe(7);
        expect(field(box, "name").text).toBe("Ada Lovelace");
        const place = field(box, "birth_place");
        expect(serializeNodes(place.value)).toBe("[[London]], England");
        expect(place.text).toBe("London, England");
        expect(filter(place.value, (node) => P.isTagged(node, "Wikilink"))).toHaveLength(1);
        const born = field(box, "birth_date");
        const date = some(Arr.head(born.value), "birth date value");
        expect(P.isTagged(date, "Template") ? templateName(date) : "not a template").toBe(
          "birth date",
        );
      }),
  );

  it("keeps the template's own nodes, narrowing only the text at a value's edges", () => {
    const doc = parse("{{Infobox|a=  [[X]] y  \n|b=\n  {{t}}\n}}");
    const box = only(infoboxes(doc));
    expect(box.template).toBe(doc.children[0]);
    const a = field(box, "a");
    expect(a.param).toBe(box.template.params[0]);
    expect(a.value[0]).toBe(a.param.value[1]);
    const tail = some(Arr.get(a.value, 1), "tail");
    expect(tail).toMatchObject({ _tag: "Text", text: " y" });
    expect(doc.source.slice(tail.span.start, tail.span.end)).toBe(" y");
    const b = field(box, "b");
    expect(b.value).toHaveLength(1);
    expect(b.value[0]).toBe(b.param.value[1]);
  });

  it("gives an empty value and text for a blank field, and no type for a bare Infobox", () => {
    const box = only(infoboxes(parse("{{Infobox|empty=   |gap=}}")));
    expect(box.type).toEqual(Option.none());
    expect(field(box, "empty").value).toEqual([]);
    expect(field(box, "empty").text).toBe("");
    expect(field(box, "gap").value).toEqual([]);
  });

  it("keys positional parameters by index and lets a later duplicate win", () => {
    const box = only(infoboxes(parse("{{Infobox thing|first|x=1|x=2|second|1=override}}")));
    expect(field(box, "x").text).toBe("2");
    expect(field(box, "2").text).toBe("second");
    expect(field(box, "1").text).toBe("override");
  });

  it("matches names as MediaWiki normalises them, and only Infobox or Infobox …", () => {
    const source =
      "{{infobox_settlement|n=1}}{{ Infobox  Ort |n=2}}{{Infoboxes|n=3}}{{Info|n=4}}{{#if:Infobox|x}}";
    const boxes = infoboxes(parse(source));
    expect(boxes.map((box) => box.name)).toEqual(["Infobox settlement", "Infobox Ort"]);
    expect(boxes.map((box) => box.type)).toEqual([Option.some("settlement"), Option.some("Ort")]);
  });

  it("adds caller-supplied names, with no type, and finds nested infoboxes after their parent", () => {
    const source = "{{Taxobox|name=Cat}}{{Infobox person|module={{Infobox officeholder|x=1}}}}";
    const boxes = infoboxes(parse(source), { names: ["taxobox"] });
    expect(boxes.map((box) => box.name)).toEqual([
      "Taxobox",
      "Infobox person",
      "Infobox officeholder",
    ]);
    expect(boxes[0]?.type).toEqual(Option.none());
  });

  it("passes the stripToText options through to each field's text", () => {
    const box = only(
      infoboxes(parse("{{Infobox|v={{nowrap|A B}}}}"), {
        templates: { nowrap: (template) => serializeNodes(template.params[0]?.value ?? []) },
      }),
    );
    expect(field(box, "v").text).toBe("A B");
  });

  it("returns nothing for wikitext without an infobox", () => {
    const nodes: readonly Node[] = parse("Plain [[text]] {{cite web|url=x}}").children;
    expect(infoboxes(nodes)).toEqual([]);
  });
});
