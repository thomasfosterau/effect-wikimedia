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
  const cases: ReadonlyArray<readonly [string, Option.Option<string>]> = [
    ["#REDIRECT [[Target]]", Option.some("Target")],
    ["#REDIRECT[[Target]]", Option.some("Target")],
    ["#redirect [[Target]]", Option.some("Target")],
    ["#ReDiReCt [[Target]]", Option.some("Target")],
    ["  \n\t#REDIRECT [[Target]]", Option.some("Target")],
    ["#REDIRECT:[[Target]]", Option.some("Target")],
    ["#REDIRECT : [[Target]]", Option.some("Target")],
    ["#REDIRECT [[ Target ]]", Option.some("Target")],
    ["#REDIRECT [[Target|label]]", Option.some("Target")],
    ["#REDIRECT [[Foo#Bar]]", Option.some("Foo#Bar")],
    ["#REDIRECT [[:Category:Writers]]", Option.some("Category:Writers")],
    ["#REDIRECT [[Category:Writers]]", Option.some("Category:Writers")],
    ["#REDIRECT [[A &amp; B]]", Option.some("A & B")],
    ["#REDIRECT [[Under_score]]", Option.some("Under_score")],
    ["#REDIRECT [[Target]]\n\n{{R from move}}\n[[Category:X]]", Option.some("Target")],
    // Not redirects.
    ["", Option.none()],
    ["Target", Option.none()],
    ["[[Target]]", Option.none()],
    ["#REDIRECT", Option.none()],
    ["#REDIRECT Target", Option.none()],
    ["Text #REDIRECT [[Target]]", Option.none()],
    ["<!-- c -->#REDIRECT [[Target]]", Option.none()],
    ["#REDIRECT <!-- c --> [[Target]]", Option.none()],
    ["#REDIRECT :: [[Target]]", Option.none()],
    ["#REDIRECTION [[Target]]", Option.none()],
    ["#WEITERLEITUNG [[Ziel]]", Option.none()],
    ["#REDIRECT {{Target}}", Option.none()],
    ["#REDIRECT [[{{Target}}]]", Option.none()],
    ["#REDIRECT [[Target<!-- c -->]]", Option.none()],
    ["#REDIRECT [[#Section]]", Option.none()],
    ["#REDIRECT [[ : ]]", Option.none()],
    [" #REDIRECT [[Target]]", Option.none()],
  ];
  it.each(cases)("%j → %j", (source, expected) => {
    expect(redirectTarget(parse(source))).toEqual(expected);
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
    expect(redirectTarget(parse("#REDIRECT [[T]]"), {})).toEqual(Option.some("T"));
  });

  it("leaves the document's round trip untouched", () => {
    const source = "#REDIRECT [[Target]]\n{{R from move}}";
    const document = parse(source);
    redirectTarget(document);
    expect(serialize(document)).toBe(source);
  });
});
