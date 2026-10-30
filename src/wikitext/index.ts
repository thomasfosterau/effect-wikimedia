/**
 * The `Wikitext` module of `@thomasfosterau/effect-wikimedia` (website#1065):
 * a pure wikitext → typed AST parser in the `mwparserfromhell` niche,
 * written with the `@thomasfosterau/effect-parse` parser combinators.
 * Wikitext in, a manipulable {@link Document} out — no network, no template
 * expansion, no HTML rendering. {@link parse} is a plain synchronous
 * function: it needs no Effect runtime and never fails.
 *
 * ```ts
 * import { Wikitext } from "@thomasfosterau/effect-wikimedia";
 *
 * const doc = Wikitext.parse("{{Infobox|name=Ada|born=1815}}");
 * Wikitext.getParam(Wikitext.findTemplates(doc, "Infobox")[0], "name"); // "Ada"
 * Wikitext.serialize(doc) === "{{Infobox|name=Ada|born=1815}}";         // true
 * ```
 *
 * @copyright Thomas Foster
 * @module
 */

export * from "./ast.ts";
export { parse } from "./parse.ts";
export { serialize, serializeNode, serializeNodes } from "./serialize.ts";
export {
  basicTemplateRenderers,
  type Fragment,
  filter,
  findTemplates,
  getParam,
  normaliseTemplateName,
  paramName,
  paramValue,
  type StripToTextOptions,
  stripToText,
  type TemplateRenderContext,
  type TemplateRenderer,
  templateName,
  templateParams,
  walk,
} from "./query.ts";
