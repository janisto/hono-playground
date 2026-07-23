import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import {
  AccessConfigurationError,
  AccessJwksUnavailableError,
  InvalidAccessTokenError,
} from "../../src/auth/types.js";
import type { RuntimeBindings } from "../../src/core/types.js";
import type { ProfileRepository } from "../../src/repositories/profile-repository.js";

const subject = (): string => `profile-api-${crypto.randomUUID()}`;
const trackedSubjects = new Set<string>();
const database = (env as unknown as RuntimeBindings).DB;

const bindings = new Proxy(env as unknown as RuntimeBindings, {
  get(target, property, receiver) {
    if (property === "RATE_LIMIT_MODE") return "none";
    return Reflect.get(target, property, receiver) as unknown;
  },
});

const request = (
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit = {},
): Promise<Response> =>
  Promise.resolve(app.request(`https://worker.example${path}`, init, bindings));

const authenticatedApp = (owner: string, now: () => Date = () => new Date()) =>
  createApp({
    accessVerifier: async (assertion) => {
      if (assertion !== "signed-test-assertion") throw new InvalidAccessTokenError();
      return { sub: owner };
    },
    now,
  });

const jsonRequest = (method: string, body: unknown, headers: HeadersInit = {}): RequestInit => ({
  method,
  headers: {
    Accept: "application/json",
    "Cf-Access-Jwt-Assertion": "signed-test-assertion",
    "Content-Type": "application/json",
    ...Object.fromEntries(new Headers(headers)),
  },
  body: JSON.stringify(body),
});

afterEach(async () => {
  const owners = [...trackedSubjects];
  trackedSubjects.clear();
  if (owners.length > 0) {
    await database.batch(
      owners.map((owner) => database.prepare("DELETE FROM profiles WHERE id = ?").bind(owner)),
    );
  }
  vi.restoreAllMocks();
});

describe("profile API", () => {
  it("denies outbound fetch by default and allows only the derived Access JWKS endpoint", async () => {
    const teamDomain = "https://integration.cloudflareaccess.com";
    const audience = "integration-audience";
    const owner = "remote-jwks-owner";
    const now = Math.floor(Date.now() / 1_000);
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.alg = "RS256";
    publicJwk.kid = "integration-key";
    publicJwk.use = "sig";
    const assertion = await new SignJWT({ type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: "integration-key" })
      .setIssuer(teamDomain)
      .setAudience(audience)
      .setSubject(owner)
      .setIssuedAt(now)
      .setNotBefore(now - 1)
      .setExpirationTime(now + 300)
      .sign(privateKey);
    const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== `${teamDomain}/cdn-cgi/access/certs`) {
        throw new Error("Unexpected outbound fetch");
      }
      return Response.json({ keys: [publicJwk] }, { headers: { "Cache-Control": "max-age=60" } });
    });
    const app = createApp({
      profileRepositoryFactory: () => ({
        create: async () => undefined,
        get: async () => ({
          id: owner,
          first_name: "Ada",
          last_name: "Lovelace",
          email: "ada@example.com",
          phone_number: "+12025550123",
          marketing: false,
          terms: true,
          created_at: "2026-07-22T12:00:00.000Z",
          updated_at: "2026-07-22T12:00:00.000Z",
        }),
        update: async () => undefined,
        delete: async () => false,
      }),
    });
    const response = await app.request(
      new Request("https://worker.example/v1/profile", {
        headers: { "Cf-Access-Jwt-Assertion": assertion },
      }),
      undefined,
      {
        ...bindings,
        ACCESS_TEAM_DOMAIN: teamDomain,
        ACCESS_AUD: audience,
      },
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as { id: string }).toMatchObject({ id: owner });
    expect(outbound).toHaveBeenCalledOnce();
    expect(outbound.mock.calls[0]?.[0].toString()).toBe(`${teamDomain}/cdn-cgi/access/certs`);
  });

  it.each([
    [
      "invalid assertion",
      new InvalidAccessTokenError(),
      401,
      "Not authenticated",
      "WWW-Authenticate",
      'Bearer realm="Cloudflare Access"',
      undefined,
    ],
    [
      "JWKS outage",
      new AccessJwksUnavailableError(),
      503,
      "Authentication service unavailable",
      "Retry-After",
      "30",
      "access_jwks_unavailable",
    ],
    [
      "verifier configuration",
      new AccessConfigurationError(),
      500,
      "Internal Server Error",
      undefined,
      undefined,
      "access_verifier_configuration_invalid",
    ],
  ])(
    "maps an injected %s failure through the Worker boundary",
    async (_name, failure, status, detail, header, headerValue, operatorCode) => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const get = vi.fn(async () => undefined);
      const app = createApp({
        accessVerifier: async () => {
          throw failure;
        },
        profileRepositoryFactory: () => ({
          create: async () => undefined,
          get,
          update: async () => undefined,
          delete: async () => false,
        }),
      });
      const response = await request(app, "/v1/profile", {
        headers: { "Cf-Access-Jwt-Assertion": "test" },
      });

      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ status, detail });
      if (header === undefined) {
        expect(response.headers.has("WWW-Authenticate")).toBe(false);
        expect(response.headers.has("Retry-After")).toBe(false);
      } else {
        expect(response.headers.get(header)).toBe(headerValue);
      }
      expect(get).not.toHaveBeenCalled();
      if (operatorCode !== undefined) {
        expect(errorLog).toHaveBeenCalledWith({
          schema_version: 1,
          event: "operator.error",
          level: "error",
          code: operatorCode,
        });
      }
    },
  );

  it("runs normalized create/get/empty patch/update/delete with stable headers", async () => {
    const owner = subject();
    trackedSubjects.add(owner);
    const times = [
      new Date("2026-07-22T10:00:00.000Z"),
      new Date("2026-07-22T10:30:00.000Z"),
      new Date("2026-07-22T11:00:00.000Z"),
    ];
    const app = authenticatedApp(owner, () => {
      const time = times.shift();
      if (time === undefined) throw new Error("unexpected clock read");
      return time;
    });

    const created = await request(
      app,
      "/v1/profile",
      jsonRequest("POST", {
        first_name: "Ada",
        last_name: "Lovelace",
        email: " ADA@example.com ",
        phone_number: " +358401234567 ",
        terms: true,
      }),
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("Location")).toBe("/v1/profile");
    expect(created.headers.get("Link")).toContain("/schemas/Profile.json");
    expect(created.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const initial = await created.json();
    expect(initial).toEqual({
      id: owner,
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@example.com",
      phone_number: "+358401234567",
      marketing: false,
      terms: true,
      created_at: "2026-07-22T10:00:00.000Z",
      updated_at: "2026-07-22T10:00:00.000Z",
    });

    const conflict = await request(
      app,
      "/v1/profile",
      jsonRequest("POST", {
        first_name: "Grace",
        last_name: "Hopper",
        email: "grace@example.com",
        phone_number: "+12025550123",
        terms: true,
      }),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      title: "Conflict",
      status: 409,
      detail: "Profile already exists",
    });

    const get = await request(app, "/v1/profile", {
      headers: {
        Accept: "application/json",
        "Cf-Access-Jwt-Assertion": "signed-test-assertion",
      },
    });
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual(initial);

    const emptyPatch = await request(app, "/v1/profile", jsonRequest("PATCH", {}));
    expect(emptyPatch.status).toBe(200);
    expect(await emptyPatch.json()).toEqual(initial);

    const updated = await request(
      app,
      "/v1/profile",
      jsonRequest("PATCH", { first_name: "Grace", marketing: true }),
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      first_name: "Grace",
      marketing: true,
      created_at: "2026-07-22T10:00:00.000Z",
      updated_at: "2026-07-22T11:00:00.000Z",
    });

    const deleted = await request(app, "/v1/profile", {
      method: "DELETE",
      headers: {
        Accept: "text/plain",
        "Cf-Access-Jwt-Assertion": "signed-test-assertion",
      },
    });
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");

    const missing = await request(app, "/v1/profile", {
      headers: { "Cf-Access-Jwt-Assertion": "signed-test-assertion" },
    });
    expect(missing.status).toBe(404);
    expect(times).toHaveLength(0);
  });

  it("rejects method, negotiation, origin, and content policy before authentication", async () => {
    const verifier = vi.fn(async () => ({ sub: "unreachable" }));
    const app = createApp({ accessVerifier: verifier, maximumRequestBytes: 16 });

    const method = await request(app, "/v1/profile", { method: "OPTIONS" });
    expect(method.status).toBe(405);
    expect(method.headers.get("Allow")).toBe("GET, POST, PATCH, DELETE");

    const unacceptable = await request(app, "/v1/profile", {
      method: "POST",
      headers: { Accept: "text/plain" },
    });
    expect(unacceptable.status).toBe(406);

    const crossOrigin = await request(app, "/v1/profile", {
      method: "POST",
      headers: { Accept: "application/json", Origin: "https://attacker.invalid" },
    });
    expect(crossOrigin.status).toBe(403);

    const unsupported = await request(app, "/v1/profile", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "text/plain" },
      body: "not json",
    });
    expect(unsupported.status).toBe(415);

    const oversized = await request(app, "/v1/profile", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ value: "larger than sixteen bytes" }),
    });
    expect(oversized.status).toBe(413);
    expect(verifier).not.toHaveBeenCalled();
  });

  it("authenticates before JSON syntax validation and never mutates on malformed input", async () => {
    const owner = subject();
    trackedSubjects.add(owner);
    const verifier = vi.fn(async () => ({ sub: owner }));
    const app = createApp({ accessVerifier: verifier });
    const malformed = await request(app, "/v1/profile", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Cf-Access-Jwt-Assertion": "value-is-verified-by-test-seam",
        "Content-Type": "application/json",
      },
      body: "{",
    });
    expect(malformed.status).toBe(422);
    const empty = await request(app, "/v1/profile", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Cf-Access-Jwt-Assertion": "value-is-verified-by-test-seam",
        "Content-Type": "application/json",
      },
    });
    expect(empty.status).toBe(422);
    expect(verifier).toHaveBeenCalledTimes(2);
    const count = await database
      .prepare("SELECT COUNT(*) AS count FROM profiles WHERE id = ?")
      .bind(owner)
      .first<number>("count");
    expect(count).toBe(0);
  });

  it.each([
    [
      "POST terms string",
      "POST",
      {
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@example.com",
        phone_number: "+12025550123",
        terms: "true",
      },
      "body.terms",
    ],
    [
      "POST numeric marketing",
      "POST",
      {
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@example.com",
        phone_number: "+12025550123",
        marketing: 1,
        terms: true,
      },
      "body.marketing",
    ],
    [
      "POST Unicode phone digits",
      "POST",
      {
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@example.com",
        phone_number: "+1١٢٣٤٥٦",
        terms: true,
      },
      "body.phone_number",
    ],
    [
      "POST unknown camelCase field",
      "POST",
      {
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@example.com",
        phone_number: "+12025550123",
        terms: true,
        firstName: "caller override",
      },
      "body.firstName",
    ],
    ["PATCH explicit null", "PATCH", { first_name: null }, "body.first_name"],
    ["PATCH forbidden terms", "PATCH", { terms: true }, "body.terms"],
    ["PATCH caller id", "PATCH", { id: "caller-id" }, "body.id"],
    [
      "PATCH caller timestamp",
      "PATCH",
      { updated_at: "2026-07-22T12:00:00.000Z" },
      "body.updated_at",
    ],
  ])("rejects strict wire shape without coercion: %s", async (_name, method, body, location) => {
    const profileRepository: ProfileRepository = {
      create: vi.fn(async () => undefined),
      get: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      delete: vi.fn(async () => false),
    };
    const app = createApp({
      accessVerifier: async () => ({ sub: "strict-shape-subject" }),
      profileRepositoryFactory: () => profileRepository,
    });
    const response = await request(app, "/v1/profile", {
      method,
      headers: {
        Accept: "application/json",
        "Cf-Access-Jwt-Assertion": "test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const problem = (await response.json()) as {
      errors: Array<{ location: string; message: string }>;
    };

    expect(response.status).toBe(422);
    expect(problem.errors).toContainEqual(expect.objectContaining({ location }));
    expect(profileRepository.create).not.toHaveBeenCalled();
    expect(profileRepository.get).not.toHaveBeenCalled();
    expect(profileRepository.update).not.toHaveBeenCalled();
    expect(profileRepository.delete).not.toHaveBeenCalled();
  });

  it("turns corrupt repository output into a generic 500 before serialization", async () => {
    const corruptRepository: ProfileRepository = {
      create: async () => undefined,
      get: async () => ({ id: "leak-marker" }) as never,
      update: async () => undefined,
      delete: async () => false,
    };
    const app = createApp({
      accessVerifier: async () => ({ sub: "subject" }),
      profileRepositoryFactory: () => corruptRepository,
    });
    const response = await request(app, "/v1/profile", {
      headers: { "Cf-Access-Jwt-Assertion": "test" },
    });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("leak-marker");
  });

  it.each([
    [{ email: "ADA@EXAMPLE.COM" }, "ADA@EXAMPLE.COM"],
    [{ phone_number: " +358401234567 " }, "+358401234567"],
  ])("rejects output that would require request-style normalization", async (override, marker) => {
    const corruptRepository: ProfileRepository = {
      create: async () => undefined,
      get: async () => ({
        id: "subject",
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@example.com",
        phone_number: "+358401234567",
        marketing: false,
        terms: true,
        created_at: "2026-07-22T12:00:00.000Z",
        updated_at: "2026-07-22T12:00:00.000Z",
        ...override,
      }),
      update: async () => undefined,
      delete: async () => false,
    };
    const app = createApp({
      accessVerifier: async () => ({ sub: "subject" }),
      profileRepositoryFactory: () => corruptRepository,
    });
    const response = await request(app, "/v1/profile", {
      headers: { "Cf-Access-Jwt-Assertion": "test" },
    });

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(marker);
  });
});
