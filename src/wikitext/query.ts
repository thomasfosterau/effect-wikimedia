/**
 * @copyright Thomas Foster
 *
 * The query / manipulation surface over a parsed {@link Document}: node
 * visitors and filters, template extraction (name + parameters), and a
 * strip-to-plain-text projection. All read-only and pure; edits are made by
 * rebuilding nodes and re-{@link module:lib/wikitext/serialize | serializing}.
 *
 * @module lib/wikitext/query
 */

import type { Document, Node, Param, Template } from "./ast";
import { serializeNodes } from "./serialize";

/** A fragment or a whole document — the common input to the query helpers. */
export type Fragment = Document | readonly Node[];

function nodesOf(input: Fragment): readonly Node[] {
  return Array.isArray(input) ? input : (input as Document).children;
}

/** The child fragments of a node (the places recursion descends into). */
function childFragments(node: Node): readonly (readonly Node[])[] {
  switch (node._tag) {
    case "Heading":
      return [node.title];
    case "Template":
      return [node.name, ...node.params.flatMap((p) => (p.name ? [p.name, p.value] : [p.value]))];
    case "Argument":
      return node.default === undefined ? [node.name] : [node.name, node.default];
    case "Wikilink":
      return [node.target, ...node.segments];
    case "ExternalLink":
      return node.label === undefined ? [] : [node.label];
    default:
      return [];
  }
}

/**
 * Depth-first pre-order walk over every node in `input`. Return `false` from
 * `visitor` to skip descending into a node's children.
 */
export function walk(input: Fragment, visitor: (node: Node) => boolean | void): void {
  const stack: (readonly Node[])[] = [nodesOf(input)];
  while (stack.length > 0) {
    const frag = stack.pop();
    if (!frag) continue;
    // Push children in reverse so the walk stays left-to-right pre-order.
    for (let i = frag.length - 1; i >= 0; i--) {
      const node = frag[i];
      const descend = visitor(node);
      if (descend !== false) {
        const kids = childFragments(node);
        for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]);
      }
    }
  }
}

/** Collects every node (at any depth) matching `predicate`, in document order. */
export function filter(input: Fragment, predicate: (node: Node) => boolean): Node[] {
  const out: Node[] = [];
  // A queue-based pre-order walk keeps document order without reversing.
  const walkFrag = (frag: readonly Node[]): void => {
    for (const node of frag) {
      if (predicate(node)) out.push(node);
      for (const kid of childFragments(node)) walkFrag(kid);
    }
  };
  walkFrag(nodesOf(input));
  return out;
}

// ── templates ─────────────────────────────────────────────────────────

/**
 * Normalises a template/page name the way MediaWiki does for comparison:
 * trims, converts underscores to spaces, collapses internal whitespace, and
 * upper-cases the first character (titles are first-letter-insensitive).
 */
export function normaliseTemplateName(raw: string): string {
  const collapsed = raw.replace(/_/g, " ").trim().replace(/\s+/g, " ");
  return collapsed.length === 0 ? collapsed : collapsed[0].toUpperCase() + collapsed.slice(1);
}

/** The template's invocation name as plain text (raw, un-normalised, trimmed). */
export function templateName(template: Template): string {
  return serializeNodes(template.name).trim();
}

/**
 * Finds every {@link Template} in `input`, optionally restricted to a name
 * (compared via {@link normaliseTemplateName}). Nested templates are
 * included.
 */
export function findTemplates(input: Fragment, name?: string): Template[] {
  const want = name === undefined ? undefined : normaliseTemplateName(name);
  const out: Template[] = [];
  walk(input, (node) => {
    if (
      node._tag === "Template" &&
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
 * Builds the effective `name → trimmed value` map for a template, assigning
 * 1-based indices to positional parameters and letting later duplicates win
 * (both MediaWiki behaviours). Named and positional keys share the space, so
 * an explicit `1=` overrides the first positional value.
 */
export function templateParams(template: Template): Map<string, string> {
  const out = new Map<string, string>();
  let positional = 0;
  for (const p of template.params) {
    const name = paramName(p);
    const key = name === null ? String(++positional) : name;
    out.set(key, paramValue(p));
  }
  return out;
}

/**
 * Reads one template parameter by name or 1-based positional index, trimmed.
 * Returns `undefined` when absent.
 */
export function getParam(template: Template, key: string | number): string | undefined {
  return templateParams(template).get(String(key));
}

// ── strip to plain text ───────────────────────────────────────────────

/** Extension tags whose raw body is kept as literal prose when stripping. */
const STRIP_KEEP_RAW: ReadonlySet<string> = new Set([
  "nowiki",
  "pre",
  "poem",
  "syntaxhighlight",
  "source",
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  times: "×",
  deg: "°",
};

// reason: named + numeric (decimal/hex) entity decode with range guards; CRAP is estimate-inflated because the audit runs without unit coverage — covered by query.test.ts.
// fallow-ignore-next-line complexity
function decodeEntity(raw: string): string {
  const body = raw.slice(1, -1); // strip & and ;
  if (body.charCodeAt(0) === 0x23) {
    // numeric
    const isHex = body.charCodeAt(1) === 0x78 || body.charCodeAt(1) === 0x58;
    const code = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
    if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
      try {
        return String.fromCodePoint(code);
      } catch {
        return raw;
      }
    }
    return raw;
  }
  return NAMED_ENTITIES[body] ?? raw;
}

const NAMESPACE_LINK_RE = /^\s*:?\s*(file|image|category)\s*:/i;

/**
 * Projects `input` to plain text — approximately what a reader sees with all
 * markup removed. Templates and template arguments strip to nothing (they
 * are never expanded — an explicit non-goal), reference/citation tags are
 * dropped, wikilinks reduce to their label, and entities are decoded.
 *
 * This is a best-effort prose extraction, **not** a MediaWiki renderer: text
 * produced by template expansion is necessarily absent, so it matches an
 * Action API `extract` only on template-free prose. Whitespace is left
 * as-is for the caller to normalise.
 */
export function stripToText(input: Fragment | Node): string {
  if (Array.isArray(input)) return stripNodes(input);
  const single = input as Document | Node;
  if (single._tag === "Document") return stripNodes(single.children);
  return stripNode(single);
}

function stripNodes(nodes: readonly Node[]): string {
  let out = "";
  for (const n of nodes) out += stripNode(n);
  return out;
}

// reason: per-node-type strip dispatch (a full node switch); CRAP is estimate-inflated because the audit runs without unit coverage — covered by query.test.ts.
// fallow-ignore-next-line complexity
function stripNode(node: Node): string {
  switch (node._tag) {
    case "Text":
      return node.text;
    case "HtmlEntity":
      return decodeEntity(node.raw);
    case "Heading":
      return stripNodes(node.title);
    case "Formatting":
    case "Comment":
    case "Template":
    case "Argument":
      return "";
    case "Wikilink": {
      if (NAMESPACE_LINK_RE.test(serializeNodes(node.target))) return "";
      if (node.segments.length > 0) return node.segments.map(stripNodes).join("|");
      return stripNodes(node.target);
    }
    case "ExternalLink":
      return node.label === undefined ? "" : stripNodes(node.label).trim();
    case "Tag": {
      if (node.name === "br") return "\n";
      if (node.rawContent !== undefined && STRIP_KEEP_RAW.has(node.name)) return node.rawContent;
      return "";
    }
  }
}
