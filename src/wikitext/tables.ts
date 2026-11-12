/**
 * The table views over a parsed {@link Table} (#209): the grid with
 * `rowspan` / `colspan` expanded, and the rows as records keyed by the
 * header row. A projection, not a change to the tree: every slot and value
 * is the table's own {@link TableCell}.
 *
 * @copyright Thomas Foster
 * @module wikitext/tables
 */

import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Str from "effect/String";
import type { Table, TableCell } from "./ast.ts";
import { type StripToTextOptions, stripToText } from "./query.ts";

/** One slot of a {@link tableGrid}: the cell that covers it, and where. */
export interface GridCell {
  /** The table's own cell covering the slot (for a spanned slot, the cell the span starts at). */
  readonly cell: TableCell;
  /** The slot's row, 0-based, counting every row of the table. */
  readonly row: number;
  /** The slot's column, 0-based, after the spans of earlier rows and cells are laid out. */
  readonly column: number;
  /** Whether this is the slot the cell starts at, rather than one its `rowspan` / `colspan` covers. */
  readonly origin: boolean;
}

/** One row of a table as a record: its values keyed by the header row, and its own header cell. */
export interface TableRecord {
  /**
   * The row's slots by column key: the header row's text for that column
   * (its {@link stripToText}, trimmed), or the 1-based column number where
   * that text is empty or there is no header row. When two columns share a
   * key the later one wins. Spanned slots repeat their cell, so a value a
   * `rowspan` carries down appears in each row it covers.
   */
  readonly fields: HashMap.HashMap<string, TableCell>;
  /**
   * The row's own key: its first slot's cell when that is a header (`!`)
   * cell, as in a table whose rows each start with a `!` label; `None` when
   * the row starts with a data cell.
   */
  readonly rowHeader: Option.Option<TableCell>;
}

/** A grid slot's key in the layout map. */
const key = (row: number, column: number): string => `${row}:${column}`;

/** HTML's bounds on a span, which MediaWiki's sanitiser leaves to the browser. */
const MAX_COLSPAN = 1000;
const MAX_ROWSPAN = 65_534;

/** A span attribute's value in `attrs` (its leading digits, as MediaWiki reads it), or `None`. */
function spanAttribute(
  attrs: Option.Option<string>,
  name: "rowspan" | "colspan",
): Option.Option<number> {
  return Option.flatMap(attrs, (text) => {
    const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']?\\s*(\\d+)`, "i").exec(text);
    return Option.map(Option.fromUndefinedOr(match?.[1]), (digits) => Number.parseInt(digits, 10));
  });
}

/**
 * Lays out `table`'s cells on a grid, expanding each `rowspan` and
 * `colspan` (from the cell's attributes) as a browser does: a cell takes the
 * first column its row leaves free after the spans from rows above, a
 * `colspan` is clamped to 1–1000 and a `rowspan` to 1–65534, and a
 * `rowspan="0"` runs to the table's last row. Each grid row lists its
 * slots in column order; a row shorter than others simply has fewer, and a
 * span reaching past the last row is cut there. Pure and total.
 */
export function tableGrid(table: Table): readonly (readonly GridCell[])[] {
  const rows = table.rows.length;
  const slots = MutableHashMap.empty<string, GridCell>();
  const freeFrom = (row: number, column: number): number =>
    MutableHashMap.has(slots, key(row, column)) ? freeFrom(row, column + 1) : column;
  Arr.forEach(table.rows, (tableRow, row) => {
    Arr.reduce(tableRow.cells, 0, (next, cell) => {
      const column = freeFrom(row, next);
      const colspan = Math.min(
        Math.max(
          Option.getOrElse(spanAttribute(cell.attrs, "colspan"), () => 1),
          1,
        ),
        MAX_COLSPAN,
      );
      const asked = Option.getOrElse(spanAttribute(cell.attrs, "rowspan"), () => 1);
      const rowspan = Math.min(asked === 0 ? rows - row : Math.min(asked, MAX_ROWSPAN), rows - row);
      Arr.forEach(Arr.range(0, Math.max(rowspan, 1) - 1), (dr) =>
        Arr.forEach(Arr.range(0, colspan - 1), (dc) => {
          const at = key(row + dr, column + dc);
          if (MutableHashMap.has(slots, at)) return;
          MutableHashMap.set(slots, at, {
            cell,
            row: row + dr,
            column: column + dc,
            origin: dr === 0 && dc === 0,
          });
        }),
      );
      return column + colspan;
    });
  });
  const all = Arr.fromIterable(MutableHashMap.values(slots));
  if (rows === 0) return [];
  return Arr.makeBy(rows, (row) =>
    Arr.sort(
      Arr.filter(all, (slot) => slot.row === row),
      byColumn,
    ),
  );
}

const byColumn: Order.Order<GridCell> = Order.mapInput(
  Order.Number,
  (slot: GridCell) => slot.column,
);

/** A header cell's text as a key: its plain text, trimmed, or the 1-based column number when that is empty. */
const columnKey = (slot: GridCell, options?: StripToTextOptions): string => {
  const text = stripToText(slot.cell.content, options).trim();
  return Str.isEmpty(text) ? String(slot.column + 1) : text;
};

/**
 * Reads `table`'s rows as records over its {@link tableGrid}: the first
 * row whose slots are all header (`!`) cells gives the column keys, and
 * each row after it is one {@link TableRecord} (each row, when there is no
 * such header row, keyed by column number). A row's leading `!` cell, as in
 * a table whose rows each start with a label, is also its
 * {@link TableRecord.rowHeader}. Values are the table's own cells, so a
 * caller keeps the fragment (`stripToText(cell.content)`, links and all).
 * `options` are the {@link stripToText} options the header text is read
 * with. Pure and total.
 */
export function tableRecords(table: Table, options?: StripToTextOptions): readonly TableRecord[] {
  const grid = tableGrid(table);
  const headerAt = Arr.findFirstIndex(
    grid,
    (row) => Arr.isReadonlyArrayNonEmpty(row) && Arr.every(row, (slot) => slot.cell.header),
  );
  const keys = Option.match(headerAt, {
    onNone: () => HashMap.empty<number, string>(),
    onSome: (at) =>
      HashMap.fromIterable(
        Arr.map(grid[at] ?? [], (slot) => [slot.column, columnKey(slot, options)] as const),
      ),
  });
  const body = Option.match(headerAt, { onNone: () => grid, onSome: (at) => grid.slice(at + 1) });
  return Arr.map(body, (row) => ({
    fields: HashMap.fromIterable(
      Arr.map(
        row,
        (slot) =>
          [
            Option.getOrElse(HashMap.get(keys, slot.column), () => String(slot.column + 1)),
            slot.cell,
          ] as const,
      ),
    ),
    rowHeader: Option.filter(
      Option.map(Arr.head(row), (slot) => slot.cell),
      (cell) => cell.header,
    ),
  }));
}
