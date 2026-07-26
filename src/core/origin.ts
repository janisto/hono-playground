import { AppError } from "./errors.js";

export const requireSameOriginForUnsafeProfile = (request: Request): void => {
  if (!(["POST", "PATCH", "DELETE"] as const).includes(request.method as never)) return;
  const origin = request.headers.get("Origin");
  if (origin === null) return;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new AppError({
      status: 403,
      code: "origin_not_allowed",
      detail: "Origin not allowed",
      source: { header: "Origin" },
    });
  }

  if (origin === "null" || parsed.origin !== origin || parsed.origin !== new URL(request.url).origin) {
    throw new AppError({
      status: 403,
      code: "origin_not_allowed",
      detail: "Origin not allowed",
      source: { header: "Origin" },
    });
  }
};
