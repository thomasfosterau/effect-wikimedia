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
import type { Document, Node, Param, TableCaption, TableCell, TableRow } from "./ast.ts";

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
      `{{{${serializeNodes(node.name)}${
        node.default === undefined ? "" : `|${serializeNodes(node.default)}`
      }}}}`,
    Wikilink: (node) =>
      `[[${serializeNodes(node.target)}${node.segments
        .map((seg) => `|${serializeNodes(seg)}`)
        .join("")}]]`,
    ExternalLink: (node) =>
      `[${node.url}${node.label === undefined ? "" : serializeNodes(node.label)}]`,
    AutoLink: (node) => node.url,
    // A marker tag is just its verbatim text; an extension tag adds its
    // captured raw body and closing tag (both absent when open-only).
    Tag: (node) => node.raw + (node.rawContent ?? "") + (node.closeRaw ?? ""),
    Table: (node) =>
      `{|${node.open}${node.captions.map(serializeCaption).join("")}${node.rows
        .map(serializeRow)
        .join("")}|}`,
  }),
);

function serializeCaption(caption: TableCaption): string {
  const marker = caption.inline ? "||" : "|+";
  return `${marker}${caption.attrs === undefined ? "" : `${caption.attrs}|`}${serializeNodes(caption.content)}`;
}

function serializeRow(row: TableRow): string {
  const marker = row.open === undefined ? "" : `|-${row.open}`;
  return marker + row.cells.map(serializeCell).join("");
}

function serializeCell(cell: TableCell): string {
  const attrs = cell.attrs === undefined ? "" : `${cell.attrs}|`;
  return cell.marker + attrs + serializeNodes(cell.content);
}

/** Serializes a document (its top-level fragment). */
export function serialize(doc: Document): string {
  return serializeNodes(doc.children);
}

function serializeParams(params: readonly Param[]): string {
  return params
    .map(
      (p) =>
        `|${p.name === undefined ? "" : `${serializeNodes(p.name)}=`}${serializeNodes(p.value)}`,
    )
    .join("");
}
