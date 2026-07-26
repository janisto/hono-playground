import {
  createRemoteJWKSet,
  customFetch,
  errors,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";

import {
  AccessConfigurationError,
  AccessJwksUnavailableError,
  type AccessVerifier,
  type AccessVerifierConfig,
  type AccessVerifierConfigInput,
  type AccessVerifierDependencies,
  InvalidAccessTokenError,
  type VerifiedAccessIdentity,
} from "./types.js";

export const ACCESS_ASSERTION_HEADER = "Cf-Access-Jwt-Assertion";
export const ACCESS_CLOCK_TOLERANCE_SECONDS = 5;
export const MAX_ACCESS_SUBJECT_LENGTH = 128;
export const MAX_ACCESS_AUDIENCE_LENGTH = 256;

const JWKS_TIMEOUT_MILLISECONDS = 3_000;
const JWKS_COOLDOWN_MILLISECONDS = 30_000;
const JWKS_CACHE_MAX_AGE_MILLISECONDS = 600_000;
const CLOUDFLARE_ACCESS_HOST_SUFFIX = ".cloudflareaccess.com";
const CLOUDFLARE_ACCESS_ORIGIN_SHAPE = /^https:\/\/[a-z0-9.-]+(?::443)?\/?$/i;

class RemoteJwksResolutionError extends Error {
  constructor() {
    super("access_jwks_resolution_failed");
    this.name = "RemoteJwksResolutionError";
  }
}

const remoteKeyResolvers = new Map<string, JWTVerifyGetKey>();

interface AccessJwtPayload extends JWTPayload {
  readonly type?: unknown;
  readonly email?: unknown;
}

function isVisibleAscii(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 0x21 || codePoint > 0x7e) {
      return false;
    }
  }
  return true;
}

export function parseAccessVerifierConfig(input: AccessVerifierConfigInput): AccessVerifierConfig {
  if (
    typeof input.teamDomain !== "string" ||
    !CLOUDFLARE_ACCESS_ORIGIN_SHAPE.test(input.teamDomain) ||
    typeof input.audience !== "string"
  ) {
    throw new AccessConfigurationError();
  }

  let teamDomain: URL;
  try {
    teamDomain = new URL(input.teamDomain);
  } catch {
    throw new AccessConfigurationError();
  }

  if (
    teamDomain.protocol !== "https:" ||
    !teamDomain.hostname.endsWith(CLOUDFLARE_ACCESS_HOST_SUFFIX) ||
    teamDomain.username.length > 0 ||
    teamDomain.password.length > 0 ||
    teamDomain.port.length > 0 ||
    teamDomain.pathname !== "/" ||
    teamDomain.search.length > 0 ||
    teamDomain.hash.length > 0
  ) {
    throw new AccessConfigurationError();
  }

  const audienceLength = Array.from(input.audience).length;
  if (
    audienceLength === 0 ||
    audienceLength > MAX_ACCESS_AUDIENCE_LENGTH ||
    !isVisibleAscii(input.audience)
  ) {
    throw new AccessConfigurationError();
  }

  const issuer = teamDomain.origin;
  return Object.freeze({
    issuer,
    audience: input.audience,
    jwksUrl: new URL("/cdn-cgi/access/certs", issuer),
  });
}

function shouldRemainAuthenticationFailure(error: unknown): boolean {
  return (
    error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys
  );
}

function wrapRemoteKeyResolver(resolver: JWTVerifyGetKey): JWTVerifyGetKey {
  return async (protectedHeader, token) => {
    try {
      return await resolver(protectedHeader, token);
    } catch (error) {
      if (shouldRemainAuthenticationFailure(error)) {
        throw error;
      }
      throw new RemoteJwksResolutionError();
    }
  };
}

function createRemoteKeyResolver(
  config: AccessVerifierConfig,
  fetchImplementation: AccessVerifierDependencies["fetch"],
): JWTVerifyGetKey {
  const options = {
    timeoutDuration: JWKS_TIMEOUT_MILLISECONDS,
    cooldownDuration: JWKS_COOLDOWN_MILLISECONDS,
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MILLISECONDS,
    ...(fetchImplementation === undefined ? {} : { [customFetch]: fetchImplementation }),
  };
  return wrapRemoteKeyResolver(createRemoteJWKSet(config.jwksUrl, options));
}

function getProductionRemoteKeyResolver(config: AccessVerifierConfig): JWTVerifyGetKey {
  const existing = remoteKeyResolvers.get(config.issuer);
  if (existing !== undefined) {
    return existing;
  }

  const resolver = createRemoteKeyResolver(config, undefined);
  remoteKeyResolvers.set(config.issuer, resolver);
  return resolver;
}

function validateVerifiedClaims(payload: AccessJwtPayload, now: Date): VerifiedAccessIdentity {
  const { exp, iat, nbf, sub } = payload;
  if (
    typeof exp !== "number" ||
    !Number.isFinite(exp) ||
    typeof iat !== "number" ||
    !Number.isFinite(iat) ||
    typeof nbf !== "number" ||
    !Number.isFinite(nbf) ||
    exp <= iat ||
    exp <= nbf ||
    iat > now.getTime() / 1_000 + ACCESS_CLOCK_TOLERANCE_SECONDS ||
    payload.type !== "app" ||
    typeof sub !== "string" ||
    sub.trim().length === 0 ||
    sub.length > MAX_ACCESS_SUBJECT_LENGTH
  ) {
    throw new InvalidAccessTokenError();
  }

  const email = payload.email;
  return typeof email === "string" && email.length > 0 ? { sub, email } : { sub };
}

export function createAccessVerifier(
  input: AccessVerifierConfigInput,
  dependencies: AccessVerifierDependencies = {},
): AccessVerifier {
  const config = parseAccessVerifierConfig(input);
  if (dependencies.keyResolver !== undefined && dependencies.fetch !== undefined) {
    throw new AccessConfigurationError();
  }

  const keyResolver =
    dependencies.keyResolver ??
    (dependencies.fetch === undefined
      ? getProductionRemoteKeyResolver(config)
      : createRemoteKeyResolver(config, dependencies.fetch));

  return async (assertion) => {
    if (typeof assertion !== "string" || assertion.length === 0) {
      throw new InvalidAccessTokenError();
    }

    const now = dependencies.now?.() ?? new Date();
    if (!Number.isFinite(now.getTime())) {
      throw new AccessConfigurationError();
    }

    try {
      const { payload } = await jwtVerify<AccessJwtPayload>(assertion, keyResolver, {
        algorithms: ["RS256"],
        issuer: config.issuer,
        audience: config.audience,
        clockTolerance: ACCESS_CLOCK_TOLERANCE_SECONDS,
        currentDate: now,
        requiredClaims: ["exp", "iat", "nbf", "sub", "type"],
      });
      return validateVerifiedClaims(payload, now);
    } catch (error) {
      if (error instanceof AccessConfigurationError) {
        throw error;
      }
      if (error instanceof RemoteJwksResolutionError) {
        throw new AccessJwksUnavailableError();
      }
      if (error instanceof InvalidAccessTokenError) {
        throw error;
      }
      throw new InvalidAccessTokenError();
    }
  };
}
