import { isSupportedJsonApiContentType } from "./content-negotiation.ts";
import { AppError, invalidJsonError } from "./errors.ts";

export type RequestMediaProfile = "json" | "json-api";

const unsupported = (header: string): AppError => new AppError({ code: "unsupported_media_type", source: { header } });

const splitMediaType = (value: string): string[] | null => {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) escaped = false;
    else if (quoted && character === "\\") escaped = true;
    else if (character === '"') quoted = !quoted;
    else if (!quoted && character === ",") return null;
    else if (!quoted && character === ";") {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted || escaped) return null;
  parts.push(value.slice(start));
  return parts;
};

const decodeParameter = (value: string): string | null => {
  if (!value.startsWith('"')) return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(value) ? value : null;
  if (!value.endsWith('"') || value.length < 2) return null;
  let decoded = "";
  for (let index = 1; index < value.length - 1; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x5c) {
      index += 1;
      if (index >= value.length - 1) return null;
      const escaped = value.charCodeAt(index);
      if (escaped !== 0x09 && (escaped < 0x20 || escaped === 0x7f)) return null;
    } else if (code !== 0x09 && (code < 0x20 || code === 0x22 || code === 0x7f)) {
      return null;
    }
    decoded += value[index] ?? "";
  }
  return decoded;
};

const isSupportedJsonContentType = (value: string): boolean => {
  const parts = splitMediaType(value);
  if (parts === null || parts.shift()?.trim().toLowerCase() !== "application/json") return false;
  if (parts.length === 0) return true;
  if (parts.length !== 1) return false;
  const parameter = parts[0]?.trim() ?? "";
  const equals = parameter.indexOf("=");
  if (equals <= 0 || parameter.slice(0, equals).trim().toLowerCase() !== "charset") return false;
  return decodeParameter(parameter.slice(equals + 1).trim())?.toLowerCase() === "utf-8";
};

export type BodyHeaderCheck = Readonly<{ contentTypePresent: boolean }>;

export const precheckDeclaredBodySize = (request: Request, maximumBytes: number): void => {
  const declared = request.headers.get("Content-Length");
  if (declared !== null) {
    if (!/^[0-9]+$/u.test(declared)) {
      throw new AppError({ code: "invalid_request", source: { header: "Content-Length" } });
    }
    const length = BigInt(declared);
    if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new AppError({ code: "invalid_request", source: { header: "Content-Length" } });
    }
    if (length > BigInt(maximumBytes)) {
      throw new AppError({ code: "payload_too_large", source: { header: "Content-Length" } });
    }
  }
};

export const precheckBodyHeaders = (
  request: Request,
  maximumBytes: number,
  profile: RequestMediaProfile,
): BodyHeaderCheck => {
  precheckDeclaredBodySize(request, maximumBytes);
  const declared = request.headers.get("Content-Length");

  const encoding = request.headers.get("Content-Encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") throw unsupported("Content-Encoding");

  const contentType = request.headers.get("Content-Type");
  if (contentType !== null) {
    const supported =
      profile === "json" ? isSupportedJsonContentType(contentType) : isSupportedJsonApiContentType(contentType);
    if (!supported) throw unsupported("Content-Type");
  } else if (declared !== null && BigInt(declared) > 0n) {
    throw unsupported("Content-Type");
  }
  return { contentTypePresent: contentType !== null };
};

export const readBoundedJsonBody = async (
  request: Request,
  maximumBytes: number,
  headers: BodyHeaderCheck,
): Promise<string> => {
  const reader = request.body?.getReader();
  if (reader === undefined) throw invalidJsonError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > maximumBytes) {
      try {
        await reader.cancel();
      } catch {
        // The response is already determined by the byte limit; stream cleanup
        // must not replace the portable 413 with a framework error.
      }
      throw new AppError({ code: "payload_too_large" });
    }
    chunks.push(result.value);
  }
  if (size === 0) throw invalidJsonError();
  if (!headers.contentTypePresent) throw unsupported("Content-Type");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw invalidJsonError();
  }
};
