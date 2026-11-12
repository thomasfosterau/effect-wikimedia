/**
 * Redirect detection (`src/wikitext/redirect.ts`): MediaWiki's
 * `#REDIRECT [[Target]]` rule over a parsed document (#207).
 *
 * @module tests/redirect
 */

import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import { parse, redirectTarget, serialize } from "../src/wikitext/index.ts";

describe("redirectTarget", () => {
  const cases: ReadonlyArray<readonly [string, string | null]> = [
    ["#REDIRECT [[Target]]", "Target"],
    ["#REDIRECT[[Target]]", "Target"],
    ["#redirect [[Target]]", "Target"],
    ["#ReDiReCt [[Target]]", "Target"],
    ["  \n\t#REDIRECT [[Target]]", "Target"],
    ["#REDIRECT:[[Target]]", "Target"],
    ["#REDIRECT : [[Target]]", "Target"],
    ["#REDIRECT [[ Target ]]", "Target"],
    ["#REDIRECT [[Target|label]]", "Target"],
    ["#REDIRECT [[Foo#Bar]]", "Foo#Bar"],
    ["#REDIRECT [[:Category:Writers]]", "Category:Writers"],
    ["#REDIRECT [[Category:Writers]]", "Category:Writers"],
    ["#REDIRECT [[A &amp; B]]", "A & B"],
    ["#REDIRECT [[Under_score]]", "Under_score"],
    ["#REDIRECT [[Target]]\n\n{{R from move}}\n[[Category:X]]", "Target"],
    // Not redirects.
    ["", null],
    ["Target", null],
    ["[[Target]]", null],
    ["#REDIRECT", null],
    ["#REDIRECT Target", null],
    ["Text #REDIRECT [[Target]]", null],
    ["<!-- c -->#REDIRECT [[Target]]", null],
    ["#REDIRECT <!-- c --> [[Target]]", null],
    ["#REDIRECT :: [[Target]]", null],
    ["#REDIRECTION [[Target]]", null],
    ["#WEITERLEITUNG [[Ziel]]", null],
    ["#REDIRECT {{Target}}", null],
    ["#REDIRECT [[{{Target}}]]", null],
    ["#REDIRECT [[Target<!-- c -->]]", null],
    ["#REDIRECT [[#Section]]", null],
    ["#REDIRECT [[ : ]]", null],
    [" #REDIRECT [[Target]]", null],
  ];
  it.each(cases)("%j → %j", (source, expected) => {
    expect(redirectTarget(parse(source))).toEqual(Option.fromNullOr(expected));
  });

  it("accepts a fragment as well as a document", () => {
    expect(redirectTarget(parse("#REDIRECT [[Target]]").children)).toEqual(Option.some("Target"));
  });

  it("accepts caller-supplied aliases, case-insensitively, alongside #REDIRECT", () => {
    const aliases = ["#WEITERLEITUNG", "#redirection", "#a.b"];
    expect(redirectTarget(parse("#weiterleitung [[Ziel]]"), { aliases })).toEqual(
      Option.some("Ziel"),
    );
    expect(redirectTarget(parse("#REDIRECTION [[Cible]]"), { aliases })).toEqual(
      Option.some("Cible"),
    );
    expect(redirectTarget(parse("#REDIRECT [[Target]]"), { aliases })).toEqual(
      Option.some("Target"),
    );
    // An alias is literal text, not a pattern.
    expect(redirectTarget(parse("#a.b [[T]]"), { aliases })).toEqual(Option.some("T"));
    expect(redirectTarget(parse("#axb [[T]]"), { aliases })).toEqual(Option.none());
    expect(redirectTarget(parse("#REDIRECT [[T]]"), { aliases: undefined })).toEqual(
      Option.some("T"),
    );
  });

  it("leaves the document's round trip untouched", () => {
    const source = "#REDIRECT [[Target]]\n{{R from move}}";
    const document = parse(source);
    redirectTarget(document);
    expect(serialize(document)).toBe(source);
  });
});
