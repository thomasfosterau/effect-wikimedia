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

import * as Arr from "effect/Array";
import * as P from "effect/Predicate";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import { Wikidata } from "../src/index.ts";
import { readFixtureJson } from "./helpers/fixtures.ts";

/** The recorded fixture lacks an entity the parity checks read. */
class FixtureEntityMissing extends Schema.TaggedError<FixtureEntityMissing>()(
  "FixtureEntityMissing",
  { id: Schema.String },
) {}

const decodeQ42 = Effect.fnUntraced(function* () {
  const fixture = yield* readFixtureJson("wikidata-q42.json");
  // The response schema is Unknown-heavy, so a structural view of the parsed
  // fixture is faithful — `normaliseEntities` does the real validation.
  // SAFETY: the recorded wbgetentities fixture is that response's JSON; the schema is all
  // optional `Unknown` leaves, and `normaliseEntities` validates every value it reads.
  const entities = Wikidata.normaliseEntities(
    Schema.decodeUnknownSync(Wikidata.WbGetEntitiesResponse)(fixture),
  );
  const item = entities.Q42;
  if (item === undefined) return yield* new FixtureEntityMissing({ id: "Q42" });
  return item;
});

// ── The extraction-era reconciliation shapes, restated locally (no cross-package import) ──

interface NeutralFact {
  readonly authority: string;
  readonly externalId: string;
  readonly externalIri: string;
  readonly mappingKind: "exact" | "equivalent";
  readonly notes: Option.Option<string>;
}

// An extraction-era parity fixture: it does not track `src/reconciliation`'s
// `EXTERNAL_ID_AUTHORITIES` (which validates and encodes each value).
const EXTERNAL_ID_AUTHORITIES = {
  P214: { authority: "viaf", iri: (v: string) => `https://viaf.org/viaf/${v}` },
  P496: { authority: "orcid", iri: (v: string) => `https://orcid.org/${v}` },
} satisfies R.ReadonlyRecord<string, { authority: string; iri: (v: string) => string }>;

const DATE_PROPERTIES = {
  P569: "date of birth",
  P570: "date of death",
} satisfies R.ReadonlyRecord<string, string>;

const IMAGE_PROPERTIES = ["P18"];

const wikidataEntityIri = (id: string) => `http://www.wikidata.org/entity/${id}`;

/** The main-snak value of the first statement on a property, when it is a value snak of kind `tag`. */
function firstValue<K extends Wikidata.DataValue["_tag"]>(
  item: Wikidata.WikidataItem,
  property: string,
  tag: K,
): readonly Extract<Wikidata.DataValue, { _tag: K }>[] {
  const snak = item.claims[property]?.[0]?.mainsnak;
  if (!P.isTagged(snak, "value")) return [];
  const isKind = (v: Wikidata.DataValue): v is Extract<Wikidata.DataValue, { _tag: K }> =>
    P.isTagged(v, tag);
  return Arr.filter([snak.value], isKind);
}

/** The QID self-link — the canonical Wikidata correspondence. */
function qidSelfLink(item: Wikidata.WikidataItem): NeutralFact {
  return {
    authority: "wikidata",
    externalId: item.id,
    externalIri: wikidataEntityIri(item.id),
    mappingKind: "exact",
    notes: Option.none(),
  };
}

/** `sameAs` facts — one per allowlisted external-id statement. */
function sameAsFacts(item: Wikidata.WikidataItem): NeutralFact[] {
  return R.toEntries(EXTERNAL_ID_AUTHORITIES).flatMap(([property, scheme]) => {
    return firstValue(item, property, "external-id").map((value): NeutralFact => ({
      authority: scheme.authority,
      externalId: value.value,
      externalIri: scheme.iri(value.value),
      mappingKind: "exact",
      notes: Option.none(),
    }));
  });
}

/** Date facts — the time member, `+`-stripped like the reconciliation normaliser. */
function dateFacts(item: Wikidata.WikidataItem): NeutralFact[] {
  return R.toEntries(DATE_PROPERTIES).flatMap(([property, label]) => {
    return firstValue(item, property, "time").map((value): NeutralFact => ({
      authority: "wikidata",
      externalId: value.time.replace(/^\+/, ""),
      externalIri: wikidataEntityIri(property),
      mappingKind: "equivalent",
      notes: Option.some(label),
    }));
  });
}

/** Image facts — the string member (commonsMedia), to a Special:FilePath URL. */
function imageFacts(item: Wikidata.WikidataItem): NeutralFact[] {
  return IMAGE_PROPERTIES.flatMap((property) => {
    return firstValue(item, property, "string").map((value): NeutralFact => ({
      authority: "wikimedia-commons",
      externalId: value.value,
      externalIri: `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(value.value)}`,
      mappingKind: "equivalent",
      notes: Option.some("image"),
    }));
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

layer(NodeServices.layer)(
  "reconciliation enrich normaliser, expressed over the typed surface",
  (it) => {
    it.effect("produces the QID self-link, sameAs, date, and image facts", () =>
      Effect.gen(function* () {
        const item = yield* decodeQ42();
        const facts = enrichFacts(item);
        expect(facts).toEqual([
          {
            authority: "wikidata",
            externalId: "Q42",
            externalIri: "http://www.wikidata.org/entity/Q42",
            mappingKind: "exact",
            notes: Option.none(),
          },
          {
            authority: "viaf",
            externalId: "113230702",
            externalIri: "https://viaf.org/viaf/113230702",
            mappingKind: "exact",
            notes: Option.none(),
          },
          {
            authority: "wikidata",
            externalId: "1952-03-11T00:00:00Z",
            externalIri: "http://www.wikidata.org/entity/P569",
            mappingKind: "equivalent",
            notes: Option.some("date of birth"),
          },
          {
            authority: "wikimedia-commons",
            externalId: "Douglas adams portrait cropped.jpg",
            externalIri:
              "https://commons.wikimedia.org/wiki/Special:FilePath/Douglas%20adams%20portrait%20cropped.jpg",
            mappingKind: "equivalent",
            notes: Option.some("image"),
          },
        ]);
      }),
    );
  },
);

// ── Label search parity ──────────────────────────────────────────────────

interface NeutralCandidate {
  readonly qid: string;
  readonly label: Option.Option<string>;
  readonly description: Option.Option<string>;
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
      {
        qid: "Q42",
        label: Option.some("Douglas Adams"),
        description: Option.some("English writer"),
      },
    ]);
  });
});
