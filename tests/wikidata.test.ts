/**
 * Unit tests for the Wikidata surface (`src/wikidata.ts`): the fixture
 * round-trip (a recorded item with every datavalue kind, incl. an unknown
 * datatype, decodes → typed access), `wbgetentities` batching / 50-id
 * chunking, and `wbsearchentities`. The network is stubbed at
 * `FetchHttpClient.Fetch` — no live network anywhere in this suite.
 *
 * @module tests/wikidata
 */

import * as Struct from "effect/Struct";
import * as P from "effect/Predicate";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it, layer } from "@effect/vitest";
import { assertInstanceOf } from "@effect/vitest/utils";
import { describe, expect } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import { Core, Wikidata } from "../src/index.ts";

/** JSON text ↔ a JSON value, through the Schema JSON codec. */
const Json = Schema.fromJsonString(Schema.Json);

const fixture = Schema.decodeSync(Json)(
  readFileSync(fileURLToPath(new URL("./fixtures/wikidata-q42.json", import.meta.url)), "utf8"),
);

/** A fetch stub that dispatches on the Action `action` param, recording every URL. */
const stubWikidata = (handler: (url: URL) => Schema.Json) => {
  const urls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    urls.push(request.url);
    const body = handler(new URL(request.url));
    return new Response(Schema.encodeSync(Json)(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { urls, provideFetch: Effect.provideService(FetchHttpClient.Fetch, fetch) };
};

// ── Typed narrowing helpers (keep each assertion flat) ───────────────────

/** Narrows a snak to its value snak, or fails the test. */
const valueOf = (snak: Wikidata.Snak | undefined): Wikidata.DataValue => {
  if (!P.isTagged(snak, "value"))
    return expect.unreachable(
      `expected a value snak, got ${snak === undefined ? "nothing" : Struct.get(snak, "_tag")}`,
    );
  return snak.value;
};

/** Narrows a DataValue to a specific member, or fails the test. */
const dataValueOfKind = <K extends Wikidata.DataValue["_tag"]>(
  value: Wikidata.DataValue,
  tag: K,
): Extract<Wikidata.DataValue, { _tag: K }> => {
  const isKind = (v: Wikidata.DataValue): v is Extract<Wikidata.DataValue, { _tag: K }> =>
    P.isTagged(v, tag);
  if (!isKind(value))
    return expect.unreachable(`expected ${tag}, got ${Struct.get(value, "_tag")}`);
  return value;
};

/** The main snak's value of a given kind, for the first statement on a property. */
const claimValue = <K extends Wikidata.DataValue["_tag"]>(
  item: Wikidata.WikidataItem | undefined,
  property: string,
  tag: K,
): Extract<Wikidata.DataValue, { _tag: K }> =>
  dataValueOfKind(valueOf(item?.claims[property]?.[0]?.mainsnak), tag);

/** Decodes a raw entity, failing the test when `decodeEntity` rejects it. */
const decoded = (raw: Schema.Json): Wikidata.WikidataItem =>
  Option.getOrElse(Wikidata.decodeEntity(raw), () => expect.unreachable("entity rejected"));

// ── Branded id parsers ──────────────────────────────────────────────────

describe("Wikidata id parsers", () => {
  it("validates and upper-cases Q / P / L ids", () => {
    expect(Wikidata.parseItemId("q42")).toEqual(Option.some("Q42"));
    expect(Wikidata.parsePropertyId(" p31 ")).toEqual(Option.some("P31"));
    expect(Wikidata.parseLexemeId("L1")).toEqual(Option.some("L1"));
    expect(Wikidata.parseEntityId("Q5")).toEqual(Option.some("Q5"));
    expect(Wikidata.parseEntityId("P569")).toEqual(Option.some("P569"));
  });

  it("rejects non-ids and cross-kind ids", () => {
    expect(Wikidata.parseItemId("P31")).toEqual(Option.none());
    expect(Wikidata.parseItemId("Q0")).toEqual(Option.none());
    expect(Wikidata.parseItemId("Q42x")).toEqual(Option.none());
    expect(Wikidata.parsePropertyId("Q42")).toEqual(Option.none());
    expect(Wikidata.parseEntityId("L1-F1")).toEqual(Option.none());
  });

  it("brand schemas check the id pattern when decoding", () => {
    expect(Schema.decodeUnknownOption(Wikidata.ItemId)("Q42")).toEqual(Option.some("Q42"));
    expect(Schema.decodeUnknownOption(Wikidata.ItemId)("Q42/../x")).toEqual(Option.none());
    expect(Schema.decodeUnknownOption(Wikidata.PropertyId)("Q42")).toEqual(Option.none());
    expect(Schema.decodeUnknownOption(Wikidata.LexemeId)("L0")).toEqual(Option.none());
  });
});

// ── List caps (hand-built entities) ─────────────────────────────────────

describe("Wikidata sitelink caps", () => {
  const cap = Wikidata.MAX_SITELINKS;
  const badgeCap = Wikidata.MAX_LIST_ENTRIES;
  /** `count` sitelinks keyed `site0wiki`, `site1wiki`, …, each with a title. */
  const sitelinks = (count: number) =>
    R.fromEntries(
      Array.from({ length: count }, (_, i) => [`site${i}wiki`, { title: `Page ${i}` }]),
    );

  it("keeps at most MAX_SITELINKS sitelinks per entity, the first in order", () => {
    const entities = Wikidata.normaliseEntities({
      entities: { Q1: { id: "Q1", sitelinks: sitelinks(cap + 5) } },
    });
    const keys = R.keys(entities.Q1?.sitelinks ?? {});
    expect(keys).toHaveLength(cap);
    expect(keys[0]).toBe("site0wiki");
    expect(keys.at(-1)).toBe(`site${cap - 1}wiki`);
  });

  it("does not count a dropped (title-less) sitelink towards the cap", () => {
    const item = decoded({
      id: "Q1",
      sitelinks: { untitledwiki: { site: "untitledwiki" }, ...sitelinks(cap) },
    });
    const keys = R.keys(item.sitelinks);
    expect(keys).toHaveLength(cap);
    expect(keys).not.toContain("untitledwiki");
  });

  it("keeps at most MAX_LIST_ENTRIES valid badges per sitelink, the first in order", () => {
    const badges = ["not-an-item", ...Array.from({ length: badgeCap + 5 }, (_, i) => `Q${i + 1}`)];
    const item = decoded({
      id: "Q1",
      sitelinks: { enwiki: { site: "enwiki", title: "Page", badges } },
    });
    const kept = item.sitelinks.enwiki?.badges ?? [];
    expect(kept).toHaveLength(badgeCap);
    expect(kept[0]).toBe("Q1");
    expect(kept.at(-1)).toBe(`Q${badgeCap}`);
  });
});

describe("Wikidata.decodeEntity on containers of the wrong kind (#147)", () => {
  // Each threw a TypeError before #147; a dump line like this ended a whole
  // `Dumps` stream as a defect.
  // Raw dump-line shapes, as `decodeEntity` (which takes `unknown`) meets them.
  const malformed: ReadonlyArray<readonly [string, object]> = [
    ["a null statement", { claims: { P31: [null] } }],
    ["a null mainsnak", { claims: { P31: [{ mainsnak: null }] } }],
    [
      "a null datavalue",
      { claims: { P31: [{ mainsnak: { snaktype: "value", property: "P31", datavalue: null } }] } },
    ],
    ["a statement list that is a number", { claims: { P31: 5 } }],
    [
      "a null qualifier list",
      {
        claims: {
          P31: [{ mainsnak: { snaktype: "novalue", property: "P31" }, qualifiers: { P1: null } }],
        },
      },
    ],
    [
      "a null reference",
      {
        claims: {
          P31: [{ mainsnak: { snaktype: "novalue", property: "P31" }, references: [null] }],
        },
      },
    ],
    ["a null sitelink", { sitelinks: { enwiki: null } }],
    [
      "badges that are a number",
      { sitelinks: { enwiki: { site: "enwiki", title: "X", badges: 5 } } },
    ],
    ["a null alias list", { aliases: { en: null } }],
    ["a claims map that is a string", { claims: "P31" }],
    [
      "references that are an object",
      {
        claims: {
          P31: [{ mainsnak: { snaktype: "novalue", property: "P31" }, references: { 0: null } }],
        },
      },
    ],
  ];

  it.each(malformed)("keeps a best-effort item for %s instead of throwing", (_, fields) => {
    expect(decoded({ type: "item", id: "Q1", ...fields }).id).toBe("Q1");
  });

  it("drops only the unusable entries, keeping the rest of the item", () => {
    const item = Wikidata.decodeEntity({
      type: "item",
      id: "Q1",
      labels: { en: { language: "en", value: "One" }, de: null },
      aliases: { en: [null, { value: "Uno" }, 5] },
      sitelinks: { dewiki: null, enwiki: { site: "enwiki", title: "One", badges: "Q17437796" } },
      claims: {
        P31: [
          null,
          { mainsnak: { snaktype: "value", property: "P31", datavalue: null } },
          { mainsnak: { snaktype: "novalue", property: "P31" }, qualifiers: null, references: 5 },
        ],
      },
    });
    expect(item).toEqual(
      Option.some({
        id: "Q1",
        type: Option.some("item"),
        labels: { en: "One" },
        descriptions: {},
        aliases: { en: ["Uno"] },
        sitelinks: { enwiki: { site: "enwiki", title: "One", badges: [] } },
        claims: {
          P31: [
            {
              id: Option.none(),
              rank: "normal",
              mainsnak: { _tag: "somevalue", property: "P31", datatype: Option.none() },
              qualifiers: {},
              references: [],
            },
            {
              id: Option.none(),
              rank: "normal",
              mainsnak: { _tag: "novalue", property: "P31", datatype: Option.none() },
              qualifiers: {},
              references: [],
            },
          ],
        },
      }),
    );
  });
});

describe("Wikidata maps keyed by a response's __proto__ (#164)", () => {
  // JSON decoding makes `__proto__` an own key, as a dump line or a decoded
  // `wbgetentities` body would carry it.
  const parseJson = Schema.decodeSync(Schema.fromJsonString(Schema.Json));
  const item = decoded(
    parseJson(
      '{"id":"Q1"' +
        ',"labels":{"__proto__":{"value":"Proto"},"en":{"value":"En"}}' +
        ',"descriptions":{"__proto__":{"value":"Proto"},"en":{"value":"En"}}' +
        ',"aliases":{"__proto__":[{"value":"Proto"}],"en":[{"value":"En"}]}' +
        ',"sitelinks":{"__proto__":{"title":"Proto"},"enwiki":{"title":"En"}}}',
    ),
  );

  it.each(["labels", "descriptions", "aliases", "sitelinks"] as const)(
    "drops the key from %s, keeping the map's prototype and its other entries",
    (map) => {
      const value: R.ReadonlyRecord<string, string | readonly string[] | Wikidata.Sitelink> =
        item[map];
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      expect(R.keys(value)).toEqual([map === "sitelinks" ? "enwiki" : "en"]);
      expect(value["title"]).toBeUndefined();
      expect(value["value"]).toBeUndefined();
    },
  );

  it("does not count the key towards MAX_SITELINKS", () => {
    const sitelinks = Arr.makeBy(
      Wikidata.MAX_SITELINKS,
      (i) => `"site${i}wiki":{"title":"P${i}"}`,
    ).join(",");
    const raw = parseJson(`{"id":"Q1","sitelinks":{"__proto__":{"title":"Proto"},${sitelinks}}}`);
    const keys = R.keys(decoded(raw).sitelinks);
    expect(keys).toHaveLength(Wikidata.MAX_SITELINKS);
    expect(keys.at(-1)).toBe(`site${Wikidata.MAX_SITELINKS - 1}wiki`);
  });

  it("drops the key on the normaliseEntities path too", () => {
    const response = Schema.decodeUnknownSync(Wikidata.WbGetEntitiesResponse)(
      parseJson('{"entities":{"Q1":{"id":"Q1","sitelinks":{"__proto__":{"title":"Proto"}}}}}'),
    );
    const entities = Wikidata.normaliseEntities(response);
    expect(Object.getPrototypeOf(entities["Q1"]?.sitelinks)).toBe(Object.prototype);
    expect(R.keys(entities["Q1"]?.sitelinks ?? {})).toEqual([]);
  });
});

// ── Fixture round-trip: decode → typed access ────────────────────────────

layer(Core.wikimediaLayer)("Wikidata.getEntities — recorded fixture round-trip", (it) => {
  const load = () => {
    const { urls, provideFetch } = stubWikidata(() => fixture);
    return { urls, provideFetch };
  };

  it.effect("decodes the item's identity, labels, descriptions, aliases, and sitelinks", () =>
    Effect.gen(function* () {
      const { provideFetch } = load();
      const entities = yield* Wikidata.getEntities("www.wikidata.org", ["Q42"]).pipe(provideFetch);
      const item = entities.Q42;
      expect(item).toBeDefined();
      if (item === undefined) return expect.unreachable("Q42 missing");
      expect(item.id).toBe("Q42");
      expect(item.type).toEqual(Option.some("item"));
      expect(item.labels.en).toBe("Douglas Adams");
      expect(item.descriptions.en).toContain("science fiction");
      expect(item.aliases.en).toContain("Douglas Noel Adams");
      expect(item.sitelinks.enwiki?.title).toBe("Douglas Adams");
      expect(item.sitelinks.enwiki?.badges).toEqual(["Q17437798"]);
    }),
  );

  it.effect("decodes a wikibase-entityid main snak with rank, qualifiers, and references", () =>
    Effect.gen(function* () {
      const { provideFetch } = load();
      const { Q42 } = yield* Wikidata.getEntities("www.wikidata.org", ["Q42"]).pipe(provideFetch);
      const statement = Q42?.claims.P31?.[0];
      expect(statement?.rank).toBe("preferred");
      const value = claimValue(Q42, "P31", "wikibase-entityid");
      expect(value.id).toBe("Q5");
      expect(value.entityType).toEqual(Option.some("item"));
      // Qualifier (P805) and the date-of-birth reference are present and typed.
      expect(statement?.qualifiers.P805?.[0]).toMatchObject({ _tag: "value" });
      expect(Q42?.claims.P569?.[0]?.references[0]?.snaks.P248?.[0]).toMatchObject({
        _tag: "value",
      });
    }),
  );

  it.effect("decodes a time value with precision and calendar model", () =>
    Effect.gen(function* () {
      const { provideFetch } = load();
      const { Q42 } = yield* Wikidata.getEntities("www.wikidata.org", ["Q42"]).pipe(provideFetch);
      const time = claimValue(Q42, "P569", "time");
      expect(time.time).toBe("+1952-03-11T00:00:00Z");
      expect(time.precision).toEqual(Option.some(11));
      expect(time.calendarModel).toEqual(Option.some("http://www.wikidata.org/entity/Q1985727"));
    }),
  );

  it.effect("decodes a globecoordinate value", () =>
    Effect.gen(function* () {
      const { provideFetch } = load();
      const { Q42 } = yield* Wikidata.getEntities("www.wikidata.org", ["Q42"]).pipe(provideFetch);
      const coord = claimValue(Q42, "P625", "globecoordinate");
      expect(Option.getOrNull(coord.latitude)).toBeCloseTo(52.2053);
      expect(Option.getOrNull(coord.longitude)).toBeCloseTo(0.1218);
      expect(coord.altitude).toEqual(Option.none());
      expect(coord.globe).toEqual(Option.some("http://www.wikidata.org/entity/Q2"));
    }),
  );

  it.effect("decodes a quantity value with unit and bounds (raw decimal strings)", () =>
    Effect.gen(function* () {
      const { provideFetch } = load();
      const { Q42 } = yield* Wikidata.getEntities("www.wikidata.org", ["Q42"]).pipe(provideFetch);
      const quantity = claimValue(Q42, "P2048", "quantity");
      expect(quantity.amount).toBe("+1.96");
      expect(quantity.unit).toEqual(Option.some("http://www.wikidata.org/entity/Q11573"));
      expect(quantity.upperBound).toEqual(Option.some("+1.97"));
      expect(quantity.lowerBound).toEqual(Option.some("+1.95"));
    }),
  );

  it.effect("decodes a monolingualtext value", () =>
    Effect.gen(function* () {
      const { provideFetch } = load();
      const { Q42 } = yield* Wikidata.getEntities("www.wikidata.org", ["Q42"]).pipe(provideFetch);
      const text = claimValue(Q42, "P1813", "monolingualtext");
      expect(text.text).toBe("Douglas Adams");
      expect(text.language).toEqual(Option.some("en"));
    }),
  );

  it.effect("splits a string datavalue by datatype: external-id vs plain string", () =>
    Effect.gen(function* () {
      const { provideFetch } = load();
      const { Q42 } = yield* Wikidata.getEntities("www.wikidata.org", ["Q42"]).pipe(provideFetch);
      // P214 (VIAF) has datatype external-id → external-id member.
      expect(claimValue(Q42, "P214", "external-id").value).toBe("113230702");
      // P18 (image, commonsMedia) and P856 (url) are plain string members.
      expect(claimValue(Q42, "P18", "string").value).toBe("Douglas adams portrait cropped.jpg");
      expect(claimValue(Q42, "P856", "string").value).toBe("https://douglasadams.com");
    }),
  );

  it.effect("decodes somevalue and novalue snaks", () =>
    Effect.gen(function* () {
      const { provideFetch } = load();
      const { Q42 } = yield* Wikidata.getEntities("www.wikidata.org", ["Q42"]).pipe(provideFetch);
      expect(Q42?.claims.P1477?.[0]?.mainsnak).toMatchObject({ _tag: "somevalue" });
      expect(Q42?.claims.P40?.[0]?.mainsnak).toMatchObject({ _tag: "novalue" });
    }),
  );

  it.effect("degrades an unknown datatype to a typed Unknown member (never a decode failure)", () =>
    Effect.gen(function* () {
      const { provideFetch } = load();
      const { Q42 } = yield* Wikidata.getEntities("www.wikidata.org", ["Q42"]).pipe(provideFetch);
      const unknown = claimValue(Q42, "P9999", "unknown");
      expect(unknown.type).toEqual(Option.some("future-datatype-not-yet-modelled"));
      // The raw payload is preserved for inspection.
      expect(unknown.value).toEqual({ some: "shape", the: "decoder", does: "not know" });
    }),
  );
});

// ── Batching / 50-id chunking ────────────────────────────────────────────

layer(Core.wikimediaLayer)("Wikidata.getEntities — batching", (it) => {
  it.effect("validates ids before any request and fails InvalidRequest on a bad id", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubWikidata(() => ({ entities: {} }));
      assertInstanceOf(
        yield* Effect.flip(
          Wikidata.getEntities("www.wikidata.org", ["Q42", "not-an-id"]).pipe(provideFetch),
        ),
        Core.InvalidRequest,
      );
      expect(urls).toEqual([]);
    }),
  );

  it.effect("chunks a >50-id request into batches of at most 50 and merges the results", () =>
    Effect.gen(function* () {
      const ids = Array.from({ length: 60 }, (_, i) => `Q${i + 1}`);
      // Echo each requested id as a minimal present entity.
      const { urls, provideFetch } = stubWikidata((url) => {
        const requested = (url.searchParams.get("ids") ?? "").split("|").filter(Boolean);
        return {
          entities: R.fromEntries(Arr.map(requested, (id) => [id, { id, type: "item" }])),
        };
      });
      const result = yield* Wikidata.getEntities("www.wikidata.org", ids).pipe(provideFetch);
      expect(R.keys(result)).toHaveLength(60);
      expect(result.Q1?.id).toBe("Q1");
      expect(result.Q60?.id).toBe("Q60");
      // 60 ids → two requests (50 + 10).
      expect(urls).toHaveLength(2);
      const firstIds = new URL(urls[0] ?? "").searchParams.get("ids")?.split("|") ?? [];
      expect(firstIds.length).toBeLessThanOrEqual(50);
    }),
  );

  it.effect("omits an entity Wikidata flags as missing", () =>
    Effect.gen(function* () {
      const { provideFetch } = stubWikidata(() => ({
        entities: { Q1: { id: "Q1", type: "item" }, Q999999999: { id: "Q999999999", missing: "" } },
      }));
      const result = yield* Wikidata.getEntities("www.wikidata.org", ["Q1", "Q999999999"]).pipe(
        provideFetch,
      );
      expect(result.Q1).toBeDefined();
      expect(result.Q999999999).toBeUndefined();
    }),
  );
});

// ── wbsearchentities ─────────────────────────────────────────────────────

layer(Core.wikimediaLayer)("Wikidata.searchEntities", (it) => {
  it.effect("normalises hits and drops entries whose id is not a valid entity id", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubWikidata(() => ({
        search: [
          {
            id: "Q42",
            label: "Douglas Adams",
            description: "English writer",
            match: { type: "label", language: "en", text: "Douglas Adams" },
          },
          { id: "not-an-id", label: "junk" },
        ],
      }));
      const result = yield* Wikidata.searchEntities("www.wikidata.org", "Douglas Adams").pipe(
        provideFetch,
      );
      expect(result).toEqual([
        {
          id: "Q42",
          label: Option.some("Douglas Adams"),
          description: Option.some("English writer"),
          matchType: Option.some("label"),
          matchText: Option.some("Douglas Adams"),
        },
      ]);
      expect(urls[0]).toContain("action=wbsearchentities");
      expect(urls[0]).toContain("type=item");
    }),
  );

  it.effect("rejects a blank query before any request", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubWikidata(() => ({}));
      assertInstanceOf(
        yield* Effect.flip(Wikidata.searchEntities("www.wikidata.org", "   ").pipe(provideFetch)),
        Core.InvalidRequest,
      );
      expect(urls).toEqual([]);
    }),
  );

  it.effect("rejects a malformed language before any request", () =>
    Effect.gen(function* () {
      const { urls, provideFetch } = stubWikidata(() => ({}));
      assertInstanceOf(
        yield* Effect.flip(
          Wikidata.searchEntities("www.wikidata.org", "x", { language: "en|junk" }).pipe(
            provideFetch,
          ),
        ),
        Core.InvalidRequest,
      );
      expect(urls).toEqual([]);
    }),
  );
});
