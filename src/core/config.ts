import { AppError } from "./errors.js";
import type {
  DeploymentProfile,
  EnvironmentName,
  LogLevel,
  RateLimitMode,
  RuntimeBindings,
  RuntimeConfig,
} from "./types.js";

const ENVIRONMENTS = new Set<EnvironmentName>(["development", "test", "production"]);
const DEPLOYMENT_PROFILES = new Set<DeploymentProfile>([
  "workers-dev-demo",
  "custom-domain-production",
]);
const LOG_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);
const RATE_LIMIT_MODES = new Set<RateLimitMode>(["none", "workers-binding", "workers-binding+waf"]);
const HMAC_SECRET_SHAPE = /^[0-9a-f]{64}$/u;
const REPEATED_SECRET_CHUNK = /^(.{1,32})\1+$/u;

const configurationError = (): AppError =>
  new AppError({
    status: 500,
    code: "internal_error",
    detail: "Internal Server Error",
    operatorCode: "runtime_configuration_invalid",
  });

const oneOf = <T extends string>(value: string | undefined, allowed: Set<T>): T => {
  if (value === undefined || !allowed.has(value as T)) throw configurationError();
  return value as T;
};

const booleanValue = (value: string | undefined): boolean => {
  if (value === "true") return true;
  if (value === "false") return false;
  throw configurationError();
};

export const parseRuntimeConfig = (
  bindings: RuntimeBindings,
  maximumRequestBytesOverride?: number,
): RuntimeConfig => {
  const environment = oneOf(bindings.ENVIRONMENT, ENVIRONMENTS);
  const deploymentProfile = oneOf(bindings.DEPLOYMENT_PROFILE, DEPLOYMENT_PROFILES);
  const logLevel = oneOf(bindings.LOG_LEVEL ?? "info", LOG_LEVELS);
  const rateLimitMode = oneOf(bindings.RATE_LIMIT_MODE, RATE_LIMIT_MODES);
  const maximumRaw =
    maximumRequestBytesOverride ?? Number(bindings.MAX_REQUEST_SIZE_BYTES ?? 1_000_000);

  if (!Number.isSafeInteger(maximumRaw) || maximumRaw < 1 || maximumRaw > 10_000_000) {
    throw configurationError();
  }
  if (environment === "production" && maximumRaw !== 1_000_000) throw configurationError();
  if (environment === "production" && logLevel === "debug") throw configurationError();
  if (environment === "production" && rateLimitMode === "none") throw configurationError();
  if (deploymentProfile === "workers-dev-demo" && rateLimitMode === "workers-binding+waf") {
    throw configurationError();
  }

  return {
    environment,
    deploymentProfile,
    logLevel,
    maximumRequestBytes: maximumRaw,
    managedOauthEnabled: booleanValue(bindings.MANAGED_OAUTH_ENABLED ?? "false"),
    rateLimitMode,
  };
};

export const requireHmacSecret = (value: string | undefined): Uint8Array => {
  if (
    value === undefined ||
    !HMAC_SECRET_SHAPE.test(value) ||
    REPEATED_SECRET_CHUNK.test(value) ||
    new Set(value).size < 12
  ) {
    throw configurationError();
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};
