import { AppError, validationError } from "./errors.js";

export const precheckJsonBody = async (request: Request, maximumBytes: number): Promise<void> => {
  const encoding = request.headers.get("Content-Encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
    throw new AppError({
      status: 415,
      code: "unsupported_media_type",
      detail: "Only identity-encoded application/json is supported",
    });
  }

  const contentType = request.headers.get("Content-Type");
  if (contentType === null) {
    throw validationError([{ location: "body", message: "JSON body is required" }]);
  }
  const baseType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (baseType !== "application/json") {
    throw new AppError({
      status: 415,
      code: "unsupported_media_type",
      detail: "Only identity-encoded application/json is supported",
    });
  }

  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength)) {
    if (Number(declaredLength) > maximumBytes) {
      throw new AppError({
        status: 413,
        code: "payload_too_large",
        detail: "Request body too large",
      });
    }
  }

  if (request.body === null) {
    return;
  }
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
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new AppError({
      status: 422,
      code: "validation_failed",
      detail: "validation failed",
      errors: [{ location: "body", message: "Invalid JSON body" }],
    });
  }
};
