import { JSON_API_MEDIA_TYPE } from "../models/json-api.js";
import { isSupportedJsonApiContentType } from "./content-negotiation.js";
import { AppError, invalidJsonError } from "./errors.js";

const unsupportedRepresentation = (detail: string, header: string): AppError =>
  new AppError({
    status: 415,
    code: "unsupported_media_type",
    detail,
    source: { header },
  });

export const precheckJsonApiBody = async (
  request: Request,
  maximumBytes: number,
): Promise<string> => {
  const encoding = request.headers.get("Content-Encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
    throw unsupportedRepresentation(
      "Only identity-encoded JSON:API documents are supported",
      "Content-Encoding",
    );
  }

  if (!isSupportedJsonApiContentType(request.headers.get("Content-Type"))) {
    throw unsupportedRepresentation(
      `Content-Type must be ${JSON_API_MEDIA_TYPE} without unsupported extensions`,
      "Content-Type",
    );
  }

  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null && /^\d+$/u.test(declaredLength)) {
    if (Number(declaredLength) > maximumBytes) {
      throw new AppError({
        status: 413,
        code: "payload_too_large",
        detail: "Request body too large",
        source: { header: "Content-Length" },
      });
    }
  }

  if (request.body === null) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new AppError({
        status: 413,
        code: "payload_too_large",
        detail: "Request body too large",
      });
    }
    chunks.push(result.value);
  }

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
