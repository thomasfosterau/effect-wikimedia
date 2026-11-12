/**
 * `Core.lenient`, `Core.lenientField` and `Core.lenientArray` (#224): a
 * malformed leaf in a response degrades to absent instead of failing the
 * whole decode.
 *
 * @module tests/lenient
 */

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { Core } from "../src/index.ts";

const Response = Schema.Struct({
  title: Core.lenientField(Schema.String),
  id: Core.lenientField(Schema.Int),
  aliases: Core.lenientField(Core.lenientArray(Schema.String)),
});
const decode = Schema.decodeUnknownSync(Response);

describe("lenient response fields", () => {
  it("keeps the leaves that decode", () => {
    expect(decode({ title: "Berlin", id: 6, aliases: ["a", "b"] })).toEqual({
      title: "Berlin",
      id: 6,
      aliases: ["a", "b"],
    });
  });

  it("drops a leaf of the wrong kind instead of failing the decode", () => {
    expect(decode({ title: 7, id: "six", aliases: "not a list" })).toEqual({});
  });

  it("drops a fractional or non-finite integer leaf", () => {
    expect(decode({ id: 6.5 })).toEqual({});
    expect(decode({ id: Number.NaN })).toEqual({});
    expect(decode({ id: Number.POSITIVE_INFINITY })).toEqual({});
  });

  it("leaves an array element of the wrong kind undefined, in place", () => {
    expect(decode({ aliases: ["a", 7, "b"] })).toEqual({ aliases: ["a", undefined, "b"] });
  });

  it("still fails when the container itself isn't an object", () => {
    expect(() => decode("not an object")).toThrow("Expected object");
  });
});
