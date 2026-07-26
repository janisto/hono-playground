import type { FetchImplementation, JWTVerifyGetKey } from "jose";

import { AppError } from "../core/errors.ts";

export interface AccessVerifierConfigInput {
  readonly teamDomain: unknown;
  readonly audience: unknown;
}

export interface AccessVerifierConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: URL;
}

export interface VerifiedAccessIdentity {
  readonly sub: string;
  readonly email?: string;
}

export type AccessVerifier = (assertion: string | null | undefined) => Promise<VerifiedAccessIdentity>;

export interface AccessVerifierDependencies {
  /** Test seam for a local JWKS. Production callers leave this undefined. */
  readonly keyResolver?: JWTVerifyGetKey;
  /** Test seam for the remote JWKS transport. Production callers leave this undefined. */
  readonly fetch?: FetchImplementation;
  /** Test seam for deterministic claim-time validation. */
  readonly now?: () => Date;
}

export class AccessConfigurationError extends AppError {
  constructor() {
    super({
      status: 500,
      code: "internal_error",
      detail: "Internal Server Error",
      operatorCode: "access_verifier_configuration_invalid",
    });
    this.name = "AccessConfigurationError";
  }
}

export class InvalidAccessTokenError extends AppError {
  constructor() {
    super({
      status: 403,
      code: "access_assertion_invalid",
      detail: "Access assertion is missing or invalid",
      source: { header: "Cf-Access-Jwt-Assertion" },
    });
    this.name = "InvalidAccessTokenError";
  }
}

export class AccessJwksUnavailableError extends AppError {
  constructor() {
    super({
      status: 503,
      code: "jwks_unavailable",
      detail: "Authentication service unavailable",
      headers: { "Retry-After": "30" },
      operatorCode: "access_jwks_unavailable",
    });
    this.name = "AccessJwksUnavailableError";
  }
}
