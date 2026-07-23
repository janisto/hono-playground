import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { normalizeClientIp } from "../../src/core/rate-limit.js";
import type { RuntimeBindings } from "../../src/core/types.js";
import type { ProfileRepository } from "../../src/repositories/profile-repository.js";

const ORIGIN = "https://worker.example";
const RATE_KEY = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const SUBJECT = "rate-limit-profile-owner";

const limiter = (implementation: (input: { key: string }) => Promise<{ success: boolean }>) =>
  ({ limit: vi.fn(implementation) }) as unknown as RateLimit;

const bindings = (overrides: Partial<RuntimeBindings> = {}): RuntimeBindings => ({
  DB: {} as D1Database,
  ENVIRONMENT: "test",
  DEPLOYMENT_PROFILE: "workers-dev-demo",
  LOG_LEVEL: "error",
  MANAGED_OAUTH_ENABLED: "false",
  RATE_LIMIT_MODE: "workers-binding",
  RATE_LIMIT_KEY_HMAC_KEY: RATE_KEY,
  ...overrides,
});

const storedProfile = {
  id: SUBJECT,
  first_name: "Ada",
  last_name: "Lovelace",
  email: "ada@example.com",
  phone_number: "+358401234567",
  marketing: false,
  terms: true as const,
  created_at: "2026-07-22T12:00:00.000Z",
  updated_at: "2026-07-22T12:00:00.000Z",
};

const repository = (): ProfileRepository => ({
  create: vi.fn(() => Promise.resolve(storedProfile)),
  get: vi.fn(() => Promise.resolve(storedProfile)),
  update: vi.fn(() => Promise.resolve(storedProfile)),
  delete: vi.fn(() => Promise.resolve(true)),
});

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("client IP normalization", () => {
  it.each([
    ["192.0.2.1", "192.0.2.1"],
    ["192.000.002.001", "192.0.2.1"],
    ["2001:0db8:0:0:0:0:0:1", "2001:db8::1"],
    ["::ffff:192.0.2.1", "::ffff:c000:201"],
    [undefined, undefined],
    ["", undefined],
    [" 192.0.2.1", undefined],
    ["999.0.0.1", undefined],
    ["not-an-ip", undefined],
    ["2001:db8::1%zone", undefined],
  ])("normalizes only a bounded IP literal: %s", (input, expected) => {
    expect(normalizeClientIp(input)).toBe(expected);
  });
});

describe("public limiter contract", () => {
  it("uses a full HMAC key and preserves an allowed response", async () => {
    const publicLimiter = limiter(() => Promise.resolve({ success: true }));
    const response = await createApp().request(
      new Request(`${ORIGIN}/health`, { headers: { "CF-Connecting-IP": "192.0.2.1" } }),
      undefined,
      bindings({ PUBLIC_RATE_LIMITER: publicLimiter }),
    );

    expect(response.status).toBe(200);
    const limit = vi.mocked(publicLimiter.limit);
    expect(limit).toHaveBeenCalledOnce();
    const key = limit.mock.calls[0]?.[0].key;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("192.0.2.1");
  });

  it("returns the literal 429 contract with Retry-After", async () => {
    const publicLimiter = limiter(() => Promise.resolve({ success: false }));
    const response = await createApp().request(
      new Request(`${ORIGIN}/health`, { headers: { "CF-Connecting-IP": "192.0.2.1" } }),
      undefined,
      bindings({ PUBLIC_RATE_LIMITER: publicLimiter }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.json()).toEqual({
      title: "Too Many Requests",
      status: 429,
      detail: "Rate limit exceeded",
    });
  });

  it("fails open only for a binding exception and emits a safe operator code", async () => {
    const publicLimiter = limiter(() => Promise.reject(new Error("private binding message")));
    const response = await createApp().request(
      new Request(`${ORIGIN}/health`, { headers: { "CF-Connecting-IP": "192.0.2.1" } }),
      undefined,
      bindings({ PUBLIC_RATE_LIMITER: publicLimiter }),
    );

    expect(response.status).toBe(200);
    expect(errorLog).toHaveBeenCalledWith({
      schema_version: 1,
      event: "operator.error",
      level: "error",
      code: "public_limiter_unavailable",
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("private binding message");
  });

  it("uses one unknown bucket and warns safely for missing or malformed production IPs", async () => {
    const publicLimiter = limiter(() => Promise.resolve({ success: true }));
    const productionBindings = bindings({
      ENVIRONMENT: "production",
      PUBLIC_RATE_LIMITER: publicLimiter,
    });

    for (const header of [undefined, "attacker-controlled-marker"]) {
      const headers = header === undefined ? {} : { "CF-Connecting-IP": header };
      const response = await createApp().request(
        new Request(`${ORIGIN}/health`, { headers }),
        undefined,
        productionBindings,
      );
      expect(response.status).toBe(200);
    }

    const limit = vi.mocked(publicLimiter.limit);
    expect(limit).toHaveBeenCalledTimes(2);
    expect(limit.mock.calls[0]?.[0].key).toBe(limit.mock.calls[1]?.[0].key);
    expect(errorLog).toHaveBeenCalledTimes(2);
    for (const [event] of errorLog.mock.calls) {
      expect(event).toEqual({
        schema_version: 1,
        event: "operator.error",
        level: "error",
        code: "public_client_ip_unavailable",
      });
    }
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("attacker-controlled-marker");
  });

  it("treats a missing HMAC key as configuration failure rather than binding failure", async () => {
    const publicLimiter = limiter(() => Promise.resolve({ success: true }));
    const missingKeyBindings = bindings({ PUBLIC_RATE_LIMITER: publicLimiter });
    delete missingKeyBindings.RATE_LIMIT_KEY_HMAC_KEY;
    const response = await createApp().request(
      new Request(`${ORIGIN}/health`, { headers: { "CF-Connecting-IP": "192.0.2.1" } }),
      undefined,
      missingKeyBindings,
    );

    expect(response.status).toBe(500);
    expect(publicLimiter.limit).not.toHaveBeenCalled();
  });

  it("treats malformed binding output as a safe fail-open dependency error", async () => {
    const malformedLimiter = {
      limit: vi.fn(() => Promise.resolve({ success: "not-a-boolean" })),
    } as unknown as RateLimit;
    const response = await createApp().request(
      new Request(`${ORIGIN}/health`, { headers: { "CF-Connecting-IP": "192.0.2.1" } }),
      undefined,
      bindings({ PUBLIC_RATE_LIMITER: malformedLimiter }),
    );

    expect(response.status).toBe(200);
    expect(errorLog).toHaveBeenCalledWith({
      schema_version: 1,
      event: "operator.error",
      level: "error",
      code: "public_limiter_unavailable",
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("invalid result");
  });

  it.each(["/api-docs", "/openapi.json", "/schemas/HealthResponse.json"])(
    "limits the dynamic documentation route while static assets stay outside the Worker: %s",
    async (path) => {
      const publicLimiter = limiter(() => Promise.resolve({ success: false }));
      const response = await createApp().request(
        new Request(`${ORIGIN}${path}`, { headers: { "CF-Connecting-IP": "192.0.2.1" } }),
        undefined,
        bindings({ PUBLIC_RATE_LIMITER: publicLimiter }),
      );

      expect(response.status).toBe(429);
      expect(publicLimiter.limit).toHaveBeenCalledOnce();
    },
  );

  it("denies a body-bearing public request before pulling its stream", async () => {
    let pulls = 0;
    const publicLimiter = limiter(() => Promise.resolve({ success: false }));
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new TextEncoder().encode('{"name":"Ada","language":"en"}'));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const response = await createApp().request(
      new Request(`${ORIGIN}/v1/hello`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "CF-Connecting-IP": "192.0.2.1",
          "Content-Type": "application/json",
        },
        body,
      }),
      undefined,
      bindings({ PUBLIC_RATE_LIMITER: publicLimiter }),
    );

    expect(response.status).toBe(429);
    expect(pulls).toBe(0);
  });
});

describe("profile limiter contract", () => {
  it("fails a denied read before repository access", async () => {
    const profileRepository = repository();
    const readLimiter = limiter(() => Promise.resolve({ success: false }));
    const application = createApp({
      accessVerifier: () => Promise.resolve({ sub: SUBJECT }),
      profileRepositoryFactory: () => profileRepository,
    });
    const response = await application.request(
      new Request(`${ORIGIN}/v1/profile`, { headers: { Accept: "application/json" } }),
      undefined,
      bindings({ PROFILE_READ_RATE_LIMITER: readLimiter }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(profileRepository.get).not.toHaveBeenCalled();
  });

  it("fails a binding error closed before parsing or repository access", async () => {
    const profileRepository = repository();
    const writeLimiter = limiter(() => Promise.reject(new Error("private limiter failure")));
    const application = createApp({
      accessVerifier: () => Promise.resolve({ sub: SUBJECT }),
      profileRepositoryFactory: () => profileRepository,
    });
    const response = await application.request(
      new Request(`${ORIGIN}/v1/profile`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: "{}",
      }),
      undefined,
      bindings({ PROFILE_WRITE_RATE_LIMITER: writeLimiter }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(await response.json()).toMatchObject({
      title: "Service Unavailable",
      status: 503,
      detail: "Rate limiter unavailable",
    });
    expect(profileRepository.create).not.toHaveBeenCalled();
  });

  it("fails a read binding error closed before repository access", async () => {
    const profileRepository = repository();
    const readLimiter = limiter(() => Promise.reject(new Error("private limiter failure")));
    const application = createApp({
      accessVerifier: () => Promise.resolve({ sub: SUBJECT }),
      profileRepositoryFactory: () => profileRepository,
    });
    const response = await application.request(
      new Request(`${ORIGIN}/v1/profile`, { headers: { Accept: "application/json" } }),
      undefined,
      bindings({ PROFILE_READ_RATE_LIMITER: readLimiter }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(profileRepository.get).not.toHaveBeenCalled();
  });

  it("fails malformed profile binding output closed", async () => {
    const profileRepository = repository();
    const malformedLimiter = {
      limit: vi.fn(() => Promise.resolve({ success: "not-a-boolean" })),
    } as unknown as RateLimit;
    const application = createApp({
      accessVerifier: () => Promise.resolve({ sub: SUBJECT }),
      profileRepositoryFactory: () => profileRepository,
    });
    const response = await application.request(
      new Request(`${ORIGIN}/v1/profile`, { headers: { Accept: "application/json" } }),
      undefined,
      bindings({ PROFILE_READ_RATE_LIMITER: malformedLimiter }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(profileRepository.get).not.toHaveBeenCalled();
  });

  it("fails a denied write before parsing or repository access", async () => {
    const profileRepository = repository();
    const writeLimiter = limiter(() => Promise.resolve({ success: false }));
    const application = createApp({
      accessVerifier: () => Promise.resolve({ sub: SUBJECT }),
      profileRepositoryFactory: () => profileRepository,
    });
    const response = await application.request(
      new Request(`${ORIGIN}/v1/profile`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: "{}",
      }),
      undefined,
      bindings({ PROFILE_WRITE_RATE_LIMITER: writeLimiter }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(profileRepository.create).not.toHaveBeenCalled();
  });

  it("separates read and write HMAC domains without exposing the subject", async () => {
    const profileRepository = repository();
    const readLimiter = limiter(() => Promise.resolve({ success: true }));
    const writeLimiter = limiter(() => Promise.resolve({ success: true }));
    const application = createApp({
      accessVerifier: () => Promise.resolve({ sub: SUBJECT }),
      profileRepositoryFactory: () => profileRepository,
      now: () => new Date("2026-07-22T12:00:00.000Z"),
    });

    const read = await application.request(
      new Request(`${ORIGIN}/v1/profile`, { headers: { Accept: "application/json" } }),
      undefined,
      bindings({
        PROFILE_READ_RATE_LIMITER: readLimiter,
        PROFILE_WRITE_RATE_LIMITER: writeLimiter,
      }),
    );
    const write = await application.request(
      new Request(`${ORIGIN}/v1/profile`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          first_name: "Ada",
          last_name: "Lovelace",
          email: "ada@example.com",
          phone_number: "+358401234567",
          terms: true,
        }),
      }),
      undefined,
      bindings({
        PROFILE_READ_RATE_LIMITER: readLimiter,
        PROFILE_WRITE_RATE_LIMITER: writeLimiter,
      }),
    );

    expect(read.status).toBe(200);
    expect(write.status).toBe(201);
    const readKey = vi.mocked(readLimiter.limit).mock.calls[0]?.[0].key;
    const writeKey = vi.mocked(writeLimiter.limit).mock.calls[0]?.[0].key;
    expect(readKey).toMatch(/^[0-9a-f]{64}$/);
    expect(writeKey).toMatch(/^[0-9a-f]{64}$/);
    expect(readKey).not.toBe(writeKey);
    expect(`${readKey}${writeKey}`).not.toContain(SUBJECT);
  });
});
