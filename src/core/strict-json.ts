export const MAXIMUM_JSON_NESTING_DEPTH = 128;

const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u;
const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const SIMPLE_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);
const HEX_QUAD = /^[0-9A-Fa-f]{4}$/u;

const isWellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
};

class StrictJsonParser {
  readonly #text: string;
  #position = 0;

  constructor(text: string) {
    this.#text = text;
  }

  parse(): void {
    this.#skipWhitespace();
    this.#parseValue(0);
    this.#skipWhitespace();
    if (this.#position !== this.#text.length) this.#fail();
  }

  #parseValue(depth: number): void {
    this.#skipWhitespace();
    const token = this.#text[this.#position];
    switch (token) {
      case "{":
        this.#parseObject(depth + 1);
        return;
      case "[":
        this.#parseArray(depth + 1);
        return;
      case '"':
        this.#parseString();
        return;
      case "t":
        this.#parseLiteral("true");
        return;
      case "f":
        this.#parseLiteral("false");
        return;
      case "n":
        this.#parseLiteral("null");
        return;
      default:
        if (token === "-" || (token !== undefined && token >= "0" && token <= "9")) {
          this.#parseNumber();
          return;
        }
        this.#fail();
    }
  }

  #parseObject(depth: number): void {
    if (depth > MAXIMUM_JSON_NESTING_DEPTH) this.#fail();
    this.#position += 1;
    this.#skipWhitespace();
    if (this.#consume("}")) return;

    const keys = new Set<string>();
    while (true) {
      this.#skipWhitespace();
      if (this.#text[this.#position] !== '"') this.#fail();
      const key = this.#parseString();
      if (keys.has(key)) this.#fail();
      keys.add(key);

      this.#skipWhitespace();
      if (!this.#consume(":")) this.#fail();
      this.#parseValue(depth);
      this.#skipWhitespace();
      if (this.#consume("}")) return;
      if (!this.#consume(",")) this.#fail();
    }
  }

  #parseArray(depth: number): void {
    if (depth > MAXIMUM_JSON_NESTING_DEPTH) this.#fail();
    this.#position += 1;
    this.#skipWhitespace();
    if (this.#consume("]")) return;

    while (true) {
      this.#parseValue(depth);
      this.#skipWhitespace();
      if (this.#consume("]")) return;
      if (!this.#consume(",")) this.#fail();
    }
  }

  #parseString(): string {
    const start = this.#position;
    this.#position += 1;

    while (this.#position < this.#text.length) {
      const character = this.#text[this.#position];
      if (character === '"') {
        this.#position += 1;
        let value: unknown;
        try {
          value = JSON.parse(this.#text.slice(start, this.#position));
        } catch {
          this.#fail();
        }
        if (typeof value !== "string" || !isWellFormedUnicode(value)) this.#fail();
        return value;
      }

      if (character === "\\") {
        this.#position += 1;
        const escapedCharacter = this.#text[this.#position];
        if (escapedCharacter === "u") {
          const digits = this.#text.slice(this.#position + 1, this.#position + 5);
          if (!HEX_QUAD.test(digits)) this.#fail();
          this.#position += 5;
          continue;
        }
        if (escapedCharacter === undefined || !SIMPLE_ESCAPES.has(escapedCharacter)) {
          this.#fail();
        }
        this.#position += 1;
        continue;
      }

      if (character === undefined || character.charCodeAt(0) <= 0x1f) this.#fail();
      const codeUnit = character.charCodeAt(0);
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const trailing = this.#text.charCodeAt(this.#position + 1);
        if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) this.#fail();
        this.#position += 2;
      } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        this.#fail();
      } else {
        this.#position += 1;
      }
    }
    this.#fail();
  }

  #parseLiteral(literal: string): void {
    if (!this.#text.startsWith(literal, this.#position)) this.#fail();
    this.#position += literal.length;
  }

  #parseNumber(): void {
    const match = JSON_NUMBER.exec(this.#text.slice(this.#position));
    if (match === null) this.#fail();
    this.#position += match[0].length;
  }

  #consume(expected: string): boolean {
    if (this.#text[this.#position] !== expected) return false;
    this.#position += 1;
    return true;
  }

  #skipWhitespace(): void {
    while (JSON_WHITESPACE.has(this.#text[this.#position] ?? "")) {
      this.#position += 1;
    }
  }

  #fail(): never {
    throw new SyntaxError("Invalid strict JSON document");
  }
}

export const assertStrictJsonText = (text: string): void => {
  new StrictJsonParser(text).parse();
};
