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

import type { Document, Node, Param, TableCaption, TableCell, TableRow } from "./ast.ts";

/** Serializes a fragment (a list of nodes) back to wikitext. */
export function serializeNodes(nodes: readonly Node[]): string {
  let out = "";
  for (const node of nodes) out += serializeNode(node);
  return out;
}

/** Serializes a single node back to wikitext. */
export function serializeNode(node: Node): string {
  switch (node._tag) {
    case "Text":
      return node.text;
    case "Comment":
      return `<!--${node.text}${node.closed ? "-->" : ""}`;
    case "HtmlEntity":
      return node.raw;
    case "Formatting":
      return node.marks;
    case "Heading":
      return node.leftEquals + serializeNodes(node.title) + node.rightEquals + node.trailing;
    case "Template":
      return `{{${serializeNodes(node.name)}${serializeParams(node.params)}}}`;
    case "Argument":
      return `{{{${serializeNodes(node.name)}${
        node.default === undefined ? "" : `|${serializeNodes(node.default)}`
      }}}}`;
    case "Wikilink":
      return `[[${serializeNodes(node.target)}${node.segments
        .map((seg) => `|${serializeNodes(seg)}`)
        .join("")}]]`;
    case "ExternalLink":
      return `[${node.url}${node.label === undefined ? "" : serializeNodes(node.label)}]`;
    case "AutoLink":
      return node.url;
    case "Tag":
      // A marker tag is just its verbatim text; an extension tag adds its
      // captured raw body and closing tag (both absent when open-only).
      return node.raw + (node.rawContent ?? "") + (node.closeRaw ?? "");
    case "Table":
      return `{|${node.open}${node.captions.map(serializeCaption).join("")}${node.rows
        .map(serializeRow)
        .join("")}|}`;
  }
}

function serializeCaption(caption: TableCaption): string {
  return `|+${caption.attrs === undefined ? "" : `${caption.attrs}|`}${serializeNodes(caption.content)}`;
}

function serializeRow(row: TableRow): string {
  const marker = row.open === undefined ? "" : `|-${row.open}`;
  return marker + row.cells.map(serializeCell).join("");
}

function serializeCell(cell: TableCell): string {
  const marker = cell.inline ? (cell.header ? "!!" : "||") : cell.header ? "!" : "|";
  const attrs = cell.attrs === undefined ? "" : `${cell.attrs}|`;
  return marker + attrs + serializeNodes(cell.content);
}

/** Serializes a document (its top-level fragment). */
export function serialize(doc: Document): string {
  return serializeNodes(doc.children);
}

function serializeParams(params: readonly Param[]): string {
  let out = "";
  for (const p of params) {
    out += "|";
    if (p.name !== undefined) out += `${serializeNodes(p.name)}=`;
    out += serializeNodes(p.value);
  }
  return out;
}
