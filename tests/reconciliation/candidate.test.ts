/**
 * Unit tests for the pure Wikidata candidate helpers (`src/candidate.ts`).
 *
 * Covers the injection-relevant input validators (label query, QID,
 * property id, external-id value) and the untrusted-text sanitiser. No
 * network, no database.
 *
 * @module tests/candidate
 */

import * as Struct from "effect/Struct";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import {
  EXTERNAL_ID_AUTHORITIES,
  MAX_LABEL_QUERY_LENGTH,
  MAX_CANDIDATE_TEXT_LENGTH,
  normaliseExternalIdValue,
  normaliseLabelQuery,
  normalisePropertyId,
  normaliseQid,
  sanitiseCandidateText,
  normaliseCommonsImage,
  normaliseTimeValue,
  wikidataEntityIri,
} from "../../src/reconciliation/index.ts";
import { Core, Reconciliation, Wikidata } from "../../src/index.ts";

describe("normaliseLabelQuery", () => {
  it("trims and collapses internal whitespace", () => {
    expect(Option.getOrNull(normaliseLabelQuery("  Douglas   Adams \n"))).toBe("Douglas Adams");
  });

  it("returns null for whitespace-only input", () => {
    expect(Option.getOrNull(normaliseLabelQuery("   "))).toBeNull();
    expect(Option.getOrNull(normaliseLabelQuery("\t\n\u00a0"))).toBeNull();
  });

  it("clamps an over-long query to the max length", () => {
    const result = Option.getOrNull(normaliseLabelQuery("x".repeat(MAX_LABEL_QUERY_LENGTH + 100)));
    expect(result?.length).toBe(MAX_LABEL_QUERY_LENGTH);
  });
});

describe("normaliseQid", () => {
  it("accepts a well-formed QID and upper-cases the prefix", () => {
    expect(Option.getOrNull(normaliseQid("q42"))).toBe("Q42");
    expect(Option.getOrNull(normaliseQid("  Q12345  "))).toBe("Q12345");
  });

  it.each([
    ["no Q prefix", "42"],
    ["a P id", "P31"],
    ["a leading zero", "Q042"],
    ["letters in the body", "Q4a2"],
    ["a path-traversal attempt", "../../etc/passwd"],
    ["a slash", "Q42/foo"],
    ["empty", ""],
  ])("rejects %s", (_label, value) => {
    expect(Option.getOrNull(normaliseQid(value))).toBeNull();
  });
});

describe("normalisePropertyId", () => {
  it("accepts a well-formed property id, upper-cased", () => {
    expect(Option.getOrNull(normalisePropertyId("p214"))).toBe("P214");
  });

  it.each([
    ["a Q id", "Q42"],
    ["no digits", "P"],
    ["a leading zero", "P0214"],
    ["a pipe (term injection)", "P214|P31"],
  ])("rejects %s", (_label, value) => {
    expect(Option.getOrNull(normalisePropertyId(value))).toBeNull();
  });
});

describe("normaliseExternalIdValue", () => {
  it("accepts a typical identifier value with separators", () => {
    expect(Option.getOrNull(normaliseExternalIdValue("0000-0002-1825-0097"))).toBe(
      "0000-0002-1825-0097",
    );
    expect(Option.getOrNull(normaliseExternalIdValue("113230702"))).toBe("113230702");
  });

  it.each([
    ["a pipe that would OR a second statement", "113230702|haswbstatement:P31=Q5"],
    ["a control character", "1132\u000030702"],
    ["empty", ""],
    ["an over-long value", "a".repeat(300)],
  ])("rejects %s", (_label, value) => {
    expect(Option.getOrNull(normaliseExternalIdValue(value))).toBeNull();
  });
});

describe("sanitiseCandidateText", () => {
  it("trims and collapses internal whitespace", () => {
    expect(Option.getOrNull(sanitiseCandidateText("  hello   world \n"))).toBe("hello world");
  });

  it("returns null for whitespace-only or missing input", () => {
    expect(Option.getOrNull(sanitiseCandidateText("   "))).toBeNull();
    expect(Option.getOrNull(sanitiseCandidateText(undefined))).toBeNull();
  });

  it("clamps an over-long value to the max field length", () => {
    const result = Option.getOrNull(
      sanitiseCandidateText("x".repeat(MAX_CANDIDATE_TEXT_LENGTH + 500)),
    );
    expect(result?.length).toBe(MAX_CANDIDATE_TEXT_LENGTH);
  });
});

describe("candidate text names on the barrel", () => {
  it("no longer shadow Core's MAX_TEXT_FIELD_LENGTH / sanitiseText", () => {
    // Renamed to MAX_CANDIDATE_TEXT_LENGTH and sanitiseCandidateText (#63):
    // gone from the namespace's type and from its runtime value.
    expectTypeOf(Reconciliation).not.toHaveProperty("MAX_TEXT_FIELD_LENGTH");
    expectTypeOf(Reconciliation).not.toHaveProperty("sanitiseText");
    expect(P.hasProperty(Reconciliation, "MAX_TEXT_FIELD_LENGTH")).toBe(false);
    expect(P.hasProperty(Reconciliation, "sanitiseText")).toBe(false);
    expect(Reconciliation.MAX_CANDIDATE_TEXT_LENGTH).toBe(2000);
    expect(Reconciliation.sanitiseCandidateText).toBe(sanitiseCandidateText);
  });

  it("keeps Core's looser bound and trim-only behaviour distinct", () => {
    expect(Core.MAX_TEXT_FIELD_LENGTH).toBe(4000);
    expect(Core.sanitiseText("  a   b ")).toBe("a   b");
    expect(Option.getOrNull(Reconciliation.sanitiseCandidateText("  a   b "))).toBe("a b");
  });
});

describe("wikidataEntityIri", () => {
  it("builds the canonical entity IRI for a Q/P id", () => {
    expect(wikidataEntityIri("Q42")).toBe("http://www.wikidata.org/entity/Q42");
    expect(wikidataEntityIri("P569")).toBe("http://www.wikidata.org/entity/P569");
  });
});

describe("EXTERNAL_ID_AUTHORITIES", () => {
  // Every curated authority's `iri` builder — not just VIAF (the one the
  // lookup tests happen to exercise via a live `sameAs` fact) — so a bad
  // template change anywhere in the allowlist fails a test, not just a
  // coverage gate.
  it("builds each authority's canonical IRI from its id + value", () => {
    expect(Option.getOrNull(EXTERNAL_ID_AUTHORITIES.P214?.iri("113230702") ?? Option.none())).toBe(
      "https://viaf.org/viaf/113230702",
    );
    expect(
      Option.getOrNull(EXTERNAL_ID_AUTHORITIES.P213?.iri("0000000121032683") ?? Option.none()),
    ).toBe("https://isni.org/isni/0000000121032683");
    expect(
      Option.getOrNull(EXTERNAL_ID_AUTHORITIES.P496?.iri("0000-0002-1825-0097") ?? Option.none()),
    ).toBe("https://orcid.org/0000-0002-1825-0097");
    expect(Option.getOrNull(EXTERNAL_ID_AUTHORITIES.P244?.iri("n79021164") ?? Option.none())).toBe(
      "https://id.loc.gov/authorities/names/n79021164",
    );
    expect(Option.getOrNull(EXTERNAL_ID_AUTHORITIES.P227?.iri("118540238") ?? Option.none())).toBe(
      "https://d-nb.info/gnd/118540238",
    );
    expect(Option.getOrNull(EXTERNAL_ID_AUTHORITIES.P268?.iri("119008064") ?? Option.none())).toBe(
      "https://catalogue.bnf.fr/ark:/12148/cb119008064",
    );
  });

  it("accepts each authority's other well-formed identifier shapes", () => {
    // VIAF's long (cluster) form, ISNI as Wikidata stores it (spaced, built
    // into the compact IRI), an ORCID and an ISNI with an `X` check
    // character, a ten-digit LCCN, GND's hyphenated subject/corporate forms
    // and a BnF id with a letter check character.
    expect(
      Option.getOrNull(
        EXTERNAL_ID_AUTHORITIES.P214?.iri("8159156797922315270004") ?? Option.none(),
      ),
    ).toBe("https://viaf.org/viaf/8159156797922315270004");
    expect(
      Option.getOrNull(EXTERNAL_ID_AUTHORITIES.P213?.iri("0000 0001 2103 2683") ?? Option.none()),
    ).toBe("https://isni.org/isni/0000000121032683");
    expect(
      Option.getOrNull(EXTERNAL_ID_AUTHORITIES.P213?.iri("000000012146438X") ?? Option.none()),
    ).toBe("https://isni.org/isni/000000012146438X");
    expect(
      Option.getOrNull(EXTERNAL_ID_AUTHORITIES.P496?.iri("0000-0002-1694-233X") ?? Option.none()),
    ).toBe("https://orcid.org/0000-0002-1694-233X");
    expect(
      Option.getOrNull(EXTERNAL_ID_AUTHORITIES.P244?.iri("no2010123456") ?? Option.none()),
    ).toBe("https://id.loc.gov/authorities/names/no2010123456");
    expect(Option.getOrNull(EXTERNAL_ID_AUTHORITIES.P227?.iri("4015701-7") ?? Option.none())).toBe(
      "https://d-nb.info/gnd/4015701-7",
    );
    expect(Option.getOrNull(EXTERNAL_ID_AUTHORITIES.P227?.iri("2028309-X") ?? Option.none())).toBe(
      "https://d-nb.info/gnd/2028309-X",
    );
    expect(Option.getOrNull(EXTERNAL_ID_AUTHORITIES.P268?.iri("11907966z") ?? Option.none())).toBe(
      "https://catalogue.bnf.fr/ark:/12148/cb11907966z",
    );
  });

  // #59: `normaliseExternalIdValue` lets `.`, `/`
  // and spaces through, so an unchecked template would build
  // `https://viaf.org/viaf/../../x`, which resolves to `https://viaf.org/x`.
  const relativePathValues = [
    ".",
    "..",
    "../../x",
    "./x",
    "x/..",
    "%2e%2e",
    "113230702/../../x",
    "0000-0002-1825-0097/../x",
    "n79021164/..",
    "118540238/../../x",
    "119008064/..",
    "0000 0001 2103 2683/..",
    // A prefix before a well-formed identifier: these pin each format's
    // leading `^`. Every value an anchored format accepts is digits, ASCII
    // letters and `-`, which `encodeURIComponent` leaves alone, so the
    // anchors (not the encoding) are what keep `/` and `.` out of the IRI.
    "../113230702",
    "../0000 0001 2103 2683",
    "x/0000-0002-1825-0097",
    "../n79021164",
    "../118540238",
    "../119008064",
  ];

  it.each(R.toEntries(EXTERNAL_ID_AUTHORITIES))(
    "%s refuses every relative-path value",
    (_property, scheme) => {
      expect(Arr.map(relativePathValues, scheme.iri)).toEqual(
        Arr.map(relativePathValues, () => Option.none()),
      );
    },
  );

  it.each([
    ["P214", "11323070x"],
    ["P214", "0113230702"],
    ["P213", "0000 0001 21032683"],
    ["P213", "1000000121032683"],
    ["P496", "0000-0002-1825-009"],
    ["P496", "0000000218250097"],
    ["P244", "79021164"],
    ["P244", "N79021164"],
    ["P227", "118540238 "],
    ["P227", "x118540238"],
    ["P268", "119008064a"],
    ["P268", "cb119008064"],
  ])("%s refuses %j, which is outside its identifier format", (property, value) => {
    expect(
      Option.getOrNull(EXTERNAL_ID_AUTHORITIES[property]?.iri(value) ?? Option.none()),
    ).toBeNull();
  });

  it("keeps every built IRI inside the authority's identifier path", () => {
    const valid = R.fromEntries([
      ["P214", "113230702"],
      ["P213", "0000 0001 2103 2683"],
      ["P496", "0000-0002-1825-0097"],
      ["P244", "n79021164"],
      ["P227", "4015701-7"],
      ["P268", "119008064"],
    ]);
    expect(R.keys(valid)).toEqual(R.keys(EXTERNAL_ID_AUTHORITIES));
    Arr.forEach(R.toEntries(EXTERNAL_ID_AUTHORITIES), ([property, scheme]) => {
      const iri = Option.getOrNull(scheme.iri(valid[property] ?? ""));
      expect(iri, property).toEqual(expect.any(String));
      // Resolving the IRI must not move it: no dot segment, no extra `/`.
      expect(new URL(iri ?? "").href, property).toBe(iri);
    });
  });

  it("names every curated property with its authority", () => {
    expect(R.keys(EXTERNAL_ID_AUTHORITIES)).toEqual(
      expect.arrayContaining(["P214", "P213", "P496", "P244", "P227", "P268"]),
    );
    expect(
      Arr.every(R.values(EXTERNAL_ID_AUTHORITIES), ({ authority }) => Str.isNonEmpty(authority)),
    ).toBe(true);
  });
});

describe("normaliseTimeValue", () => {
  it("accepts a Wikidata timestamp and drops the leading +", () => {
    expect(Option.getOrNull(normaliseTimeValue("+1952-03-11T00:00:00Z"))).toBe(
      "1952-03-11T00:00:00Z",
    );
    expect(Option.getOrNull(normaliseTimeValue("-0044-03-15T00:00:00Z"))).toBe(
      "-0044-03-15T00:00:00Z",
    );
  });

  it("rejects anything that isn't a Wikidata-shaped timestamp", () => {
    expect(Option.getOrNull(normaliseTimeValue("yesterday"))).toBeNull();
    expect(Option.getOrNull(normaliseTimeValue("1952-03-11"))).toBeNull();
  });
});

describe("normaliseCommonsImage", () => {
  it("builds the Special:FilePath URL for a Commons filename", () => {
    expect(Option.getOrNull(normaliseCommonsImage("Douglas adams portrait.jpg"))).toEqual({
      filename: "Douglas adams portrait.jpg",
      iri: "https://commons.wikimedia.org/wiki/Special:FilePath/Douglas%20adams%20portrait.jpg",
    });
  });

  it("keeps a File: prefix as the claim spells it, unlike Commons.filePathUrl", () => {
    // Wikibase `commonsMedia` values carry no prefix, so `ImageFact.filename`
    // has none in practice; this helper doesn't strip one if it appears.
    expect(Option.getOrNull(normaliseCommonsImage("File:Foo.jpg"))).toEqual({
      filename: "File:Foo.jpg",
      iri: "https://commons.wikimedia.org/wiki/Special:FilePath/File%3AFoo.jpg",
    });
  });

  it("rejects path-breaking characters and empty / non-string input", () => {
    expect(Option.getOrNull(normaliseCommonsImage("evil#name.jpg"))).toBeNull();
    expect(Option.getOrNull(normaliseCommonsImage("a?b.jpg"))).toBeNull();
    expect(Option.getOrNull(normaliseCommonsImage(""))).toBeNull();
  });

  it.each([
    "Foo\tBar.jpg",
    "Foo\nBar.jpg",
    "Foo\rBar.jpg",
    "Foo\u000bBar.jpg",
    "Foo\u000cBar.jpg",
    "Foo\u0000Bar.jpg",
    "Foo\u007fBar.jpg",
  ])("rejects the control character in %j, including whitespace ones", (filename) => {
    expect(Option.getOrNull(normaliseCommonsImage(filename))).toBeNull();
  });

  it.each([
    ".",
    "..",
    " .. ",
    "./Foo.jpg",
    "../Foo.jpg",
    "Foo/./Bar.jpg",
    "Foo/../Bar.jpg",
    "Foo/.",
    "Foo/..",
  ])(
    "rejects MediaWiki's relative-path filename %j, which new URL would resolve away",
    (filename) => {
      expect(Option.getOrNull(normaliseCommonsImage(filename))).toBeNull();
    },
  );

  it("keeps a filename that merely contains dots", () => {
    expect(Option.getOrNull(normaliseCommonsImage("Mr. Smith.jpg"))).toEqual({
      filename: "Mr. Smith.jpg",
      iri: "https://commons.wikimedia.org/wiki/Special:FilePath/Mr.%20Smith.jpg",
    });
    expect(Option.getOrNull(normaliseCommonsImage("..."))?.iri).toBe(
      "https://commons.wikimedia.org/wiki/Special:FilePath/...",
    );
  });

  it("rejects a lone UTF-16 surrogate and keeps a valid surrogate pair", () => {
    expect(Option.getOrNull(normaliseCommonsImage("Foo\uD800Bar.jpg"))).toBeNull();
    expect(Option.getOrNull(normaliseCommonsImage("Foo\uDC00Bar.jpg"))).toBeNull();
    expect(Option.getOrNull(normaliseCommonsImage("Smile \u{1F600}.jpg"))?.iri).toBe(
      "https://commons.wikimedia.org/wiki/Special:FilePath/Smile%20%F0%9F%98%80.jpg",
    );
  });
});

// The validators take `string` now; a non-string is stopped where the wire
// is decoded, before it can reach them. These pin that boundary.
describe("non-string wire values never reach the validators", () => {
  const p569 = (value: Schema.Json) =>
    Wikidata.decodeEntity({
      id: "Q1",
      claims: {
        P569: [{ mainsnak: { snaktype: "value", property: "P569", datavalue: value } }],
      },
    });
  const mainValue = (item: Option.Option<Wikidata.WikidataItem>) =>
    Option.flatMap(item, (i) =>
      Option.fromNullishOr(i.claims["P569"]?.[0]?.mainsnak).pipe(
        Option.flatMap((snak) =>
          P.isTagged(snak, "value") ? Option.some(Struct.get(snak.value, "_tag")) : Option.none(),
        ),
      ),
    );

  it("a non-string time degrades to an unknown datavalue", () => {
    expect(mainValue(p569({ type: "time", value: { time: 42 } }))).toEqual(Option.some("unknown"));
  });

  it("a null image filename degrades to an unknown datavalue", () => {
    expect(mainValue(p569({ type: "string", value: null }))).toEqual(Option.some("unknown"));
  });

  it("a non-string search label is None, so no candidate text is built from it", () => {
    const [hit] = Wikidata.normaliseSearch({ search: [{ id: "Q1", label: 42 }] });
    expect(hit?.label).toEqual(Option.none());
  });
});
