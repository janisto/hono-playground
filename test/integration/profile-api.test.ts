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
import type { Profile } from "../../src/models/profile.js";
import type { ProfileRepository } from "../../src/repositories/profile-repository.js";

const JSON_API_MEDIA_TYPE = "application/vnd.api+json";
const CURRENT_PROFILE_PATH = "/v1/profiles/current";
const PROFILES_PATH = "/v1/profiles";

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

const authenticatedHeaders = (headers: HeadersInit = {}): Headers => {
  const result = new Headers({
    Accept: JSON_API_MEDIA_TYPE,
    "Cf-Access-Jwt-Assertion": "signed-test-assertion",
  });
  new Headers(headers).forEach((value, name) => {
    result.set(name, value);
  });
  return result;
};

const jsonApiRequest = (
  method: string,
  document: unknown,
  headers: HeadersInit = {},
): RequestInit => ({
  method,
  headers: authenticatedHeaders({
    "Content-Type": JSON_API_MEDIA_TYPE,
    ...Object.fromEntries(new Headers(headers)),
  }),
  body: JSON.stringify(document),
});

const createDocument = (attributes: Record<string, unknown>, extraData = {}) => ({
  data: {
    type: "profiles",
    attributes,
    ...extraData,
  },
});

const updateDocument = (id: string, attributes?: Record<string, unknown>, extraData = {}) => ({
  data: {
    type: "profiles",
    id,
    ...(attributes === undefined ? {} : { attributes }),
    ...extraData,
  },
});

const validCreateAttributes = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: " ADA@example.com ",
  phoneNumber: " +358401234567 ",
  termsAccepted: true,
};

const storedProfile = (id: string): Profile => ({
  id,
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  phoneNumber: "+358401234567",
  marketingOptIn: false,
  termsAccepted: true,
  createdAt: "2026-07-22T12:00:00.000Z",
  updatedAt: "2026-07-22T12:00:00.000Z",
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

describe("JSON:API profile resources", () => {
  it("denies arbitrary outbound fetch and allows only the derived Access JWKS endpoint", async () => {
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
        get: async () => storedProfile(owner),
        update: async () => undefined,
        delete: async () => false,
      }),
    });
    const response = await app.request(
      new Request(`https://worker.example${CURRENT_PROFILE_PATH}`, {
        headers: { Accept: JSON_API_MEDIA_TYPE, "Cf-Access-Jwt-Assertion": assertion },
      }),
      undefined,
      {
        ...bindings,
        ACCESS_TEAM_DOMAIN: teamDomain,
        ACCESS_AUD: audience,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { type: "profiles", id: owner },
    });
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
    "maps an injected %s failure through the JSON:API boundary",
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
      const response = await request(app, CURRENT_PROFILE_PATH, {
        headers: {
          Accept: JSON_API_MEDIA_TYPE,
          "Cf-Access-Jwt-Assertion": "test",
          "X-Request-ID": "profile-dependency-failure-id",
        },
      });
      const payload = (await response.json()) as {
        errors: Array<{
          status: string;
          detail: string;
          source?: { header: string };
        }>;
      };

      expect(response.status).toBe(status);
      expect(response.headers.get("Content-Type")).toBe(JSON_API_MEDIA_TYPE);
      expect(payload.errors[0]).toMatchObject({ status: String(status), detail });
      if (failure instanceof InvalidAccessTokenError) {
        expect(payload.errors[0]?.source).toEqual({ header: "Cf-Access-Jwt-Assertion" });
      }
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
          request_id: "profile-dependency-failure-id",
        });
      }
    },
  );

  it("runs normalized create/get/no-op patch/update/delete against real D1", async () => {
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
      PROFILES_PATH,
      jsonApiRequest("POST", createDocument(validCreateAttributes)),
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("Content-Type")).toBe(JSON_API_MEDIA_TYPE);
    expect(created.headers.get("Location")).toBe(CURRENT_PROFILE_PATH);
    expect(created.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const initial = await created.json();
    expect(initial).toEqual({
      jsonapi: { version: "1.1" },
      links: {
        self: CURRENT_PROFILE_PATH,
      },
      data: {
        type: "profiles",
        id: owner,
        attributes: {
          firstName: "Ada",
          lastName: "Lovelace",
          email: "ada@example.com",
          phoneNumber: "+358401234567",
          marketingOptIn: false,
          termsAccepted: true,
          createdAt: "2026-07-22T10:00:00.000Z",
          updatedAt: "2026-07-22T10:00:00.000Z",
        },
        links: { self: CURRENT_PROFILE_PATH },
      },
    });

    const conflict = await request(
      app,
      PROFILES_PATH,
      jsonApiRequest(
        "POST",
        createDocument({
          ...validCreateAttributes,
          firstName: "Grace",
          lastName: "Hopper",
          email: "grace@example.com",
        }),
      ),
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      errors: [
        {
          status: "409",
          code: "profile_conflict",
          detail: "Profile already exists",
        },
      ],
    });

    const get = await request(app, CURRENT_PROFILE_PATH, {
      headers: authenticatedHeaders(),
    });
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toEqual(initial);

    const head = await request(app, CURRENT_PROFILE_PATH, {
      method: "HEAD",
      headers: authenticatedHeaders(),
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe(JSON_API_MEDIA_TYPE);
    expect(await head.text()).toBe("");

    const noOpPatch = await request(
      app,
      CURRENT_PROFILE_PATH,
      jsonApiRequest("PATCH", updateDocument(owner)),
    );
    expect(noOpPatch.status).toBe(200);
    await expect(noOpPatch.json()).resolves.toEqual(initial);

    const updated = await request(
      app,
      CURRENT_PROFILE_PATH,
      jsonApiRequest("PATCH", updateDocument(owner, { firstName: "Grace", marketingOptIn: true })),
    );
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      data: {
        id: owner,
        attributes: {
          firstName: "Grace",
          marketingOptIn: true,
          createdAt: "2026-07-22T10:00:00.000Z",
          updatedAt: "2026-07-22T11:00:00.000Z",
        },
      },
    });

    const deleted = await request(app, CURRENT_PROFILE_PATH, {
      method: "DELETE",
      headers: authenticatedHeaders(),
    });
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get("Content-Type")).toBeNull();
    expect(await deleted.text()).toBe("");

    const missing = await request(app, CURRENT_PROFILE_PATH, {
      headers: authenticatedHeaders(),
    });
    expect(missing.status).toBe(404);
    expect(times).toHaveLength(0);
  });

  it("enforces method, negotiation, origin, and content policy before authentication", async () => {
    const verifier = vi.fn(async () => ({ sub: "unreachable" }));
    const app = createApp({ accessVerifier: verifier, maximumRequestBytes: 32 });

    const collectionMethod = await request(app, PROFILES_PATH, {
      method: "OPTIONS",
      headers: { Accept: JSON_API_MEDIA_TYPE },
    });
    expect(collectionMethod.status).toBe(405);
    expect(collectionMethod.headers.get("Allow")).toBe("POST");

    const resourceMethod = await request(app, CURRENT_PROFILE_PATH, {
      method: "OPTIONS",
      headers: { Accept: JSON_API_MEDIA_TYPE },
    });
    expect(resourceMethod.status).toBe(405);
    expect(resourceMethod.headers.get("Allow")).toBe("GET, HEAD, PATCH, DELETE");

    const unacceptable = await request(app, PROFILES_PATH, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    expect(unacceptable.status).toBe(406);
    await expect(unacceptable.json()).resolves.toMatchObject({
      errors: [{ source: { header: "Accept" } }],
    });

    const crossOrigin = await request(app, PROFILES_PATH, {
      method: "POST",
      headers: { Accept: JSON_API_MEDIA_TYPE, Origin: "https://attacker.invalid" },
    });
    expect(crossOrigin.status).toBe(403);
    await expect(crossOrigin.json()).resolves.toMatchObject({
      errors: [{ source: { header: "Origin" } }],
    });

    const unsupported = await request(app, PROFILES_PATH, {
      method: "POST",
      headers: {
        Accept: JSON_API_MEDIA_TYPE,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(unsupported.status).toBe(415);
    await expect(unsupported.json()).resolves.toMatchObject({
      errors: [{ source: { header: "Content-Type" } }],
    });

    const oversized = await request(app, PROFILES_PATH, {
      method: "POST",
      headers: {
        Accept: JSON_API_MEDIA_TYPE,
        "Content-Type": JSON_API_MEDIA_TYPE,
      },
      body: JSON.stringify({ data: { value: "larger than thirty-two bytes" } }),
    });
    expect(oversized.status).toBe(413);
    expect(verifier).not.toHaveBeenCalled();
  });

  it("authenticates before JSON syntax validation and never mutates malformed input", async () => {
    const owner = subject();
    trackedSubjects.add(owner);
    const verifier = vi.fn(async () => ({ sub: owner }));
    const app = createApp({ accessVerifier: verifier });
    const headers = {
      Accept: JSON_API_MEDIA_TYPE,
      "Cf-Access-Jwt-Assertion": "value-is-verified-by-test-seam",
      "Content-Type": JSON_API_MEDIA_TYPE,
    };
    const malformed = await request(app, PROFILES_PATH, {
      method: "POST",
      headers,
      body: "{",
    });
    expect(malformed.status).toBe(400);
    const empty = await request(app, PROFILES_PATH, {
      method: "POST",
      headers,
    });
    expect(empty.status).toBe(400);
    const duplicate = await request(app, PROFILES_PATH, {
      method: "POST",
      headers,
      body: `{"data":{"type":"profiles","attributes":${JSON.stringify(
        validCreateAttributes,
      ).replace('"termsAccepted":true', '"termsAccepted":false,"termsAccepted":true')}}}`,
    });
    expect(duplicate.status).toBe(400);
    const unpairedSurrogate = await request(app, PROFILES_PATH, {
      method: "POST",
      headers,
      body: String.raw`{"data":{"type":"profiles","attributes":{"firstName":"\uD800"}}}`,
    });
    expect(unpairedSurrogate.status).toBe(400);
    expect(verifier).toHaveBeenCalledTimes(4);
    const count = await database
      .prepare("SELECT COUNT(*) AS count FROM profiles WHERE id = ?")
      .bind(owner)
      .first<number>("count");
    expect(count).toBe(0);
  });

  it.each([
    [
      "create termsAccepted string",
      PROFILES_PATH,
      "POST",
      createDocument({ ...validCreateAttributes, termsAccepted: "true" }),
      "/data/attributes/termsAccepted",
    ],
    [
      "create numeric marketingOptIn",
      PROFILES_PATH,
      "POST",
      createDocument({ ...validCreateAttributes, marketingOptIn: 1 }),
      "/data/attributes/marketingOptIn",
    ],
    [
      "create Unicode phone digits",
      PROFILES_PATH,
      "POST",
      createDocument({ ...validCreateAttributes, phoneNumber: "+1١٢٣٤٥٦" }),
      "/data/attributes/phoneNumber",
    ],
    [
      "create name with surrounding whitespace",
      PROFILES_PATH,
      "POST",
      createDocument({ ...validCreateAttributes, firstName: " Ada " }),
      "/data/attributes/firstName",
    ],
    [
      "create name with a control character",
      PROFILES_PATH,
      "POST",
      createDocument({ ...validCreateAttributes, firstName: "Ada\nLovelace" }),
      "/data/attributes/firstName",
    ],
    [
      "create legacy snake-case member",
      PROFILES_PATH,
      "POST",
      createDocument({ ...validCreateAttributes, first_name: "legacy" }),
      "/data/attributes/first_name",
    ],
    [
      "patch explicit null",
      CURRENT_PROFILE_PATH,
      "PATCH",
      updateDocument("strict-shape-subject", { firstName: null }),
      "/data/attributes/firstName",
    ],
    [
      "patch immutable termsAccepted",
      CURRENT_PROFILE_PATH,
      "PATCH",
      updateDocument("strict-shape-subject", { termsAccepted: true }),
      "/data/attributes/termsAccepted",
    ],
    [
      "patch caller timestamp",
      CURRENT_PROFILE_PATH,
      "PATCH",
      updateDocument("strict-shape-subject", {
        updatedAt: "2026-07-22T12:00:00.000Z",
      }),
      "/data/attributes/updatedAt",
    ],
  ])(
    "rejects strict camelCase resource attributes without coercion: %s",
    async (_name, path, method, document, pointer) => {
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
      const response = await request(app, path, {
        method,
        headers: {
          Accept: JSON_API_MEDIA_TYPE,
          "Cf-Access-Jwt-Assertion": "test",
          "Content-Type": JSON_API_MEDIA_TYPE,
        },
        body: JSON.stringify(document),
      });
      const payload = (await response.json()) as {
        errors: Array<{ source?: { pointer?: string } }>;
      };

      expect(response.status).toBe(422);
      expect(payload.errors).toContainEqual(expect.objectContaining({ source: { pointer } }));
      expect(profileRepository.create).not.toHaveBeenCalled();
      expect(profileRepository.get).not.toHaveBeenCalled();
      expect(profileRepository.update).not.toHaveBeenCalled();
      expect(profileRepository.delete).not.toHaveBeenCalled();
    },
  );

  it("caps adversarial validation output without echoing submitted values or touching storage", async () => {
    const privateValue = "private-validation-value-marker";
    const unknownAttributes = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `unknown${String(index).padStart(3, "0")}`,
        privateValue,
      ]),
    );
    const profileRepository: ProfileRepository = {
      create: vi.fn(async () => undefined),
      get: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      delete: vi.fn(async () => false),
    };
    const app = createApp({
      accessVerifier: async () => ({ sub: "validation-limit-subject" }),
      profileRepositoryFactory: () => profileRepository,
    });

    const response = await request(
      app,
      PROFILES_PATH,
      jsonApiRequest("POST", createDocument({ ...validCreateAttributes, ...unknownAttributes }), {
        "Cf-Access-Jwt-Assertion": "test",
      }),
    );
    const document = (await response.json()) as {
      errors: Array<{ status: string; code: string; detail: string }>;
    };

    expect(response.status).toBe(422);
    expect(document.errors).toHaveLength(32);
    expect(document.errors.at(-1)).toMatchObject({
      status: "422",
      code: "validation_failed",
      detail: "Additional validation errors omitted",
    });
    expect(JSON.stringify(document)).not.toContain(privateValue);
    expect(profileRepository.create).not.toHaveBeenCalled();
    expect(profileRepository.get).not.toHaveBeenCalled();
    expect(profileRepository.update).not.toHaveBeenCalled();
    expect(profileRepository.delete).not.toHaveBeenCalled();
  });

  it.each([
    [
      "client-generated create ID",
      PROFILES_PATH,
      "POST",
      createDocument(validCreateAttributes, { id: crypto.randomUUID() }),
      403,
      "client_generated_id_unsupported",
    ],
    [
      "wrong create type",
      PROFILES_PATH,
      "POST",
      {
        data: {
          type: "people",
          attributes: validCreateAttributes,
        },
      },
      409,
      "resource_type_mismatch",
    ],
    [
      "wrong update type",
      CURRENT_PROFILE_PATH,
      "PATCH",
      {
        data: {
          type: "people",
          id: "strict-shape-subject",
          attributes: { firstName: "Grace" },
        },
      },
      409,
      "resource_type_mismatch",
    ],
    [
      "wrong update ID",
      CURRENT_PROFILE_PATH,
      "PATCH",
      updateDocument("another-subject", { firstName: "Grace" }),
      409,
      "resource_identity_mismatch",
    ],
  ])(
    "implements JSON:API identity conflict semantics: %s",
    async (_name, path, method, document, status, code) => {
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
      const response = await request(
        app,
        path,
        jsonApiRequest(method, document, {
          "Cf-Access-Jwt-Assertion": "test",
        }),
      );

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({
        errors: [{ status: String(status), code }],
      });
      expect(profileRepository.create).not.toHaveBeenCalled();
      expect(profileRepository.get).not.toHaveBeenCalled();
      expect(profileRepository.update).not.toHaveBeenCalled();
      expect(profileRepository.delete).not.toHaveBeenCalled();
    },
  );

  it("turns corrupt repository output into a generic JSON:API 500", async () => {
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
    const response = await request(app, CURRENT_PROFILE_PATH, {
      headers: { Accept: JSON_API_MEDIA_TYPE, "Cf-Access-Jwt-Assertion": "test" },
    });
    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).toBe(JSON_API_MEDIA_TYPE);
    expect(await response.text()).not.toContain("leak-marker");
  });

  it.each([
    [{ email: "ADA@EXAMPLE.COM" }, "ADA@EXAMPLE.COM"],
    [{ phoneNumber: " +358401234567 " }, "+358401234567"],
  ])("rejects output that would require request normalization", async (override, marker) => {
    const corruptRepository: ProfileRepository = {
      create: async () => undefined,
      get: async () => ({ ...storedProfile("subject"), ...override }),
      update: async () => undefined,
      delete: async () => false,
    };
    const app = createApp({
      accessVerifier: async () => ({ sub: "subject" }),
      profileRepositoryFactory: () => corruptRepository,
    });
    const response = await request(app, CURRENT_PROFILE_PATH, {
      headers: { Accept: JSON_API_MEDIA_TYPE, "Cf-Access-Jwt-Assertion": "test" },
    });

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(marker);
  });
});
