/**
 * Unit test for how `normaliseFacts` (`src/reconciliation/normalise.ts`)
 * builds `ImageFact`s from `normaliseCommonsImage`'s result.
 *
 * `normaliseCommonsImage` is mocked to return an extra field, standing in for
 * a future change to the helper. A spread (`{ ...image }`) would copy that
 * field into every `Image` fact at runtime, and neither type checker would
 * report it, because a spread's extra properties aren't checked. The mock
 * applies to the whole file, so this suite lives apart from `lookup.test.ts`.
 *
 * @module tests/reconciliation/normalise
 */

import * as Predicate from "effect/Predicate";
import { describe, expect, it, vi } from "vite-plus/test";
import type * as Wikidata from "../../src/wikidata.ts";
import { normaliseCommonsImage } from "../../src/reconciliation/candidate.ts";
import { normaliseFacts } from "../../src/reconciliation/normalise.ts";

vi.mock(import("../../src/reconciliation/candidate.ts"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    normaliseCommonsImage: vi.fn<typeof original.normaliseCommonsImage>((raw: unknown) => {
      const image = original.normaliseCommonsImage(raw);
      return image === null ? null : { ...image, helperOnly: "leaked" };
    }),
  };
});

/** A Q42-shaped item with one P18 (image) claim and nothing else. */
const item: Wikidata.WikidataItem = {
  id: "Q42" as Wikidata.WikidataItem["id"],
  type: "item",
  labels: {},
  descriptions: {},
  aliases: {},
  sitelinks: {},
  claims: {
    P18: [
      {
        id: null,
        rank: "normal",
        mainsnak: {
          _tag: "value",
          property: "P18" as Wikidata.ValueSnak["property"],
          datatype: "commonsMedia",
          value: { _tag: "string", value: "Douglas adams portrait.jpg" },
        },
        qualifiers: {},
        references: [],
      },
    ],
  },
};

describe("normaliseFacts Image facts", () => {
  it("copies only filename and iri from normaliseCommonsImage's result", () => {
    const images = normaliseFacts(item, "Q42").facts.filter(Predicate.isTagged("Image"));
    expect(images).toStrictEqual([
      {
        _tag: "Image",
        property: "P18",
        filename: "Douglas adams portrait.jpg",
        iri: "https://commons.wikimedia.org/wiki/Special:FilePath/Douglas%20adams%20portrait.jpg",
      },
    ]);
    // Fails, rather than passing vacuously, if the mock stops reaching
    // `normalise.ts` (e.g. the helper moves module, or isolation is off).
    expect(normaliseCommonsImage).toHaveBeenCalled();
  });
});
