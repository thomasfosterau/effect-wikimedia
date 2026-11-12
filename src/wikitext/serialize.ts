/**
 * AST → wikitext serializer — the exact inverse of `./parse.ts`.
 *
 * The round-trip contract (website#1065): for an unmodified tree,
 * `serialize(parse(source)) === source`, byte-for-byte. This holds by
 * construction — every node reproduces its literal delimiters verbatim and
 * its child fragments tile the inner range exactly (see the invariants in
 * `./ast.ts`) — and is checked span-by-span across the
 * corpus in the tests. Because serialization reconstructs from node fields
 * rather than replaying the source slice, edits to a node (renamed
 * template, changed parameter value) serialize to the *new* text while
 * their unmodified siblings stay byte-identical.
 *
 * @copyright Thomas Foster
 * @module wikitext/serialize
 */

import * as Match from "effect/Match";
import * as Option from "effect/Option";
import type { Document, Node, Param, Table, TableCaption, TableCell, TableRow } from "./ast.ts";

/** Serializes a fragment (a list of nodes) back to wikitext. */
export function serializeNodes(nodes: readonly Node[]): string {
  return nodes.map(serializeNode).join("");
}

/** Serializes a single node back to wikitext. */
export function serializeNode(node: Node): string {
  return serializeByTag(node);
}

const serializeByTag: (node: Node) => string = Match.type<Node>().pipe(
  Match.tagsExhaustive({
    Text: (node) => node.text,
    Comment: (node) => `<!--${node.text}${node.closed ? "-->" : ""}`,
    HtmlEntity: (node) => node.raw,
    Formatting: (node) => node.marks,
    Heading: (node) =>
      node.leftEquals + serializeNodes(node.title) + node.rightEquals + node.trailing,
    Template: (node) => `{{${serializeNodes(node.name)}${serializeParams(node.params)}}}`,
    Argument: (node) =>
      `{{{${serializeNodes(node.name)}${Option.match(node.default, {
        onNone: () => "",
        onSome: (d) => `|${serializeNodes(d)}`,
      })}}}}`,
    Wikilink: (node) =>
      `[[${serializeNodes(node.target)}${node.segments
        .map((seg) => `|${serializeNodes(seg)}`)
        .join("")}]]`,
    ExternalLink: (node) =>
      `[${node.url}${Option.match(node.label, { onNone: () => "", onSome: serializeNodes })}]`,
    AutoLink: (node) => node.url,
    // A marker tag is just its verbatim text; an extension tag adds its
    // captured raw body and closing tag (both absent when open-only).
    Tag: (node) =>
      node.raw +
      Option.getOrElse(node.rawContent, () => "") +
      Option.getOrElse(node.closeRaw, () => ""),
    Table: (node) => `{|${node.open}${serializeTableBody(node)}|}`,
  }),
);

/**
 * A table's captions and rows, each caption written just before the row it
 * precedes ({@link TableCaption.row}, read as `0` below zero and as after the
 * last row past it), in {@link Table.captions} order.
 */
function serializeTableBody(table: Table): string {
  const last = table.rows.length;
  const at = (caption: TableCaption): number => Math.min(Math.max(caption.row, 0), last);
  const captionsAt = (index: number): string =>
    table.captions
      .filter((caption) => at(caption) === index)
      .map(serializeCaption)
      .join("");
  return (
    table.rows.map((row, index) => captionsAt(index) + serializeRow(row)).join("") +
    captionsAt(last)
  );
}

function serializeCaption(caption: TableCaption): string {
  const marker = caption.inline ? "||" : "|+";
  return `${marker}${attrsPrefix(caption.attrs)}${serializeNodes(caption.content)}`;
}

function serializeRow(row: TableRow): string {
  const marker = Option.match(row.open, { onNone: () => "", onSome: (open) => `|-${open}` });
  return marker + row.cells.map(serializeCell).join("");
}

function serializeCell(cell: TableCell): string {
  return cell.marker + attrsPrefix(cell.attrs) + serializeNodes(cell.content);
}

/** A cell's or caption's attributes and their `|` separator, or `""` without attributes. */
const attrsPrefix = (attrs: Option.Option<string>): string =>
  Option.match(attrs, { onNone: () => "", onSome: (text) => `${text}|` });

/** Serializes a document (its top-level fragment). */
export function serialize(doc: Document): string {
  return serializeNodes(doc.children);
}

function serializeParams(params: readonly Param[]): string {
  return params
    .map(
      (p) =>
        `|${Option.match(p.name, { onNone: () => "", onSome: (name) => `${serializeNodes(name)}=` })}${serializeNodes(p.value)}`,
    )
    .join("");
}
