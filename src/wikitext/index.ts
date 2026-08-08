/**
 * @copyright Thomas Foster
 *
 * The `Wikitext` module of `@thomasfosterau/effect-wikimedia` (issue #1065):
 * a pure, dependency-free wikitext → typed AST parser in the
 * `mwparserfromhell` niche. Wikitext in, a manipulable {@link Document} out
 * — no network, no template expansion, no HTML rendering.
 *
 * ```ts
 * import { Wikitext } from "@thomasfosterau/effect-wikimedia";
 *
 * const doc = Wikitext.parse("{{Infobox|name=Ada|born=1815}}");
 * Wikitext.getParam(Wikitext.findTemplates(doc, "Infobox")[0], "name"); // "Ada"
 * Wikitext.serialize(doc) === "{{Infobox|name=Ada|born=1815}}";         // true
 * ```
 *
 * @module lib/wikitext
 */

export * from "./ast.ts";
export { parse } from "./parse.ts";
export { serialize, serializeNode, serializeNodes } from "./serialize.ts";
export {
  type Fragment,
  filter,
  findTemplates,
  getParam,
  normaliseTemplateName,
  paramName,
  paramValue,
  stripToText,
  templateName,
  templateParams,
  walk,
} from "./query.ts";
