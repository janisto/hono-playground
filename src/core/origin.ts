import { AppError } from "./errors.ts";

export const requireTrustedOriginForUnsafeProfile = (request: Request, trustedOrigin: string): boolean => {
  if (!new Set(["POST", "PATCH", "DELETE"]).has(request.method)) return false;
  const origin = request.headers.get("Origin");
  if (origin === null) return false;
  try {
    const parsed = new URL(origin);
    if (
      origin === "null" ||
      parsed.protocol !== "https:" ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== "/" ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0 ||
      parsed.origin !== origin ||
      parsed.origin !== trustedOrigin
    ) {
      throw new TypeError("untrusted origin");
    }
  } catch {
    throw new AppError({ code: "forbidden", source: { header: "Origin" } });
  }
  return true;
};
