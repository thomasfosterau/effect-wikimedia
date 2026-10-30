/**
 * Redirect detection over a parsed {@link Document}: whether a page is a
 * `#REDIRECT [[Target]]`, and to where. A query, not an AST node, so the
 * {@link Node} union and the round-trip contract are untouched.
 *
 * @copyright Thomas Foster
 * @module wikitext/redirect
 */

import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import type { Node, Wikilink } from "./ast.ts";
import { type Fragment, stripToText } from "./query.ts";

/** Options for {@link redirectTarget}. */
export interface RedirectTargetOptions {
  /**
   * More spellings of the redirect magic word to accept besides `#REDIRECT`,
   * each written with its `#`, such as a wiki's localised aliases
   * (`#WEITERLEITUNG` on the German Wikipedia, `#REDIRECTION` on the French).
   * Matched case-insensitively, as `#REDIRECT` is. Defaults to none.
   */
  readonly aliases?: readonly string[] | undefined;
}

// PHP's `ltrim` and PCRE's `\s` without the `u` flag: the ASCII whitespace
// MediaWiki skips before the magic word and around the optional `:`.
const WS = "[ \\t\\n\\r\\f\\v\\0]*";

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches the whole run of text before the link: the magic word, then an optional `:`. */
function prefixPattern(aliases: readonly string[]): RegExp {
  const words = ["#REDIRECT", ...aliases].map(escapeRegExp).join("|");
  return new RegExp(`^${WS}(?:${words})${WS}:?${WS}$`, "iu");
}

const DEFAULT_PREFIX = prefixPattern([]);

const nodesOf = (input: Fragment): readonly Node[] =>
  Predicate.isTagged(input, "Document") ? input.children : input;

// A target is a title only when it is plain text and entities; a template,
// comment, tag or other markup in it makes the title invalid to MediaWiki.
const isTitleNode = (node: Node): boolean =>
  Predicate.isTagged(node, "Text") || Predicate.isTagged(node, "HtmlEntity");

/** The link's target as a title string; `null` when it is not one. */
function linkTitle(link: Wikilink): string | null {
  if (!Arr.every(link.target, isTitleNode)) return null;
  const title = stripToText(link.target).trim().replace(/^:\s*/, "").trim();
  const page = title.split("#", 1)[0] ?? "";
  return Str.isEmpty(page.trim()) ? null : title;
}

/**
 * The page a redirect points to, or `null` when `input` is not a redirect:
 * MediaWiki's rule, so `#REDIRECT` (or one of `options.aliases`) must open
 * the page, after nothing but whitespace, case-insensitively, followed by
 * whitespace and an optional `:` and then a wikilink, as in
 * `#REDIRECT [[Target]]` or `#redirect:[[Target]]`. Whatever follows the
 * link (a category, a `{{R from …}}` template) is ignored. A comment or any
 * other markup before the link means it is not a redirect.
 *
 * The target is the link's target text: entities decoded, surrounding
 * whitespace and a leading `:` (`[[:Category:Foo]]`) removed, and a
 * `#section` kept (`Foo#Bar`), but otherwise not normalised: underscores,
 * first-letter case and `%`-escapes stay as written, where MediaWiki would
 * normalise them. A target holding markup (a template, a comment) or nothing
 * before its `#` gives `null`, as MediaWiki rejects it. Pure and total.
 */
export function redirectTarget(input: Fragment, options?: RedirectTargetOptions): string | null {
  const nodes = nodesOf(input);
  const linkAt = nodes.findIndex((node) => !Predicate.isTagged(node, "Text"));
  const link = linkAt === -1 ? undefined : nodes[linkAt];
  if (link === undefined || !Predicate.isTagged(link, "Wikilink")) return null;
  const aliases = options?.aliases ?? [];
  const pattern = Arr.isReadonlyArrayNonEmpty(aliases) ? prefixPattern(aliases) : DEFAULT_PREFIX;
  return pattern.test(stripToText(nodes.slice(0, linkAt))) ? linkTitle(link) : null;
}
