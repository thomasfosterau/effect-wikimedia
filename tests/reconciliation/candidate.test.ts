/**
 * Unit tests for the pure Wikidata candidate helpers (`src/candidate.ts`).
 *
 * Covers the injection-relevant input validators (label query, QID,
 * property id, external-id value) and the untrusted-text sanitiser. No
 * network, no database.
 *
 * @module tests/candidate
 */

import { describe, expect, it } from "vite-plus/test";
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
import { Core, Reconciliation } from "../../src/index.ts";

describe("normaliseLabelQuery", () => {
  it("trims and collapses internal whitespace", () => {
    expect(normaliseLabelQuery("  Douglas   Adams \n")).toBe("Douglas Adams");
  });

  it("returns null for whitespace-only or non-string input", () => {
    expect(normaliseLabelQuery("   ")).toBeNull();
    expect(normaliseLabelQuery(undefined as unknown as string)).toBeNull();
  });

  it("clamps an over-long query to the max length", () => {
    const result = normaliseLabelQuery("x".repeat(MAX_LABEL_QUERY_LENGTH + 100));
    expect(result).not.toBeNull();
    expect(result!.length).toBe(MAX_LABEL_QUERY_LENGTH);
  });
});

describe("normaliseQid", () => {
  it("accepts a well-formed QID and upper-cases the prefix", () => {
    expect(normaliseQid("q42")).toBe("Q42");
    expect(normaliseQid("  Q12345  ")).toBe("Q12345");
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
    expect(normaliseQid(value)).toBeNull();
  });
});

describe("normalisePropertyId", () => {
  it("accepts a well-formed property id, upper-cased", () => {
    expect(normalisePropertyId("p214")).toBe("P214");
  });

  it.each([
    ["a Q id", "Q42"],
    ["no digits", "P"],
    ["a leading zero", "P0214"],
    ["a pipe (term injection)", "P214|P31"],
  ])("rejects %s", (_label, value) => {
    expect(normalisePropertyId(value)).toBeNull();
  });
});

describe("normaliseExternalIdValue", () => {
  it("accepts a typical identifier value with separators", () => {
    expect(normaliseExternalIdValue("0000-0002-1825-0097")).toBe("0000-0002-1825-0097");
    expect(normaliseExternalIdValue("113230702")).toBe("113230702");
  });

  it.each([
    ["a pipe that would OR a second statement", "113230702|haswbstatement:P31=Q5"],
    ["a control character", "1132\u000030702"],
    ["empty", ""],
    ["an over-long value", "a".repeat(300)],
  ])("rejects %s", (_label, value) => {
    expect(normaliseExternalIdValue(value)).toBeNull();
  });
});

describe("sanitiseCandidateText", () => {
  it("trims and collapses internal whitespace", () => {
    expect(sanitiseCandidateText("  hello   world \n")).toBe("hello world");
  });

  it("returns null for whitespace-only or non-string input", () => {
    expect(sanitiseCandidateText("   ")).toBeNull();
    expect(sanitiseCandidateText(undefined)).toBeNull();
    expect(sanitiseCandidateText(42)).toBeNull();
  });

  it("clamps an over-long value to the max field length", () => {
    const result = sanitiseCandidateText("x".repeat(MAX_CANDIDATE_TEXT_LENGTH + 500));
    expect(result).not.toBeNull();
    expect(result!.length).toBe(MAX_CANDIDATE_TEXT_LENGTH);
  });
});

describe("candidate text names on the barrel", () => {
  it("no longer shadow Core's MAX_TEXT_FIELD_LENGTH / sanitiseText", () => {
    // @ts-expect-error renamed to MAX_CANDIDATE_TEXT_LENGTH (#63)
    expect(Reconciliation.MAX_TEXT_FIELD_LENGTH).toBeUndefined();
    // @ts-expect-error renamed to sanitiseCandidateText (#63)
    expect(Reconciliation.sanitiseText).toBeUndefined();
    expect(Reconciliation.MAX_CANDIDATE_TEXT_LENGTH).toBe(2000);
    expect(Reconciliation.sanitiseCandidateText).toBe(sanitiseCandidateText);
  });

  it("keeps Core's looser bound and trim-only behaviour distinct", () => {
    expect(Core.MAX_TEXT_FIELD_LENGTH).toBe(4000);
    expect(Core.sanitiseText("  a   b ")).toBe("a   b");
    expect(Reconciliation.sanitiseCandidateText("  a   b ")).toBe("a b");
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
    expect(EXTERNAL_ID_AUTHORITIES.P214?.iri("113230702")).toBe("https://viaf.org/viaf/113230702");
    expect(EXTERNAL_ID_AUTHORITIES.P213?.iri("0000000121032683")).toBe(
      "https://isni.org/isni/0000000121032683",
    );
    expect(EXTERNAL_ID_AUTHORITIES.P496?.iri("0000-0002-1825-0097")).toBe(
      "https://orcid.org/0000-0002-1825-0097",
    );
    expect(EXTERNAL_ID_AUTHORITIES.P244?.iri("n79021164")).toBe(
      "https://id.loc.gov/authorities/names/n79021164",
    );
    expect(EXTERNAL_ID_AUTHORITIES.P227?.iri("118540238")).toBe("https://d-nb.info/gnd/118540238");
    expect(EXTERNAL_ID_AUTHORITIES.P268?.iri("119008064")).toBe(
      "https://catalogue.bnf.fr/ark:/12148/cb119008064",
    );
  });

  it("accepts each authority's other well-formed identifier shapes", () => {
    // VIAF's long (cluster) form, ISNI as Wikidata stores it (spaced, built
    // into the compact IRI), an ORCID and an ISNI with an `X` check
    // character, a ten-digit LCCN, GND's hyphenated subject/corporate forms
    // and a BnF id with a letter check character.
    expect(EXTERNAL_ID_AUTHORITIES.P214?.iri("8159156797922315270004")).toBe(
      "https://viaf.org/viaf/8159156797922315270004",
    );
    expect(EXTERNAL_ID_AUTHORITIES.P213?.iri("0000 0001 2103 2683")).toBe(
      "https://isni.org/isni/0000000121032683",
    );
    expect(EXTERNAL_ID_AUTHORITIES.P213?.iri("000000012146438X")).toBe(
      "https://isni.org/isni/000000012146438X",
    );
    expect(EXTERNAL_ID_AUTHORITIES.P496?.iri("0000-0002-1694-233X")).toBe(
      "https://orcid.org/0000-0002-1694-233X",
    );
    expect(EXTERNAL_ID_AUTHORITIES.P244?.iri("no2010123456")).toBe(
      "https://id.loc.gov/authorities/names/no2010123456",
    );
    expect(EXTERNAL_ID_AUTHORITIES.P227?.iri("4015701-7")).toBe("https://d-nb.info/gnd/4015701-7");
    expect(EXTERNAL_ID_AUTHORITIES.P227?.iri("2028309-X")).toBe("https://d-nb.info/gnd/2028309-X");
    expect(EXTERNAL_ID_AUTHORITIES.P268?.iri("11907966z")).toBe(
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

  it.each(Object.entries(EXTERNAL_ID_AUTHORITIES))(
    "%s refuses every relative-path value",
    (_property, scheme) => {
      for (const value of relativePathValues) {
        expect(scheme.iri(value), value).toBeNull();
      }
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
    expect(EXTERNAL_ID_AUTHORITIES[property]?.iri(value)).toBeNull();
  });

  it("keeps every built IRI inside the authority's identifier path", () => {
    const valid: Record<string, string> = {
      P214: "113230702",
      P213: "0000 0001 2103 2683",
      P496: "0000-0002-1825-0097",
      P244: "n79021164",
      P227: "4015701-7",
      P268: "119008064",
    };
    for (const [property, scheme] of Object.entries(EXTERNAL_ID_AUTHORITIES)) {
      const value = valid[property];
      expect(value, property).toBeDefined();
      const iri = scheme.iri(value!);
      expect(iri, property).not.toBeNull();
      // Resolving the IRI must not move it: no dot segment, no extra `/`.
      expect(new URL(iri!).href, property).toBe(iri);
    }
  });

  it("names every curated property with its authority", () => {
    expect(Object.keys(EXTERNAL_ID_AUTHORITIES)).toEqual(
      expect.arrayContaining(["P214", "P213", "P496", "P244", "P227", "P268"]),
    );
    for (const scheme of Object.values(EXTERNAL_ID_AUTHORITIES)) {
      expect(scheme.authority.length).toBeGreaterThan(0);
    }
  });
});

describe("normaliseTimeValue", () => {
  it("accepts a Wikidata timestamp and drops the leading +", () => {
    expect(normaliseTimeValue("+1952-03-11T00:00:00Z")).toBe("1952-03-11T00:00:00Z");
    expect(normaliseTimeValue("-0044-03-15T00:00:00Z")).toBe("-0044-03-15T00:00:00Z");
  });

  it("rejects anything that isn't a Wikidata-shaped timestamp", () => {
    expect(normaliseTimeValue("yesterday")).toBeNull();
    expect(normaliseTimeValue("1952-03-11")).toBeNull();
    expect(normaliseTimeValue(42 as unknown as string)).toBeNull();
  });
});

describe("normaliseCommonsImage", () => {
  it("builds the Special:FilePath URL for a Commons filename", () => {
    expect(normaliseCommonsImage("Douglas adams portrait.jpg")).toEqual({
      externalId: "Douglas adams portrait.jpg",
      externalIri:
        "https://commons.wikimedia.org/wiki/Special:FilePath/Douglas%20adams%20portrait.jpg",
    });
  });

  it("rejects path-breaking characters and empty / non-string input", () => {
    expect(normaliseCommonsImage("evil#name.jpg")).toBeNull();
    expect(normaliseCommonsImage("a?b.jpg")).toBeNull();
    expect(normaliseCommonsImage("")).toBeNull();
    expect(normaliseCommonsImage(null as unknown as string)).toBeNull();
  });

  it("rejects control characters inside a filename, including whitespace ones", () => {
    for (const filename of [
      "Foo\tBar.jpg",
      "Foo\nBar.jpg",
      "Foo\rBar.jpg",
      "Foo\u000bBar.jpg",
      "Foo\u000cBar.jpg",
      "Foo\u0000Bar.jpg",
      "Foo\u007fBar.jpg",
    ]) {
      expect(normaliseCommonsImage(filename), JSON.stringify(filename)).toBeNull();
    }
  });

  it("rejects MediaWiki's relative-path filenames, which new URL would resolve away", () => {
    for (const filename of [
      ".",
      "..",
      " .. ",
      "./Foo.jpg",
      "../Foo.jpg",
      "Foo/./Bar.jpg",
      "Foo/../Bar.jpg",
      "Foo/.",
      "Foo/..",
    ]) {
      expect(normaliseCommonsImage(filename), filename).toBeNull();
    }
  });

  it("keeps a filename that merely contains dots", () => {
    expect(normaliseCommonsImage("Mr. Smith.jpg")).toEqual({
      externalId: "Mr. Smith.jpg",
      externalIri: "https://commons.wikimedia.org/wiki/Special:FilePath/Mr.%20Smith.jpg",
    });
    expect(normaliseCommonsImage("...")?.externalIri).toBe(
      "https://commons.wikimedia.org/wiki/Special:FilePath/...",
    );
  });

  it("rejects a lone UTF-16 surrogate and keeps a valid surrogate pair", () => {
    expect(normaliseCommonsImage("Foo\uD800Bar.jpg")).toBeNull();
    expect(normaliseCommonsImage("Foo\uDC00Bar.jpg")).toBeNull();
    expect(normaliseCommonsImage("Smile \u{1F600}.jpg")?.externalIri).toBe(
      "https://commons.wikimedia.org/wiki/Special:FilePath/Smile%20%F0%9F%98%80.jpg",
    );
  });
});
