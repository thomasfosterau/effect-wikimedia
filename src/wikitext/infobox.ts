/**
 * The infobox view over parsed wikitext (#209): each infobox template with
 * its fields as fragments, so a value keeps its links and templates as well
 * as its text. A projection, not a change to the tree: every
 * {@link Infobox} holds the document's own {@link Template} and
 * {@link Param} nodes, so an edit still goes through the tree and
 * {@link serialize}.
 *
 * @copyright Thomas Foster
 * @module wikitext/infobox
 */

import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import type { Node, Param, Template, Text } from "./ast.ts";
import {
  effectiveParams,
  type Fragment,
  findTemplates,
  normaliseTemplateName,
  type StripToTextOptions,
  stripToText,
  templateName,
} from "./query.ts";

/** One field of an {@link Infobox}: a template parameter, by its effective key. */
export interface InfoboxField {
  /**
   * The field's key, as {@link templateParams} keys it: the trimmed name of
   * a named parameter, or the 1-based index of a positional one.
   */
  readonly key: string;
  /** The template's own parameter node (never a copy). */
  readonly param: Param;
  /**
   * The parameter's value fragment with the whitespace at its edges
   * removed, as MediaWiki trims a named value: whitespace-only text at
   * either edge is dropped, and a text node that only starts or ends with
   * whitespace is replaced by a fresh text node holding the rest, with its
   * span narrowed to match. Every other node is the template's own. Empty
   * for an empty value.
   */
  readonly value: readonly Node[];
  /**
   * The value as plain text, trimmed: {@link stripToText} of {@link value},
   * with the options given to {@link infoboxes}.
   */
  readonly text: string;
}

/** One infobox: a template whose name marks it as one, with its fields. */
export interface Infobox {
  /** The document's own template node (never a copy). */
  readonly template: Template;
  /** The template's name, normalised by {@link normaliseTemplateName}, such as `Infobox person`. */
  readonly name: string;
  /**
   * What follows `Infobox` in {@link name}, trimmed (`person` for
   * `Infobox person`, `Ort` for `Infobox Ort`), with its case kept as
   * written. `None` for a bare `{{Infobox}}` and for a template matched only
   * through {@link InfoboxesOptions.names}.
   */
  readonly type: Option.Option<string>;
  /**
   * The fields by key. Positional parameters take 1-based keys and a later
   * duplicate replaces an earlier one, as in {@link templateParams}.
   */
  readonly fields: HashMap.HashMap<string, InfoboxField>;
}

/** Options for {@link infoboxes}: the extra names to treat as infoboxes, and the {@link stripToText} options for each field's text. */
export interface InfoboxesOptions extends StripToTextOptions {
  /**
   * More template names to treat as infoboxes besides those named
   * `Infobox` or `Infobox …`, such as `Taxobox`, `Speciesbox` or `Chembox`,
   * which differ from one wiki to the next. Compared by
   * {@link normaliseTemplateName}. Defaults to none.
   */
  readonly names?: Iterable<string> | undefined;
}

/** PHP's `trim` set, which MediaWiki trims a named parameter value with. */
const LEADING_WHITESPACE = /^[ \t\n\r\0\v]*/;
const TRAILING_WHITESPACE = /[ \t\n\r\0\v]*$/;

const leadingWhitespace = (text: string): number => LEADING_WHITESPACE.exec(text)?.[0].length ?? 0;
const trailingWhitespace = (text: string): number =>
  TRAILING_WHITESPACE.exec(text)?.[0].length ?? 0;

/** A text node narrowed by `start` code units at its start and `end` at its end; `None` when nothing is left. */
function narrow(node: Text, start: number, end: number): Option.Option<Node> {
  if (start + end >= node.text.length) return Option.none();
  if (start === 0 && end === 0) return Option.some(node);
  return Option.some({
    _tag: "Text",
    span: { start: node.span.start + start, end: node.span.end - end },
    text: node.text.slice(start, node.text.length - end),
  });
}

const isText = (node: Node): node is Text => Predicate.isTagged(node, "Text");

/** Drops the whitespace at the start of `nodes`, through whitespace-only text nodes. */
function trimStart(nodes: readonly Node[]): readonly Node[] {
  const first = Arr.findFirstIndex(
    nodes,
    (node) => !isText(node) || leadingWhitespace(node.text) < node.text.length,
  );
  return Option.match(first, {
    onNone: () => [],
    onSome: (at) => {
      const node = nodes[at];
      const rest = nodes.slice(at + 1);
      if (node === undefined || !isText(node)) return nodes.slice(at);
      return [...Option.toArray(narrow(node, leadingWhitespace(node.text), 0)), ...rest];
    },
  });
}

/** Drops the whitespace at the end of `nodes`, through whitespace-only text nodes. */
function trimEnd(nodes: readonly Node[]): readonly Node[] {
  const last = Arr.findLastIndex(
    nodes,
    (node) => !isText(node) || trailingWhitespace(node.text) < node.text.length,
  );
  return Option.match(last, {
    onNone: () => [],
    onSome: (at) => {
      const node = nodes[at];
      const before = nodes.slice(0, at);
      if (node === undefined || !isText(node)) return nodes.slice(0, at + 1);
      return [...before, ...Option.toArray(narrow(node, 0, trailingWhitespace(node.text)))];
    },
  });
}

const trimFragment = (nodes: readonly Node[]): readonly Node[] => trimEnd(trimStart(nodes));

/** What follows `Infobox` in a normalised name, or `None` when the name is not an infobox's. */
function infoboxSuffix(name: string): Option.Option<string> {
  if (name === "Infobox") return Option.some("");
  return name.startsWith("Infobox ")
    ? Option.some(name.slice("Infobox ".length).trim())
    : Option.none();
}

/**
 * Finds every infobox in `input`, in document order (a nested one after the
 * one that contains it): each {@link Template} whose name, normalised by
 * {@link normaliseTemplateName}, is `Infobox` or starts with `Infobox `, or
 * is one of `options.names`. Each comes with its fields as fragments, so a
 * value's links and templates survive (`filter(field.value, …)`), and as
 * trimmed text. A parser function (`{{#if: …}}`) is never one. Pure and
 * total.
 */
export function infoboxes(input: Fragment, options?: InfoboxesOptions): readonly Infobox[] {
  const extra = HashSet.fromIterable(
    Arr.map(Arr.fromIterable(options?.names ?? []), normaliseTemplateName),
  );
  return Arr.getSomes(
    Arr.map(findTemplates(input), (template) => {
      const name = normaliseTemplateName(templateName(template));
      const suffix = infoboxSuffix(name);
      if (Option.isNone(suffix) && !HashSet.has(extra, name)) return Option.none();
      const fields = HashMap.map(effectiveParams(template), (param, key) => {
        const value = trimFragment(param.value);
        return { key, param, value, text: stripToText(value, options).trim() };
      });
      return Option.some({
        template,
        name,
        type: Option.filter(suffix, Str.isNonEmpty),
        fields,
      });
    }),
  );
}
