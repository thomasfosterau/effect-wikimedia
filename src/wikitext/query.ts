/**
 * The query / manipulation surface over a parsed {@link Document}: node
 * visitors and filters, template extraction (name + parameters), and a
 * strip-to-plain-text projection with an optional registry of template
 * renderers. All read-only and pure; edits are made by
 * rebuilding nodes and re-serializing (`./serialize.ts`).
 *
 * @copyright Thomas Foster
 * @module wikitext/query
 */

import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import type { Document, Node, Param, Template } from "./ast.ts";
import { NAMED_ENTITIES } from "./entities.ts";
import { serializeNodes } from "./serialize.ts";

/** A fragment or a whole document — the common input to the query helpers. */
export type Fragment = Document | readonly Node[];

const isNodeArray = (input: Fragment | Node): input is readonly Node[] => Array.isArray(input);

function nodesOf(input: Fragment): readonly Node[] {
  return isNodeArray(input) ? input : input.children;
}

/** The child fragments of a node (the places recursion descends into). */
const childFragments: (node: Node) => readonly (readonly Node[])[] = Match.type<Node>().pipe(
  Match.tags({
    Heading: (node) => [node.title],
    Template: (node) => [
      node.name,
      ...node.params.flatMap((p) => (p.name ? [p.name, p.value] : [p.value])),
    ],
    Argument: (node) => (node.default === undefined ? [node.name] : [node.name, node.default]),
    Wikilink: (node) => [node.target, ...node.segments],
    ExternalLink: (node) => (node.label === undefined ? [] : [node.label]),
    Table: (node) => [
      ...node.captions.map((c) => c.content),
      ...node.rows.flatMap((r) => r.cells.map((c) => c.content)),
    ],
  }),
  Match.orElse((): readonly (readonly Node[])[] => []),
);

/**
 * Visits one fragment in source order: each node, then (unless the visitor
 * returned `false`) its child fragments, before the node's next sibling.
 * Recursion is one level per nesting depth, never one per sibling.
 */
function walkFragment(frag: readonly Node[], visitor: (node: Node) => boolean | void): void {
  Arr.forEach(frag, (node) => {
    if (visitor(node) !== false) {
      Arr.forEach(childFragments(node), (kid) => walkFragment(kid, visitor));
    }
  });
}

/**
 * Depth-first pre-order walk over every node in `input`, in document order:
 * a node is visited before its children, and its children before its next
 * sibling (the order {@link filter} returns). Return `false` from `visitor`
 * to skip descending into a node's children.
 */
export function walk(input: Fragment, visitor: (node: Node) => boolean | void): void {
  walkFragment(nodesOf(input), visitor);
}

/** Collects every node (at any depth) matching `predicate`, in document order. */
export function filter(input: Fragment, predicate: (node: Node) => boolean): Node[] {
  const collect = (frag: readonly Node[]): Node[] =>
    Arr.flatMap(frag, (node) => {
      const self = predicate(node) ? [node] : [];
      return [...self, ...Arr.flatMap(childFragments(node), collect)];
    });
  return collect(nodesOf(input));
}

// ── templates ─────────────────────────────────────────────────────────

/**
 * Normalises a template/page name the way MediaWiki does for comparison:
 * trims, converts underscores to spaces, collapses internal whitespace, and
 * upper-cases the first character (titles are first-letter-insensitive).
 */
export function normaliseTemplateName(raw: string): string {
  return Str.capitalize(raw.replace(/_/g, " ").trim().replace(/\s+/g, " "));
}

/** The template's invocation name as plain text (raw, un-normalised, trimmed). */
export function templateName(template: Template): string {
  return serializeNodes(template.name).trim();
}

/**
 * Finds every {@link Template} in `input`, optionally restricted to a name
 * (compared via {@link normaliseTemplateName}), in document order. Nested
 * templates are included, each after the template that contains it.
 */
export function findTemplates(input: Fragment, name?: string): Template[] {
  const want = name === undefined ? undefined : normaliseTemplateName(name);
  const out: Template[] = [];
  walk(input, (node) => {
    if (
      Predicate.isTagged(node, "Template") &&
      (want === undefined || normaliseTemplateName(templateName(node)) === want)
    ) {
      out.push(node);
    }
  });
  return out;
}

/** A parameter's name as trimmed plain text, or `null` when positional. */
export function paramName(param: Param): string | null {
  return param.name === undefined ? null : serializeNodes(param.name).trim();
}

/** A parameter's value as trimmed plain text. */
export function paramValue(param: Param): string {
  return serializeNodes(param.value).trim();
}

/**
 * The effective `name → Param` map for a template: positional parameters
 * take 1-based indices and later duplicates win, so `1=` overrides the first
 * positional value (both MediaWiki behaviours).
 */
function effectiveParams(template: Template): HashMap.HashMap<string, Param> {
  const [, entries] = Arr.mapAccum(template.params, 0, (positional, p) => {
    const name = paramName(p);
    return name === null
      ? [positional + 1, [String(positional + 1), p] as const]
      : [positional, [name, p] as const];
  });
  return HashMap.fromIterable(entries);
}

/**
 * Builds the effective `name → trimmed value` `HashMap` for a template, assigning
 * 1-based indices to positional parameters and letting later duplicates win
 * (both MediaWiki behaviours). Named and positional keys share the space, so
 * an explicit `1=` overrides the first positional value.
 */
export function templateParams(template: Template): HashMap.HashMap<string, string> {
  return HashMap.map(effectiveParams(template), (p) => paramValue(p));
}

/**
 * Reads one template parameter by name or 1-based positional index, trimmed.
 * Returns `undefined` when absent.
 */
export function getParam(template: Template, key: string | number): string | undefined {
  return Option.getOrUndefined(HashMap.get(templateParams(template), String(key)));
}

// ── strip to plain text ───────────────────────────────────────────────

/** Extension tags whose raw body is kept as literal prose when stripping. */
const STRIP_KEEP_RAW = HashSet.make("nowiki", "pre", "poem", "syntaxhighlight", "source");

// MediaWiki's `Sanitizer::MW_ENTITY_ALIASES`: two names outside HTML5 that it
// reads as `&rlm;` (U+200F RIGHT-TO-LEFT MARK), spelt in Hebrew letters
// (resh, lamed, mem) and in Arabic letters (reh, lam, meem).
const MW_ENTITY_ALIASES = HashMap.make(
  ["\u05e8\u05dc\u05de", "rlm"],
  ["\u0631\u0644\u0645", "rlm"],
);

const NUMERIC_ENTITY_RE = /^#(?:[xX]([0-9A-Fa-f]+)|([0-9]+))$/;

// MediaWiki's `Sanitizer::validateCodepoint`: the code points a numeric
// reference may name and still render as a character. MediaWiki escapes any
// other reference (NUL and the C0/C1 controls but tab and newline, a
// surrogate, U+FFFE/U+FFFF, anything past U+10FFFF), so the reader sees it as
// literal text.
function isRenderableCodePoint(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x0a ||
    (code >= 0x20 && code <= 0x7e) ||
    (code >= 0xa0 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

// Decodes one entity as a reader sees it, as `Sanitizer::normalizeEntity`
// and its numeric siblings do. A name that is neither an HTML5 entity nor one
// of MediaWiki's aliases, and a reference to a code point
// `isRenderableCodePoint` rejects, render as literal text, so they stay as
// written.
function decodeEntity(raw: string): string {
  const body = raw.slice(1, -1); // strip & and ;
  const numeric = NUMERIC_ENTITY_RE.exec(body);
  if (numeric === null) {
    const name = Option.getOrElse(HashMap.get(MW_ENTITY_ALIASES, body), () => body);
    return Option.getOrElse(HashMap.get(NAMED_ENTITIES, name), () => raw);
  }
  const [, hex, dec] = numeric;
  const code = hex === undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
  return isRenderableCodePoint(code) ? String.fromCodePoint(code) : raw;
}

const NAMESPACE_LINK_RE = /^\s*:?\s*(file|image|category)\s*:/i;

/**
 * What a {@link TemplateRenderer} gets besides the template: the projection
 * {@link stripToText} is running, so a renderer can strip a parameter, or any
 * other fragment, with the same renderers and fallback.
 */
export interface TemplateRenderContext {
  /**
   * Strips a fragment or node to plain text with the options of the
   * {@link stripToText} call that invoked the renderer, so templates nested
   * in it are rendered too. Calling it on the template being rendered
   * recurses without end.
   */
  readonly strip: (input: Fragment | Node) => string;
  /**
   * The plain text of the template's parameter `key` (a name, or a 1-based
   * positional index), stripped with {@link TemplateRenderContext.strip};
   * `undefined` when the template has no such parameter. Keys resolve as in
   * {@link templateParams}: later duplicates win, and `1=` overrides the
   * first positional value. As in MediaWiki, a named value is trimmed and a
   * positional one keeps its whitespace.
   */
  readonly param: (key: string | number) => string | undefined;
}

/**
 * Renders one {@link Template} to the plain text {@link stripToText} puts in
 * its place. It must be pure and synchronous, and it sees only the parsed
 * invocation: nothing expands the template's source.
 */
export type TemplateRenderer = (template: Template, context: TemplateRenderContext) => string;

/** Options for {@link stripToText}: which templates render to text, and how. */
export interface StripToTextOptions {
  /**
   * Renderers keyed by template name. Keys and invocation names are both
   * compared via {@link normaliseTemplateName}, so `nowrap`, `Nowrap` and
   * `Nowrap_` name the same template; when two keys normalise alike the later
   * one wins. A `Template:` prefix in the invocation is not removed, and a
   * parser function's name includes its argument (`#if:x`), so neither
   * matches a bare key. {@link basicTemplateRenderers} is a starting set to
   * spread into it.
   */
  readonly templates?: Readonly<Record<string, TemplateRenderer>> | undefined;
  /**
   * Renders a template that `templates` has no entry for. Defaults to
   * rendering it as `""`.
   */
  readonly templateFallback?: TemplateRenderer | undefined;
}

/** Renders a template as its first positional parameter, or `""` without one. */
const firstParam: TemplateRenderer = (_, { param }) => param(1) ?? "";

/**
 * A small set of {@link TemplateRenderer}s for enwiki's purely textual
 * templates, which show one of their parameters and need no data:
 * `nowrap`, `small` and `abbr` (`{{abbr|NASA|National …}}` → `"NASA"`) render
 * their first positional parameter, and `lang` (`{{lang|fr|texte}}` →
 * `"texte"`) its second. A missing parameter renders as `""`. Nothing in
 * {@link stripToText} uses it unless passed in
 * {@link StripToTextOptions.templates}; spread it to add your own renderers.
 */
export const basicTemplateRenderers = {
  /** `{{nowrap|text}}` (text kept on one line) renders as `text`. */
  nowrap: firstParam,
  /** `{{small|text}}` (text in a smaller font) renders as `text`. */
  small: firstParam,
  /** `{{abbr|short|expansion}}` (an abbreviation with a tooltip) renders as `short`. */
  abbr: firstParam,
  /** `{{lang|code|text}}` (text tagged with a language code) renders as `text`. */
  lang: (_, { param }) => param(2) ?? "",
} as const satisfies Readonly<Record<string, TemplateRenderer>>;

/**
 * Projects `input` to plain text — approximately what a reader sees with all
 * markup removed. Templates and template arguments strip to nothing (they
 * are never expanded — an explicit non-goal), reference/citation tags are
 * dropped, wikilinks reduce to their label, and entities are decoded.
 * Every entity MediaWiki renders as a character decodes: each HTML5 named
 * entity with its `;` (`&eacute;`, `&AMP;`; names are case-sensitive, and a
 * few stand for two code points), MediaWiki's aliases for `&rlm;`, and every
 * decimal or hex reference to a code point it accepts. An entity MediaWiki
 * shows as literal text stays as written: an unknown name, or a reference to
 * a control character other than tab and newline (NUL and DEL included), a
 * surrogate, U+FFFE, U+FFFF or a code point past U+10FFFF.
 *
 * `options` registers {@link TemplateRenderer}s that put text in place of
 * the templates they name ({@link StripToTextOptions.templates}), and a
 * fallback for every other template
 * ({@link StripToTextOptions.templateFallback}); without them every template
 * strips to `""`. Only the registered renderers run: the result stays pure
 * and synchronous, and no template's source is expanded.
 *
 * ```ts
 * stripToText(parse("a {{nowrap|37 ft}} wall"));                                     // "a  wall"
 * stripToText(parse("a {{nowrap|37 ft}} wall"), { templates: basicTemplateRenderers }); // "a 37 ft wall"
 * ```
 *
 * This is a best-effort prose extraction, **not** a MediaWiki renderer: text
 * produced by template expansion is absent unless a renderer supplies it, so
 * it matches an Action API `extract` only on prose whose templates it can
 * render. Whitespace is left as-is for the caller to normalise.
 */
export function stripToText(input: Fragment | Node, options?: StripToTextOptions): string {
  const strip = options === undefined ? stripDefault : makeStrip(options);
  return strip(input);
}

/** Strips one input with a node projection: a fragment, document or node. */
type Strip = (input: Fragment | Node) => string;

const renderNothing: TemplateRenderer = () => "";

/** The projection with every template rendered by `renderTemplate`. */
function makeStripper(renderTemplate: (template: Template, strip: Strip) => string): Strip {
  const stripNodes = (nodes: readonly Node[]): string => nodes.map(stripNode).join("");
  const strip: Strip = (input) => {
    if (isNodeArray(input)) return stripNodes(input);
    return Predicate.isTagged(input, "Document") ? stripNodes(input.children) : stripNode(input);
  };
  const stripNode: (node: Node) => string = Match.type<Node>().pipe(
    Match.tagsExhaustive({
      Text: (node) => node.text,
      HtmlEntity: (node) => decodeEntity(node.raw),
      Heading: (node) => stripNodes(node.title),
      Formatting: () => "",
      Comment: () => "",
      Template: (node) => renderTemplate(node, strip),
      Argument: () => "",
      Wikilink: (node) => {
        if (NAMESPACE_LINK_RE.test(serializeNodes(node.target))) return "";
        return Arr.match(node.segments, {
          onEmpty: () => stripNodes(node.target),
          onNonEmpty: (segments) => segments.map(stripNodes).join("|"),
        });
      },
      ExternalLink: (node) => (node.label === undefined ? "" : stripNodes(node.label).trim()),
      AutoLink: (node) => node.url,
      Tag: (node) => {
        if (node.name === "br") return "\n";
        if (node.rawContent !== undefined && HashSet.has(STRIP_KEEP_RAW, node.name)) {
          return node.rawContent;
        }
        return "";
      },
      Table: (node) => {
        const caption = node.captions.map((c) => stripNodes(c.content)).join(" ");
        const body = node.rows
          .map((r) => r.cells.map((c) => stripNodes(c.content)).join(" "))
          .join("\n");
        return Str.isNonEmpty(caption) ? `${caption}\n${body}` : body;
      },
    }),
  );
  return strip;
}

/** The projection with no renderers: every template strips to `""`. */
const stripDefault = makeStripper(() => "");

/** The renderer context for one template, under the projection `strip`. */
function renderContext(template: Template, strip: Strip): TemplateRenderContext {
  const param = (key: string | number): string | undefined =>
    Option.getOrUndefined(
      Option.map(HashMap.get(effectiveParams(template), String(key)), (p) =>
        p.name === undefined ? strip(p.value) : strip(p.value).trim(),
      ),
    );
  return { strip, param };
}

/** The projection that renders templates as `options` registers them. */
function makeStrip(options: StripToTextOptions): Strip {
  const renderers = HashMap.fromIterable(
    Arr.map(Rec.toEntries(options.templates ?? {}), ([name, render]) => [
      normaliseTemplateName(name),
      render,
    ]),
  );
  const fallback = options.templateFallback ?? renderNothing;
  return makeStripper((template, strip) => {
    const render = Option.getOrElse(
      HashMap.get(renderers, normaliseTemplateName(templateName(template))),
      () => fallback,
    );
    return render(template, renderContext(template, strip));
  });
}
