/**
 * Query / manipulation surface: template extraction (name + params against a
 * real infobox), node filters, and strip-to-plain-text.
 *
 * @module tests/query
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
  filter,
  findTemplates,
  getParam,
  normaliseTemplateName,
  parse,
  stripToText,
  templateName,
  walk,
} from "../src/wikitext";

const ada = readFileSync(
  fileURLToPath(new URL("./fixtures/ada-lovelace.txt", import.meta.url)),
  "utf8",
);

describe("template extraction against a real infobox", () => {
  const doc = parse(ada);

  it("finds the infobox by (normalised) name", () => {
    const boxes = findTemplates(doc, "infobox person");
    expect(boxes).toHaveLength(1);
    expect(templateName(boxes[0])).toBe("Infobox person");
  });

  it("extracts named parameter values", () => {
    const box = findTemplates(doc, "Infobox person")[0];
    expect(getParam(box, "name")).toBe("Ada Lovelace");
    expect(getParam(box, "birth_name")).toBe("Augusta Ada Byron");
    expect(getParam(box, "nationality")).toBe("British");
  });

  it("keeps nested-template values as their raw wikitext", () => {
    const box = findTemplates(doc, "Infobox person")[0];
    expect(getParam(box, "birth_date")).toBe("{{birth date|1815|12|10|df=y}}");
  });

  it("finds nested templates too", () => {
    // {{birth date|…}}, {{death date and age|…}}, {{sfn|…}}, etc. are nested.
    expect(findTemplates(doc, "birth date")).toHaveLength(1);
    expect(findTemplates(doc).length).toBeGreaterThan(5);
  });

  it("reads positional parameters by 1-based index", () => {
    const t = parse("{{convert|10|km|mi}}");
    const conv = findTemplates(t, "convert")[0];
    expect(getParam(conv, 1)).toBe("10");
    expect(getParam(conv, 2)).toBe("km");
    expect(getParam(conv, 3)).toBe("mi");
  });

  it("lets an explicit numbered param override the positional slot", () => {
    const t = parse("{{t|first|1=override}}");
    expect(getParam(findTemplates(t, "t")[0], 1)).toBe("override");
  });
});

describe("normaliseTemplateName", () => {
  it("treats underscores/spaces/first-letter case as equivalent", () => {
    expect(normaliseTemplateName("infobox_person")).toBe("Infobox person");
    expect(normaliseTemplateName("  Infobox   person  ")).toBe("Infobox person");
    expect(normaliseTemplateName("infobox person")).toBe(normaliseTemplateName("Infobox_person"));
  });
});

describe("filter / walk", () => {
  it("collects every wikilink at any depth", () => {
    const doc = parse(ada);
    const links = filter(doc, (n) => n._tag === "Wikilink");
    expect(links.length).toBeGreaterThan(3);
  });

  it("visits nested nodes in pre-order and can skip subtrees", () => {
    const doc = parse("a{{t|[[L]]}}b");
    const seen: string[] = [];
    walk(doc, (n) => {
      seen.push(n._tag);
      if (n._tag === "Template") return false; // don't descend
    });
    expect(seen).toContain("Template");
    expect(seen).not.toContain("Wikilink");
  });
});

describe("strip to plain text", () => {
  it("removes markup, keeps prose, resolves links to labels", () => {
    const doc = parse("'''Bold''' and ''italic'' text with a [[Target|label]] and [[Plain]] link.");
    expect(stripToText(doc)).toBe("Bold and italic text with a label and Plain link.");
  });

  it("drops templates, comments, and reference tags", () => {
    const doc = parse("Prose{{template}} more<!-- c --> text<ref>cite</ref>.");
    expect(stripToText(doc)).toBe("Prose more text.");
  });

  it("decodes entities and keeps nowiki content literal", () => {
    const doc = parse("A&nbsp;B &amp; <nowiki>'''C'''</nowiki>");
    expect(stripToText(doc)).toBe("A\u00a0B & '''C'''");
  });

  it("drops file/category links but keeps ordinary link labels", () => {
    const doc = parse("[[File:x.png|thumb|cap]][[Category:Y]][[Article|shown]]");
    expect(stripToText(doc)).toBe("shown");
  });

  it("turns a lead paragraph into clean prose", () => {
    // A template-free sentence: strip should match what a reader sees.
    const doc = parse(
      "The [[Analytical Engine]] was a ''proposed'' [[mechanical computer|machine]].",
    );
    expect(stripToText(doc)).toBe("The Analytical Engine was a proposed machine.");
  });
});
