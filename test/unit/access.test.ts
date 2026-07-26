import {
  createLocalJWKSet,
  exportJWK,
  type FetchImplementation,
  generateKeyPair,
  type JWK,
  type JWTPayload,
  SignJWT,
} from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  ACCESS_CLOCK_TOLERANCE_SECONDS,
  createAccessVerifier,
  MAX_ACCESS_AUDIENCE_LENGTH,
  MAX_ACCESS_SUBJECT_LENGTH,
  parseAccessVerifierConfig,
} from "../../src/auth/access.ts";
import { AccessConfigurationError, AccessJwksUnavailableError, InvalidAccessTokenError } from "../../src/auth/types.ts";

const TEAM_DOMAIN = "https://team.cloudflareaccess.com";
const ISSUER = TEAM_DOMAIN;
const AUDIENCE = "expected-audience-tag";
const FIRST_KEY_ID = "access-key-1";
const SECOND_KEY_ID = "access-key-2";
const NOW = new Date("2026-07-22T12:00:00.000Z");
const NOW_SECONDS = NOW.getTime() / 1_000;

type GeneratedKeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

let firstKeyPair: GeneratedKeyPair;
let secondKeyPair: GeneratedKeyPair;
let firstPublicJwk: JWK;
let secondPublicJwk: JWK;

beforeAll(async () => {
  [firstKeyPair, secondKeyPair] = await Promise.all([
    generateKeyPair("RS256", { extractable: true }),
    generateKeyPair("RS256", { extractable: true }),
  ]);
  firstPublicJwk = {
    ...(await exportJWK(firstKeyPair.publicKey)),
    alg: "RS256",
    kid: FIRST_KEY_ID,
    use: "sig",
  };
  secondPublicJwk = {
    ...(await exportJWK(secondKeyPair.publicKey)),
    alg: "RS256",
    kid: SECOND_KEY_ID,
    use: "sig",
  };
});

const validClaims = (): JWTPayload => ({
  iss: ISSUER,
  aud: ["another-audience", AUDIENCE],
  sub: "access-user-123",
  type: "app",
  email: "verified@example.com",
  iat: NOW_SECONDS - 60,
  nbf: NOW_SECONDS - 60,
  exp: NOW_SECONDS + 300,
});

type TokenOptions = {
  overrides?: Record<string, unknown>;
  omit?: string[];
  keyPair?: GeneratedKeyPair;
  keyId?: string;
};

const signToken = async (options: TokenOptions = {}): Promise<string> => {
  const payload: JWTPayload = { ...validClaims(), ...options.overrides };
  for (const claim of options.omit ?? []) {
    delete payload[claim];
  }

  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: options.keyId ?? FIRST_KEY_ID })
    .sign((options.keyPair ?? firstKeyPair).privateKey);
};

const localVerifier = () =>
  createAccessVerifier(
    { teamDomain: TEAM_DOMAIN, audience: AUDIENCE },
    {
      keyResolver: createLocalJWKSet({ keys: [firstPublicJwk] }),
      now: () => NOW,
    },
  );

const expectAuthenticationFailure = async (result: Promise<unknown>): Promise<InvalidAccessTokenError> => {
  const error: unknown = await result.then(
    () => undefined,
    (reason: unknown) => reason,
  );

  expect(error).toBeInstanceOf(InvalidAccessTokenError);
  if (!(error instanceof InvalidAccessTokenError)) {
    throw new Error("expected InvalidAccessTokenError");
  }
  expect(error).toMatchObject({
    status: 403,
    code: "access_assertion_invalid",
    detail: "Access assertion is missing or invalid",
  });
  expect(error.source).toEqual({ header: "Cf-Access-Jwt-Assertion" });
  expect(error.headers.has("WWW-Authenticate")).toBe(false);
  expect(error.headers.has("Retry-After")).toBe(false);
  return error;
};

const jwksResponse = (keys: JWK[]): Response =>
  new Response(JSON.stringify({ keys }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("Cloudflare Access verifier configuration", () => {
  it("normalizes the issuer and derives the fixed JWKS URL", () => {
    const config = parseAccessVerifierConfig({
      teamDomain: "https://TEAM.cloudflareaccess.com:443/",
      audience: AUDIENCE,
    });

    expect(config).toEqual({
      issuer: TEAM_DOMAIN,
      audience: AUDIENCE,
      jwksUrl: new URL("https://team.cloudflareaccess.com/cdn-cgi/access/certs"),
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it.each([
    undefined,
    null,
    "",
    "http://team.cloudflareaccess.com",
    "https://cloudflareaccess.com",
    "https://evilcloudflareaccess.com",
    "https://team.cloudflareaccess.com.evil.example",
    "https://user@team.cloudflareaccess.com",
    "https://team.cloudflareaccess.com:8443",
    "https://team.cloudflareaccess.com/path",
    "https://team.cloudflareaccess.com/%2e",
    "https://team.cloudflareaccess.com?query=yes",
    "https://team.cloudflareaccess.com#fragment",
    " https://team.cloudflareaccess.com",
  ])("rejects a non-canonical or untrusted team domain: %s", (teamDomain) => {
    expect(() => parseAccessVerifierConfig({ teamDomain, audience: AUDIENCE })).toThrow(AccessConfigurationError);
  });

  it.each([
    undefined,
    null,
    "",
    "contains whitespace",
    "contains\nnewline",
    "\u007f",
    "a".repeat(MAX_ACCESS_AUDIENCE_LENGTH + 1),
  ])("rejects an invalid audience: %s", (audience) => {
    expect(() => parseAccessVerifierConfig({ teamDomain: TEAM_DOMAIN, audience })).toThrow(AccessConfigurationError);
  });

  it("rejects mutually exclusive dependency seams", () => {
    const keyResolver = createLocalJWKSet({ keys: [firstPublicJwk] });
    const fetchImplementation: FetchImplementation = async () => jwksResponse([]);

    expect(() =>
      createAccessVerifier(
        { teamDomain: TEAM_DOMAIN, audience: AUDIENCE },
        { keyResolver, fetch: fetchImplementation },
      ),
    ).toThrow(AccessConfigurationError);
  });

  it("fails closed when the injected clock is invalid", async () => {
    const verifier = createAccessVerifier(
      { teamDomain: TEAM_DOMAIN, audience: AUDIENCE },
      {
        keyResolver: createLocalJWKSet({ keys: [firstPublicJwk] }),
        now: () => new Date(Number.NaN),
      },
    );

    await expect(verifier(await signToken())).rejects.toMatchObject({
      status: 500,
      code: "internal_error",
      operatorCode: "access_verifier_configuration_invalid",
    });
  });
});

describe("Cloudflare Access JWT claims", () => {
  it("accepts a signed app assertion whose audience array contains the configured tag", async () => {
    await expect(localVerifier()(await signToken())).resolves.toEqual({
      sub: "access-user-123",
      email: "verified@example.com",
    });
  });

  it("does not invent an email when the verified claim is absent", async () => {
    await expect(localVerifier()(await signToken({ omit: ["email"] }))).resolves.toEqual({
      sub: "access-user-123",
    });
  });

  it.each([undefined, null, ""])('rejects a missing assertion: "%s"', async (assertion) => {
    await expectAuthenticationFailure(localVerifier()(assertion));
  });

  it.each([
    ["wrong issuer", { iss: "https://other.cloudflareaccess.com" }],
    ["wrong audience", { aud: ["not-the-application"] }],
    ["wrong type", { type: "org" }],
    ["empty subject", { sub: "" }],
    ["whitespace-only subject", { sub: "   " }],
    ["oversized subject", { sub: "s".repeat(MAX_ACCESS_SUBJECT_LENGTH + 1) }],
    ["subject outside the profile UTF-16 bound", { sub: "😀".repeat(65) }],
  ])("rejects a token with %s", async (_caseName, overrides) => {
    await expectAuthenticationFailure(localVerifier()(await signToken({ overrides })));
  });

  it("rejects a service-token assertion instead of using common_name as the owner", async () => {
    const token = await signToken({
      overrides: { sub: "", common_name: "service-token-client-id" },
    });

    await expectAuthenticationFailure(localVerifier()(token));
  });

  it.each(["exp", "iat", "nbf"])("requires the numeric %s claim", async (claim) => {
    await expectAuthenticationFailure(localVerifier()(await signToken({ omit: [claim] })));
    await expectAuthenticationFailure(localVerifier()(await signToken({ overrides: { [claim]: "not-a-number" } })));
  });

  it.each([
    ["expired", { exp: NOW_SECONDS - ACCESS_CLOCK_TOLERANCE_SECONDS - 1 }],
    ["not yet valid", { nbf: NOW_SECONDS + ACCESS_CLOCK_TOLERANCE_SECONDS + 1 }],
    ["issued in the future", { iat: NOW_SECONDS + ACCESS_CLOCK_TOLERANCE_SECONDS + 1 }],
    ["expiration before issued-at", { exp: NOW_SECONDS - 61 }],
    ["expiration before not-before", { nbf: NOW_SECONDS + 10, exp: NOW_SECONDS + 9 }],
  ])("rejects a token that is %s", async (_caseName, overrides) => {
    await expectAuthenticationFailure(localVerifier()(await signToken({ overrides })));
  });

  it("accepts issued-at and not-before at the documented skew boundary", async () => {
    const token = await signToken({
      overrides: {
        iat: NOW_SECONDS + ACCESS_CLOCK_TOLERANCE_SECONDS,
        nbf: NOW_SECONDS + ACCESS_CLOCK_TOLERANCE_SECONDS,
      },
    });

    await expect(localVerifier()(token)).resolves.toMatchObject({ sub: "access-user-123" });
  });

  it("rejects a malformed token without echoing it", async () => {
    const assertion = "sensitive.invalid.assertion";
    const error = await expectAuthenticationFailure(localVerifier()(assertion));

    expect(error.message).not.toContain(assertion);
    expect(error.detail).not.toContain(assertion);
  });

  it("rejects a validly shaped token with an invalid signature", async () => {
    const token = await signToken({ keyPair: secondKeyPair, keyId: FIRST_KEY_ID });

    await expectAuthenticationFailure(localVerifier()(token));
  });

  it("rejects algorithms outside RS256", async () => {
    const token = await new SignJWT(validClaims())
      .setProtectedHeader({ alg: "HS256", kid: FIRST_KEY_ID })
      .sign(new TextEncoder().encode("a-test-secret-long-enough-for-hs256"));

    await expectAuthenticationFailure(localVerifier()(token));
  });
});

describe("remote Cloudflare Access JWKS", () => {
  it("fetches only the derived Cloudflare cert endpoint and verifies its key", async () => {
    const calls: Array<{ url: string; method: string; redirect: string }> = [];
    const fetchImplementation: FetchImplementation = async (url, options) => {
      calls.push({ url, method: options.method, redirect: options.redirect });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return jwksResponse([firstPublicJwk]);
    };
    const verifier = createAccessVerifier(
      { teamDomain: TEAM_DOMAIN, audience: AUDIENCE },
      { fetch: fetchImplementation, now: () => NOW },
    );

    await expect(verifier(await signToken())).resolves.toMatchObject({
      sub: "access-user-123",
    });
    expect(calls).toEqual([
      {
        url: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
        method: "GET",
        redirect: "manual",
      },
    ]);
  });

  it.each([
    ["network", new TypeError("connection failed")],
    ["timeout", new DOMException("request timed out", "TimeoutError")],
  ])("maps a remote %s failure to a retryable 503", async (_failure, cause) => {
    const fetchImplementation: FetchImplementation = async () => {
      throw cause;
    };
    const verifier = createAccessVerifier(
      { teamDomain: TEAM_DOMAIN, audience: AUDIENCE },
      { fetch: fetchImplementation, now: () => NOW },
    );

    const error: unknown = await verifier(await signToken()).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(AccessJwksUnavailableError);
    if (!(error instanceof AccessJwksUnavailableError)) {
      throw new Error("expected AccessJwksUnavailableError");
    }
    expect(error).toMatchObject({
      status: 503,
      code: "jwks_unavailable",
      detail: "Authentication service unavailable",
      operatorCode: "access_jwks_unavailable",
    });
    expect(error.headers.get("Retry-After")).toBe("30");
    expect(error.headers.has("WWW-Authenticate")).toBe(false);
  });

  it("maps a non-success JWKS response to a retryable 503", async () => {
    const fetchImplementation: FetchImplementation = async () => new Response("upstream unavailable", { status: 502 });
    const verifier = createAccessVerifier(
      { teamDomain: TEAM_DOMAIN, audience: AUDIENCE },
      { fetch: fetchImplementation, now: () => NOW },
    );

    await expect(verifier(await signToken())).rejects.toMatchObject({
      status: 503,
      code: "jwks_unavailable",
      headers: expect.any(Headers),
    });
  });

  it("treats an unknown key ID as an authentication failure", async () => {
    const fetchImplementation: FetchImplementation = async () => jwksResponse([firstPublicJwk]);
    const verifier = createAccessVerifier(
      { teamDomain: TEAM_DOMAIN, audience: AUDIENCE },
      { fetch: fetchImplementation, now: () => NOW },
    );

    await expectAuthenticationFailure(verifier(await signToken({ keyPair: secondKeyPair, keyId: SECOND_KEY_ID })));
  });

  it("refreshes the remote JWKS for a rotated key after the bounded cooldown", async () => {
    const baseMilliseconds = NOW.getTime();
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(baseMilliseconds);
    let fetchCount = 0;
    const fetchImplementation: FetchImplementation = async () => {
      fetchCount += 1;
      return jwksResponse(fetchCount === 1 ? [firstPublicJwk] : [secondPublicJwk]);
    };
    const verifier = createAccessVerifier(
      { teamDomain: TEAM_DOMAIN, audience: AUDIENCE },
      { fetch: fetchImplementation, now: () => NOW },
    );

    try {
      await expect(verifier(await signToken())).resolves.toMatchObject({
        sub: "access-user-123",
      });
      dateNow.mockReturnValue(baseMilliseconds + 30_001);
      await expect(verifier(await signToken({ keyPair: secondKeyPair, keyId: SECOND_KEY_ID }))).resolves.toMatchObject({
        sub: "access-user-123",
      });
      expect(fetchCount).toBe(2);
    } finally {
      dateNow.mockRestore();
    }
  });
});
