/**
 * Acceptance test for issue #1064's third criterion: the reconciliation
 * package's needs — **label search**, **identifier statements**, and
 * **enrich fields** — are expressible over the new `Wikidata` surface.
 *
 * We reimplement `packages/wikidata`'s enrich normaliser (`normaliseFacts`
 * in `src/normalise.ts`) and its label-search normaliser (`normaliseSearch`)
 * **on top of the typed model** — matching on the `DataValue` `_tag` union
 * instead of poking at an `Unknown` blob — and assert they produce the
 * website-era shapes the reconciliation package produced at extraction time
 * (before `Reconciliation.WikidataFact` became a tagged union, website#1064 /
 * #37); it does not track `src/reconciliation`. The package
 * under test stays website-agnostic: this test imports nothing from
 * `packages/wikidata`; the expected outputs are the known-correct values.
 *
 * @module tests/reconciliation-parity
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { Wikidata } from "../src/index.ts";

const fixture: unknown = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(
  readFileSync(fileURLToPath(new URL("./fixtures/wikidata-q42.json", import.meta.url)), "utf8"),
);

/** The recorded fixture lacks an entity the parity checks read. */
class FixtureEntityMissing extends Schema.TaggedError<FixtureEntityMissing>()(
  "FixtureEntityMissing",
  { id: Schema.String },
) {}

const decodeQ42 = (): Wikidata.WikidataItem => {
  // The response schema is Unknown-heavy, so a structural view of the parsed
  // fixture is faithful — `normaliseEntities` does the real validation.
  const entities = Wikidata.normaliseEntities(fixture as Wikidata.WbGetEntitiesResponse);
  const item = entities.Q42;
  if (item === undefined) throw new FixtureEntityMissing({ id: "Q42" });
  return item;
};

// ── The extraction-era reconciliation shapes, restated locally (no cross-package import) ──

interface NeutralFact {
  readonly authority: string;
  readonly externalId: string | null;
  readonly externalIri: string;
  readonly mappingKind: "exact" | "equivalent";
  readonly notes: string | null;
}

// An extraction-era parity fixture: it does not track `src/reconciliation`'s
// `EXTERNAL_ID_AUTHORITIES` (which validates and encodes each value).
const EXTERNAL_ID_AUTHORITIES = {
  P214: { authority: "viaf", iri: (v: string) => `https://viaf.org/viaf/${v}` },
  P496: { authority: "orcid", iri: (v: string) => `https://orcid.org/${v}` },
} satisfies Record.ReadonlyRecord<string, { authority: string; iri: (v: string) => string }>;

const DATE_PROPERTIES = {
  P569: "date of birth",
  P570: "date of death",
} satisfies Record.ReadonlyRecord<string, string>;

const IMAGE_PROPERTIES = ["P18"];

const wikidataEntityIri = (id: string) => `http://www.wikidata.org/entity/${id}`;

/** The main-snak value of the first statement on a property, if it is a value snak. */
function firstValue(item: Wikidata.WikidataItem, property: string): Wikidata.DataValue | null {
  const snak = item.claims[property]?.[0]?.mainsnak;
  return snak?._tag === "value" ? snak.value : null;
}

/** The QID self-link — the canonical Wikidata correspondence. */
function qidSelfLink(item: Wikidata.WikidataItem): NeutralFact {
  return {
    authority: "wikidata",
    externalId: item.id,
    externalIri: wikidataEntityIri(item.id),
    mappingKind: "exact",
    notes: null,
  };
}

/** `sameAs` facts — one per allowlisted external-id statement. */
function sameAsFacts(item: Wikidata.WikidataItem): NeutralFact[] {
  return Record.toEntries(EXTERNAL_ID_AUTHORITIES).flatMap(([property, scheme]) => {
    const value = firstValue(item, property);
    if (value?._tag !== "external-id") return [];
    return [
      {
        authority: scheme.authority,
        externalId: value.value,
        externalIri: scheme.iri(value.value),
        mappingKind: "exact",
        notes: null,
      },
    ];
  });
}

/** Date facts — the time member, `+`-stripped like the reconciliation normaliser. */
function dateFacts(item: Wikidata.WikidataItem): NeutralFact[] {
  return Record.toEntries(DATE_PROPERTIES).flatMap(([property, label]) => {
    const value = firstValue(item, property);
    if (value?._tag !== "time") return [];
    return [
      {
        authority: "wikidata",
        externalId: value.time.replace(/^\+/, ""),
        externalIri: wikidataEntityIri(property),
        mappingKind: "equivalent",
        notes: label,
      },
    ];
  });
}

/** Image facts — the string member (commonsMedia), to a Special:FilePath URL. */
function imageFacts(item: Wikidata.WikidataItem): NeutralFact[] {
  return IMAGE_PROPERTIES.flatMap((property) => {
    const value = firstValue(item, property);
    if (value?._tag !== "string") return [];
    return [
      {
        authority: "wikimedia-commons",
        externalId: value.value,
        externalIri: `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(value.value)}`,
        mappingKind: "equivalent",
        notes: "image",
      },
    ];
  });
}

/**
 * `normaliseFacts` reimplemented over the typed surface: QID self-link +
 * `sameAs` external-id links + date facts + image facts. Compare to
 * `packages/wikidata/src/normalise.ts` — the branches here read the typed
 * `_tag` union instead of narrowing `unknown`.
 */
function enrichFacts(item: Wikidata.WikidataItem): readonly NeutralFact[] {
  return [qidSelfLink(item), ...sameAsFacts(item), ...dateFacts(item), ...imageFacts(item)];
}

describe("reconciliation enrich normaliser, expressed over the typed surface", () => {
  it("produces the QID self-link, sameAs, date, and image facts", () => {
    const item = decodeQ42();
    const facts = enrichFacts(item);
    expect(facts).toEqual([
      {
        authority: "wikidata",
        externalId: "Q42",
        externalIri: "http://www.wikidata.org/entity/Q42",
        mappingKind: "exact",
        notes: null,
      },
      {
        authority: "viaf",
        externalId: "113230702",
        externalIri: "https://viaf.org/viaf/113230702",
        mappingKind: "exact",
        notes: null,
      },
      {
        authority: "wikidata",
        externalId: "1952-03-11T00:00:00Z",
        externalIri: "http://www.wikidata.org/entity/P569",
        mappingKind: "equivalent",
        notes: "date of birth",
      },
      {
        authority: "wikimedia-commons",
        externalId: "Douglas adams portrait cropped.jpg",
        externalIri:
          "https://commons.wikimedia.org/wiki/Special:FilePath/Douglas%20adams%20portrait%20cropped.jpg",
        mappingKind: "equivalent",
        notes: "image",
      },
    ]);
  });
});

// ── Label search parity ──────────────────────────────────────────────────

interface NeutralCandidate {
  readonly qid: string;
  readonly label: string | null;
  readonly description: string | null;
}

describe("reconciliation label search, expressed over the typed surface", () => {
  it("maps wbsearchentities hits to neutral candidates", () => {
    const response: Wikidata.WbSearchResponse = {
      search: [
        {
          id: "Q42",
          label: "Douglas Adams",
          description: "English writer",
          match: { type: "label", language: "en", text: "Douglas Adams" },
        },
        { id: "junk", label: "dropped" },
      ],
    };
    const candidates: NeutralCandidate[] = Wikidata.normaliseSearch(response).map((hit) => ({
      qid: hit.id,
      label: hit.label,
      description: hit.description,
    }));
    expect(candidates).toEqual([
      { qid: "Q42", label: "Douglas Adams", description: "English writer" },
    ]);
  });
});
