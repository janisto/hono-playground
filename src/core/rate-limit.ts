import type { Context } from "hono";

import { hmacSha256 } from "./crypto.ts";
import { AppError } from "./errors.ts";
import type { AppEnvironment } from "./types.ts";

const limitExceeded = (): AppError =>
  new AppError({
    code: "rate_limited",
    headers: { "Retry-After": "60" },
  });

const unavailable = (operatorCode: "profile_limiter_unavailable" | "public_limiter_unavailable"): AppError =>
  new AppError({
    code: "dependency_unavailable",
    operatorCode,
  });

const invoke = async (
  limiter: RateLimit | undefined,
  key: string,
  operatorCode: "profile_limiter_unavailable" | "public_limiter_unavailable",
): Promise<void> => {
  if (limiter === undefined) throw unavailable(operatorCode);
  const result = await limiter.limit({ key });
  if (result.success === false) throw limitExceeded();
  if (result.success !== true) throw new TypeError("Rate limiter returned an invalid result");
};

const normalizeIpv4 = (value: string): string | undefined => {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const numbers = parts.map((part) => (/^\d{1,3}$/u.test(part) ? Number(part) : Number.NaN));
  if (numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return numbers.join(".");
};

const normalizeIpv6 = (value: string): string | undefined => {
  if (value.length < 2 || value.length > 45 || !value.includes(":") || !/^[0-9a-f:.]+$/iu.test(value)) {
    return undefined;
  }
  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1).toLowerCase() : undefined;
  } catch {
    return undefined;
  }
};

export const normalizeClientIp = (value: string | undefined): string | undefined => {
  if (value === undefined || value !== value.trim()) return undefined;
  return normalizeIpv4(value) ?? normalizeIpv6(value);
};

export const enforcePublicRateLimit = async (c: Context<AppEnvironment>): Promise<void> => {
  if (c.get("runtimeConfig").rateLimitMode === "none") return;
  const actor = normalizeClientIp(c.req.header("CF-Connecting-IP")) ?? "unknown";
  if (
    actor === "unknown" &&
    (c.get("runtimeConfig").environment === "staging" || c.get("runtimeConfig").environment === "production")
  ) {
    console.error({
      schema_version: 1,
      event: "operator.error",
      level: "error",
      code: "public_client_ip_unavailable",
      request_id: c.get("requestId"),
    });
  }
  const route = c.get("routeMetadata").template;
  const key = await hmacSha256(c.env.RATE_LIMIT_KEY_HMAC_KEY, `public:${route}:${actor}`);
  try {
    await invoke(c.env.PUBLIC_RATE_LIMITER, key, "public_limiter_unavailable");
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unavailable("public_limiter_unavailable");
  }
};

export const enforceProfileRateLimit = async (
  c: Context<AppEnvironment>,
  subject: string,
  kind: "read" | "write",
): Promise<void> => {
  if (c.get("runtimeConfig").rateLimitMode === "none") return;
  const key = await hmacSha256(c.env.RATE_LIMIT_KEY_HMAC_KEY, `profile:${kind}:${subject}`);
  try {
    await invoke(
      kind === "read" ? c.env.PROFILE_READ_RATE_LIMITER : c.env.PROFILE_WRITE_RATE_LIMITER,
      key,
      "profile_limiter_unavailable",
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unavailable("profile_limiter_unavailable");
  }
};
