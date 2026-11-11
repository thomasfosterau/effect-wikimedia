/**
 * The table views (#209): `tableGrid` with rowspan / colspan expanded, and
 * `tableRecords` keyed by the first all-header row and each row's own `!`
 * label.
 *
 * @module tests/tables
 */

import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import { describe, expect, it } from "vite-plus/test";
import {
  type GridCell,
  type Node,
  parse,
  stripToText,
  type Table,
  type TableCell,
  tableGrid,
  tableRecords,
} from "../src/wikitext/index.ts";

/** The value of `option`, failing the test when it is `None`. */
const some = <A>(option: Option.Option<A>, what: string): A =>
  Option.match(option, { onNone: () => expect.unreachable(`no ${what}`), onSome: (a) => a });

const isTable = (node: Node): node is Table => P.isTagged(node, "Table");
const tableOf = (source: string): Table =>
  some(Arr.findFirst(parse(source).children, isTable), "table");

const text = (cell: TableCell): string => stripToText(cell.content).trim();
/** Each grid row as its slots' text, a spanned slot marked with `^`. */
const layout = (grid: readonly (readonly GridCell[])[]): string[][] =>
  grid.map((row) => row.map((slot) => (slot.origin ? text(slot.cell) : `^${text(slot.cell)}`)));
/** A record's fields as plain text. */
const fieldsText = (fields: HashMap.HashMap<string, TableCell>): R.ReadonlyRecord<string, string> =>
  R.fromEntries(
    Arr.map(Arr.fromIterable(HashMap.entries(fields)), ([k, v]) => [k, text(v)] as const),
  );

describe("tableGrid", () => {
  it("lays out rowspans and colspans as a browser does", () => {
    const table = tableOf(
      '{|\n| rowspan="2" | A || B || C\n|-\n| colspan=2 | D\n|-\n| E || F || G\n|}',
    );
    expect(layout(tableGrid(table))).toEqual([
      ["A", "B", "C"],
      ["^A", "D", "^D"],
      ["E", "F", "G"],
    ]);
    const [first] = tableGrid(table);
    expect(first?.[0]?.cell).toBe(table.rows[0]?.cells[0]);
    expect(tableGrid(table)[1]?.map((slot) => slot.column)).toEqual([0, 1, 2]);
  });

  it("runs rowspan=0 to the last row, cuts a span past it, and clamps colspan", () => {
    const table = tableOf("{|\n| rowspan=0 | A || B\n|-\n| C\n|-\n| rowspan=9 | D\n|}");
    expect(layout(tableGrid(table))).toEqual([
      ["A", "B"],
      ["^A", "C"],
      ["^A", "D"],
    ]);
    const wide = tableGrid(tableOf('{|\n| colspan="5000" | W\n|}'));
    expect(wide[0]).toHaveLength(1000);
  });

  it("reads a span attribute among others, and ignores one that isn't a number", () => {
    const table = tableOf(
      '{|\n| style="x" ROWSPAN = "2" class=y | A || colspan=wide | B\n|-\n| C\n|}',
    );
    expect(layout(tableGrid(table))).toEqual([
      ["A", "B"],
      ["^A", "C"],
    ]);
  });

  it("gives nothing for a table without rows", () => {
    expect(tableGrid(tableOf("{|\n|}"))).toEqual([]);
  });
});

describe("tableRecords", () => {
  it("keys each row by the first all-header row, carrying rowspans down", () => {
    const table = tableOf(
      "{|\n! Name !! [[Country]] !! \n|-\n| rowspan=2 | Ada || UK || 1815\n|-\n| [[France]] || 1900\n|}",
    );
    const records = tableRecords(table);
    expect(records.map((r) => fieldsText(r.fields))).toEqual([
      { Name: "Ada", Country: "UK", "3": "1815" },
      { Name: "Ada", Country: "France", "3": "1900" },
    ]);
    expect(records.map((r) => Option.isNone(r.rowHeader))).toEqual([true, true]);
  });

  it("takes each row's leading ! cell as its row header", () => {
    const table = tableOf(
      "{|\n! !! 2020 !! 2021\n|-\n! Apples\n| 3 || 4\n|-\n! Pears\n| 5 || 6\n|}",
    );
    const records = tableRecords(table);
    expect(records.map((r) => Option.map(r.rowHeader, text))).toEqual([
      Option.some("Apples"),
      Option.some("Pears"),
    ]);
    expect(fieldsText(records[0]?.fields ?? HashMap.empty())).toEqual({
      "1": "Apples",
      "2020": "3",
      "2021": "4",
    });
  });

  it("keys every row by column number when there is no header row", () => {
    const records = tableRecords(tableOf("{|\n| a || b\n|-\n| c || d\n|}"));
    expect(records.map((r) => fieldsText(r.fields))).toEqual([
      { "1": "a", "2": "b" },
      { "1": "c", "2": "d" },
    ]);
  });
});
