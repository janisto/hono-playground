export const MAX_CURSOR_LENGTH = 2_048;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;
const BASE64_BLOCK_SIZE = 4;

export interface Cursor {
  readonly cursorType: string;
  readonly value: string;
}

export class InvalidCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCursorError";
  }
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function encodeCursor(cursorType: string, value: string): string {
  return encodeBytes(new TextEncoder().encode(`${cursorType}:${value}`));
}

function decodeBytes(encodedCursor: string): Uint8Array {
  if (!BASE64URL_PATTERN.test(encodedCursor)) {
    throw new InvalidCursorError("invalid cursor format");
  }

  const firstPaddingIndex = encodedCursor.indexOf("=");
  const unpadded =
    firstPaddingIndex === -1 ? encodedCursor : encodedCursor.slice(0, firstPaddingIndex);
  const suppliedPadding = encodedCursor.length - unpadded.length;
  const remainder = unpadded.length % BASE64_BLOCK_SIZE;
  if (remainder === 1) {
    throw new InvalidCursorError("invalid cursor format");
  }

  const requiredPadding = remainder === 0 ? 0 : BASE64_BLOCK_SIZE - remainder;
  if (suppliedPadding > requiredPadding) {
    throw new InvalidCursorError("invalid cursor format");
  }

  const standardBase64 = unpadded.replaceAll("-", "+").replaceAll("_", "/");
  const normalized = standardBase64 + "=".repeat(requiredPadding);

  try {
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (encodeBytes(bytes) !== unpadded) {
      throw new InvalidCursorError("invalid cursor format");
    }
    return bytes;
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      throw error;
    }
    throw new InvalidCursorError("invalid cursor format");
  }
}

export function decodeCursor(encodedCursor: string): Cursor {
  if (encodedCursor.length > MAX_CURSOR_LENGTH) {
    throw new InvalidCursorError("cursor exceeds maximum length");
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      decodeBytes(encodedCursor),
    );
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      throw error;
    }
    throw new InvalidCursorError("invalid cursor format");
  }

  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) {
    throw new InvalidCursorError("invalid cursor format");
  }

  return {
    cursorType: decoded.slice(0, separatorIndex),
    value: decoded.slice(separatorIndex + 1),
  };
}
