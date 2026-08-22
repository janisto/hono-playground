import { assertStrictJsonText } from "../core/strict-json.ts";

export const MAX_CURSOR_LENGTH = 2_048;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export class InvalidCursorError extends Error {
  constructor() {
    super("invalid cursor");
    this.name = "InvalidCursorError";
  }
}

const encodeBytes = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

export const encodeCursor = (state: unknown): string => encodeBytes(new TextEncoder().encode(JSON.stringify(state)));

export const decodeCursor = (encoded: string): unknown => {
  if (
    encoded.length === 0 ||
    encoded.length > MAX_CURSOR_LENGTH ||
    encoded.length % 4 === 1 ||
    !BASE64URL.test(encoded)
  ) {
    throw new InvalidCursorError();
  }
  try {
    const standard = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (encodeBytes(bytes) !== encoded) throw new InvalidCursorError();
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    assertStrictJsonText(text);
    const state: unknown = JSON.parse(text);
    if (encodeCursor(state) !== encoded) throw new InvalidCursorError();
    return state;
  } catch (error) {
    if (error instanceof InvalidCursorError) throw error;
    throw new InvalidCursorError();
  }
};
