import { describe, expect, it } from "vitest";

import { assertStrictJsonText, MAXIMUM_JSON_NESTING_DEPTH } from "../../src/core/strict-json.js";

describe("strict JSON lexical validation", () => {
  it.each([
    "null",
    "true",
    "-12.5e+2",
    '"plain text"',
    String.raw`"\uD83D\uDE00"`,
    '"😀"',
    "[]",
    "{}",
    '{"data":{"type":"profiles","attributes":{"firstName":"Ada"}}}',
    ' [ true, false, null, {"escaped":"line\\nfeed"} ] ',
  ])("accepts interoperable JSON: %s", (document) => {
    expect(() => assertStrictJsonText(document)).not.toThrow();
  });

  it.each([
    '{"key":1,"key":2}',
    String.raw`{"key":1,"\u006Bey":2}`,
    '{"outer":{"key":1,"key":2}}',
    '[{"key":1,"key":2}]',
  ])("rejects duplicate object names after escape decoding: %s", (document) => {
    expect(() => assertStrictJsonText(document)).toThrow(SyntaxError);
  });

  it.each([
    String.raw`"\uD800"`,
    String.raw`"\uDBFF"`,
    String.raw`"\uDC00"`,
    String.raw`"\uDFFF"`,
    String.raw`{"\uD800":"value"}`,
    String.raw`{"value":"\uDC00"}`,
  ])("rejects an unpaired UTF-16 surrogate: %s", (document) => {
    expect(() => assertStrictJsonText(document)).toThrow(SyntaxError);
  });

  it.each([
    "",
    " ",
    "\uFEFF{}",
    "{",
    '{"key":}',
    '{"key":1,}',
    "[1,]",
    "01",
    "1e",
    String.raw`"\x20"`,
    '"line\nfeed"',
    "{} trailing",
  ])("rejects malformed or extended JSON syntax: %j", (document) => {
    expect(() => assertStrictJsonText(document)).toThrow(SyntaxError);
  });

  it("bounds recursive nesting independently of the byte limit", () => {
    const accepted = `${"[".repeat(MAXIMUM_JSON_NESTING_DEPTH)}0${"]".repeat(MAXIMUM_JSON_NESTING_DEPTH)}`;
    const rejected = `[${accepted}]`;

    expect(() => assertStrictJsonText(accepted)).not.toThrow();
    expect(() => assertStrictJsonText(rejected)).toThrow(SyntaxError);
  });
});
