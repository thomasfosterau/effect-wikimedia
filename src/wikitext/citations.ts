/**
 * The citation view over a parsed {@link Document} (#209): every `<ref>`
 * with its `name` and `group`, its body parsed as wikitext with spans in the
 * page (so a splice edit there needs no arithmetic), and the citation
 * templates in it. A projection, not a change to the tree: each
 * {@link Citation} holds the document's own {@link Tag}.
 *
 * @copyright Thomas Foster
 * @module wikitext/citations
 */

import * as Arr from "effect/Array";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Str from "effect/String";
import type { Document, Node, Tag, Template } from "./ast.ts";
import { parse } from "./parse.ts";
import { filter, findTemplates, normaliseTemplateName, templateName } from "./query.ts";

/** One `<ref>`: its identity, its parsed body and the citation templates in it. */
export interface Citation {
  /** The document's own `<ref>` tag node (never a copy). */
  readonly ref: Tag;
  /** The `name` attribute, trimmed; `None` when absent or empty. */
  readonly name: Option.Option<string>;
  /** The `group` attribute, trimmed; `None` when absent or empty. */
  readonly group: Option.Option<string>;
  /**
   * Whether this `<ref>` reuses a named citation rather than defining one:
   * it has a `name` and no body, as `<ref name="a" />` or `<ref name="a"></ref>`.
   */
  readonly reuse: boolean;
  /**
   * For a reuse, the index in the {@link citations} result of the first
   * citation that defines the same `name` in the same `group`; `None` for a
   * definition, or a reuse with no definition in the document (one a
   * template supplies, or a dangling name).
   */
  readonly definition: Option.Option<number>;
  /**
   * The body parsed as wikitext, with spans in the page's own source (the
   * body's offset passed to {@link parse}); `None` for a body-less `<ref>`.
   */
  readonly body: Option.Option<Document>;
  /**
   * The citation templates in {@link body}, in document order, nested ones
   * included: a template whose normalised name is `Citation` or starts with
   * `Cite ` (`{{cite web}}`, `{{Cite book}}`), or is one of
   * {@link CitationsOptions.names}. Their spans are in the page's source too.
   */
  readonly templates: readonly Template[];
}

/** Options for {@link citations}. */
export interface CitationsOptions {
  /**
   * More template names to count as citation templates, such as `Harvnb` or
   * a wiki's localised `Literatur`, compared by {@link normaliseTemplateName}.
   * Defaults to none.
   */
  readonly names?: Iterable<string> | undefined;
}

/** An attribute's value in a tag's raw text, quoted or bare, trimmed; `None` when absent or empty. */
function attribute(raw: string, key: "name" | "group"): Option.Option<string> {
  const match = new RegExp(`\\s${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s/>]+))`, "i").exec(raw);
  return Option.filter(
    Option.map(Option.fromNullOr(match), (m) => (m[1] ?? m[2] ?? m[3] ?? "").trim()),
    Str.isNonEmpty,
  );
}

const isRef = (node: Node): node is Tag =>
  P.isTagged(node, "Tag") && node.name === "ref" && !node.closing;

const isCitationTemplate =
  (extra: HashSet.HashSet<string>) =>
  (template: Template): boolean => {
    const name = normaliseTemplateName(templateName(template));
    return name === "Citation" || name.startsWith("Cite ") || HashSet.has(extra, name);
  };

/**
 * Finds every `<ref>` in `doc`, at any depth (one inside a template's
 * parameter included), in document order, as a {@link Citation}. A body is
 * parsed with {@link parse}'s `offset`, so its nodes' spans index
 * `doc.source` exactly as the document's own do. A reuse is linked to the
 * first definition of its `name` in its `group` through
 * {@link Citation.definition}. Pure and total.
 */
export function citations(doc: Document, options?: CitationsOptions): readonly Citation[] {
  const extra = HashSet.fromIterable(
    Arr.map(Arr.fromIterable(options?.names ?? []), normaliseTemplateName),
  );
  const isCite = isCitationTemplate(extra);
  const refs = Arr.filter(filter(doc, isRef), isRef);
  const parsed = Arr.map(refs, (ref) => {
    const name = attribute(ref.raw, "name");
    const group = attribute(ref.raw, "group");
    const body = Option.map(
      Option.filter(ref.rawContent, (content) => Str.isNonEmpty(content.trim())),
      (content) => parse(content, { offset: ref.span.start + ref.raw.length }),
    );
    return { ref, name, group, body, reuse: Option.isSome(name) && Option.isNone(body) };
  });
  const keyOf = (c: (typeof parsed)[number]): string =>
    `${Option.getOrElse(c.group, () => "")}\u0000${Option.getOrElse(c.name, () => "")}`;
  return Arr.map(parsed, (c) => ({
    ...c,
    definition: c.reuse
      ? Arr.findFirstIndex(
          parsed,
          (d) => !d.reuse && Option.isSome(d.name) && keyOf(d) === keyOf(c),
        )
      : Option.none(),
    templates: Option.match(c.body, {
      onNone: () => [],
      onSome: (body) => Arr.filter(findTemplates(body), isCite),
    }),
  }));
}
