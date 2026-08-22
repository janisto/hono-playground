import { AppError } from "./errors.ts";
import type { EnvironmentName, RateLimitMode, RuntimeBindings, RuntimeConfig } from "./types.ts";

const ENVIRONMENTS = new Set<EnvironmentName>(["development", "staging", "test", "production"]);
const RATE_LIMIT_MODES = new Set<RateLimitMode>(["none", "workers-binding"]);
const HMAC_SECRET_SHAPE = /^[0-9a-f]{64}$/u;
const REPEATED_SECRET_CHUNK = /^(.{1,32})\1+$/u;

const configurationError = (): AppError =>
  new AppError({
    code: "internal_error",
    operatorCode: "runtime_configuration_invalid",
  });

const oneOf = <T extends string>(value: string | undefined, allowed: Set<T>): T => {
  if (value === undefined || !allowed.has(value as T)) throw configurationError();
  return value as T;
};

export const parseRuntimeConfig = (bindings: RuntimeBindings, maximumRequestBytesOverride?: number): RuntimeConfig => {
  const environment = oneOf(bindings.ENVIRONMENT, ENVIRONMENTS);
  const rateLimitMode = oneOf(bindings.RATE_LIMIT_MODE, RATE_LIMIT_MODES);
  const maximumRaw = maximumRequestBytesOverride ?? bindings.MAX_REQUEST_SIZE_BYTES ?? 1_000_000;
  const productionLike = environment === "staging" || environment === "production";
  const publicOriginValue = bindings.PUBLIC_ORIGIN ?? (productionLike ? undefined : "https://hono-playground.dev");

  if (!Number.isSafeInteger(maximumRaw) || maximumRaw < 1 || maximumRaw > 10_000_000) {
    throw configurationError();
  }
  if (productionLike && maximumRaw !== 1_000_000) throw configurationError();
  if (productionLike && rateLimitMode === "none") throw configurationError();
  if (publicOriginValue === undefined) throw configurationError();
  let publicOrigin: URL;
  try {
    publicOrigin = new URL(publicOriginValue);
  } catch {
    throw configurationError();
  }
  if (
    publicOrigin.protocol !== "https:" ||
    publicOrigin.username.length > 0 ||
    publicOrigin.password.length > 0 ||
    publicOrigin.pathname !== "/" ||
    publicOrigin.search.length > 0 ||
    publicOrigin.hash.length > 0 ||
    publicOrigin.origin !== publicOriginValue
  ) {
    throw configurationError();
  }

  return {
    environment,
    maximumRequestBytes: maximumRaw,
    rateLimitMode,
    publicOrigin: publicOrigin.origin,
  };
};

export const isValidHmacSecret = (value: string | undefined): value is string =>
  value !== undefined &&
  HMAC_SECRET_SHAPE.test(value) &&
  !REPEATED_SECRET_CHUNK.test(value) &&
  new Set(value).size >= 12;

export const requireHmacSecret = (value: string | undefined): Uint8Array => {
  if (!isValidHmacSecret(value)) {
    throw configurationError();
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};
