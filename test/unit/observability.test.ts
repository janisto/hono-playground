import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { enterSpanWith, type SpanName, type Tracer } from "../../src/core/tracing.js";
import type { RuntimeBindings } from "../../src/core/types.js";
import type { ProfileRepository } from "../../src/repositories/profile-repository.js";

const ORIGIN = "https://worker.example";
const RATE_LIMIT_KEY = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const AUDIT_KEY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SUBJECT = "profile-owner-marker";

const TEST_BINDINGS = {
  DB: {} as D1Database,
  ENVIRONMENT: "test",
  RATE_LIMIT_MODE: "none",
  RATE_LIMIT_KEY_HMAC_KEY: RATE_LIMIT_KEY,
  AUDIT_SUBJECT_HMAC_KEY: AUDIT_KEY,
} satisfies RuntimeBindings;

const STORED_PROFILE = {
  id: SUBJECT,
  firstName: "PrivateFirstNameMarker",
  lastName: "PrivateLastNameMarker",
  email: "private-email-marker@example.com",
  phoneNumber: "+358401111111",
  marketingOptIn: false,
  termsAccepted: true as const,
  createdAt: new Date("2026-07-22T12:00:00.000Z"),
  updatedAt: new Date("2026-07-22T12:00:00.000Z"),
};

const repository: ProfileRepository = {
  create: (id, input, timestamp) =>
    Promise.resolve({
      id,
      ...input,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  get: () => Promise.resolve(STORED_PROFILE),
  update: () => Promise.resolve(STORED_PROFILE),
  delete: () => Promise.resolve(true),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("structured application events", () => {
  it("emits exactly one fixed-schema access event for a successful invocation", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await createApp().request(
      new Request(`${ORIGIN}/health`, { headers: { "X-Request-ID": "access-event-id" } }),
      undefined,
      TEST_BINDINGS,
    );

    expect(response.status).toBe(200);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toEqual({
      schema_version: 1,
      event: "http.access",
      level: "info",
      request_id: "access-event-id",
      method: "GET",
      route_template: "/health",
      operation_id: "getHealth",
      status: 200,
      latency_ms: expect.any(Number),
      outcome: "ok",
      environment: "test",
    });
  });

  it("uses unmatched labels and a non-success outcome without logging an attacker path", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const privateMarker = "private-path-marker@example.com";
    const response = await createApp().request(
      new Request(`${ORIGIN}/${privateMarker}?token=private-query-marker`, {
        headers: { "X-Request-ID": "unmatched-event-id" },
      }),
      undefined,
      TEST_BINDINGS,
    );

    expect(response.status).toBe(404);
    expect(log).toHaveBeenCalledOnce();
    const event = log.mock.calls[0]?.[0];
    expect(event).toEqual({
      schema_version: 1,
      event: "http.access",
      level: "warn",
      request_id: "unmatched-event-id",
      method: "GET",
      route_template: "unmatched",
      operation_id: "unmatched",
      status: 404,
      latency_ms: expect.any(Number),
      outcome: "not_found",
      environment: "test",
    });
    expect(JSON.stringify(event)).not.toContain(privateMarker);
    expect(JSON.stringify(event)).not.toContain("private-query-marker");
  });

  it("emits a pseudonymous mutation audit event without profile or subject values", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const application = createApp({
      accessVerifier: () => Promise.resolve({ sub: SUBJECT }),
      profileRepositoryFactory: () => repository,
      now: () => new Date("2026-07-22T12:00:00.000Z"),
    });
    const response = await application.request(
      new Request(`${ORIGIN}/v1/profiles`, {
        method: "POST",
        headers: {
          Accept: "application/vnd.api+json",
          "Content-Type": "application/vnd.api+json",
          "X-Request-ID": "audit-event-id",
        },
        body: JSON.stringify({
          data: {
            type: "profiles",
            attributes: {
              firstName: STORED_PROFILE.firstName,
              lastName: STORED_PROFILE.lastName,
              email: STORED_PROFILE.email,
              phoneNumber: STORED_PROFILE.phoneNumber,
              termsAccepted: true,
            },
          },
        }),
      }),
      undefined,
      TEST_BINDINGS,
    );

    expect(response.status).toBe(201);
    expect(log).toHaveBeenCalledTimes(2);
    const events = log.mock.calls.map(([event]) => event as Record<string, unknown> & { event?: unknown });
    const audit = events.find((event) => event.event === "profile.audit");
    const access = events.find((event) => event.event === "http.access");
    expect(audit).toEqual({
      schema_version: 1,
      event: "profile.audit",
      level: "info",
      action: "create",
      result: "success",
      request_id: "audit-event-id",
      owner: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(access).toMatchObject({
      route_template: "/v1/profiles",
      operation_id: "createProfile",
      outcome: "ok",
      status: 201,
    });

    const serializedEvents = JSON.stringify(events);
    for (const privateValue of [
      SUBJECT,
      STORED_PROFILE.firstName,
      STORED_PROFILE.lastName,
      STORED_PROFILE.email,
      STORED_PROFILE.phoneNumber,
    ]) {
      expect(serializedEvents).not.toContain(privateValue);
    }
  });

  it.each([
    ["conflicting", () => Promise.resolve(undefined), 409],
    ["failed", () => Promise.reject(new Error("private-repository-failure-marker")), 500],
  ])("never emits a success audit event for a %s profile create", async (_condition, create, expectedStatus) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const application = createApp({
      accessVerifier: () => Promise.resolve({ sub: SUBJECT }),
      profileRepositoryFactory: () => ({ ...repository, create }),
      now: () => new Date("2026-07-22T12:00:00.000Z"),
    });
    const response = await application.request(
      new Request(`${ORIGIN}/v1/profiles`, {
        method: "POST",
        headers: {
          Accept: "application/vnd.api+json",
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            type: "profiles",
            attributes: {
              firstName: "Ada",
              lastName: "Lovelace",
              email: "ada@example.com",
              phoneNumber: "+12025550123",
              termsAccepted: true,
            },
          },
        }),
      }),
      undefined,
      TEST_BINDINGS,
    );

    expect(response.status).toBe(expectedStatus);
    const events = [...log.mock.calls, ...errorLog.mock.calls].map(([event]) => event);
    expect(events).not.toContainEqual(expect.objectContaining({ event: "profile.audit", result: "success" }));
    expect(JSON.stringify(events)).not.toContain("private-repository-failure-marker");
  });

  it("does not fabricate D1 scan or write counts from returned rows", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const application = createApp({
      accessVerifier: () => Promise.resolve({ sub: SUBJECT }),
      profileRepositoryFactory: () => ({
        ...repository,
        get: () => Promise.resolve(STORED_PROFILE),
      }),
    });
    const response = await application.request(
      new Request(`${ORIGIN}/v1/profiles/current`, {
        headers: { Accept: "application/vnd.api+json", "X-Request-ID": "d1-event-id" },
      }),
      undefined,
      TEST_BINDINGS,
    );

    expect(response.status).toBe(200);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toMatchObject({
      event: "http.access",
      request_id: "d1-event-id",
    });
    expect(log.mock.calls[0]?.[0]).not.toHaveProperty("d1_query_count");
    expect(log.mock.calls[0]?.[0]).not.toHaveProperty("d1_rows_read");
    expect(log.mock.calls[0]?.[0]).not.toHaveProperty("d1_rows_written");
    expect(JSON.stringify(log.mock.calls)).not.toContain(SUBJECT);
  });

  it("allows only validated platform metadata and never logs caller trace context", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const response = await createApp().request(
      new Request(`${ORIGIN}/health`, {
        headers: {
          "CF-Ray": "0123456789abcdef-HEL",
          traceparent,
          "X-Request-ID": "metadata-event-id",
        },
      }),
      undefined,
      {
        ...TEST_BINDINGS,
        CF_VERSION_METADATA: {
          id: "worker-version-id",
          tag: "release-1",
          timestamp: "2026-07-22T12:00:00.000Z",
        },
      },
    );

    expect(response.status).toBe(200);
    expect(log.mock.calls[0]?.[0]).toMatchObject({
      cf_ray: "0123456789abcdef-HEL",
      worker_version_id: "worker-version-id",
      worker_version_tag: "release-1",
    });
    expect(JSON.stringify(log.mock.calls[0]?.[0])).not.toContain(traceparent);
    expect(log.mock.calls[0]?.[0]).not.toHaveProperty("inbound_trace_id");
    expect(log.mock.calls[0]?.[0]).not.toHaveProperty("inbound_parent_span_id");
  });

  it("omits malformed inbound metadata and logs a stable configuration code", async () => {
    const privateMarker = "attacker-controlled-metadata-marker";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const malformedMetadata = await createApp().request(
      new Request(`${ORIGIN}/health`, {
        headers: { "CF-Ray": privateMarker, traceparent: privateMarker },
      }),
      undefined,
      TEST_BINDINGS,
    );
    const misconfigured = await createApp().request(
      new Request(`${ORIGIN}/health`, {
        headers: { "X-Request-ID": "config-error-id" },
      }),
      undefined,
      {
        ...TEST_BINDINGS,
        ENVIRONMENT: privateMarker,
      },
    );

    expect(malformedMetadata.status).toBe(200);
    expect(misconfigured.status).toBe(500);
    const events = [...log.mock.calls, ...errorLog.mock.calls].map(([event]) => event);
    expect(events).toContainEqual({
      schema_version: 1,
      event: "operator.error",
      level: "error",
      code: "runtime_configuration_invalid",
      request_id: "config-error-id",
    });
    expect(JSON.stringify(events)).not.toContain(privateMarker);
    expect(JSON.stringify(log.mock.calls[0]?.[0])).not.toContain("cf_ray");
    expect(JSON.stringify(log.mock.calls[0]?.[0])).not.toContain("inbound_trace_id");
  });

  it("fails an explicitly empty audit secret before a profile mutation", async () => {
    const create = vi.fn(() => Promise.resolve(STORED_PROFILE));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const application = createApp({
      accessVerifier: () => Promise.resolve({ sub: SUBJECT }),
      profileRepositoryFactory: () => ({ ...repository, create }),
      now: () => new Date("2026-07-22T12:00:00.000Z"),
    });
    const response = await application.request(
      new Request(`${ORIGIN}/v1/profiles`, {
        method: "POST",
        headers: {
          Accept: "application/vnd.api+json",
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            type: "profiles",
            attributes: {
              firstName: "Ada",
              lastName: "Lovelace",
              email: "ada@example.com",
              phoneNumber: "+12025550123",
              termsAccepted: true,
            },
          },
        }),
      }),
      undefined,
      { ...TEST_BINDINGS, AUDIT_SUBJECT_HMAC_KEY: "" },
    );

    expect(response.status).toBe(500);
    expect(create).not.toHaveBeenCalled();
  });

  it("fails a non-test profile mutation when the audit secret is absent", async () => {
    const create = vi.fn(() => Promise.resolve(STORED_PROFILE));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const application = createApp({
      accessVerifier: () => Promise.resolve({ sub: SUBJECT }),
      profileRepositoryFactory: () => ({ ...repository, create }),
      now: () => new Date("2026-07-22T12:00:00.000Z"),
    });
    const response = await application.request(
      new Request(`${ORIGIN}/v1/profiles`, {
        method: "POST",
        headers: {
          Accept: "application/vnd.api+json",
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            type: "profiles",
            attributes: {
              firstName: "Ada",
              lastName: "Lovelace",
              email: "ada@example.com",
              phoneNumber: "+12025550123",
              termsAccepted: true,
            },
          },
        }),
      }),
      undefined,
      {
        ...TEST_BINDINGS,
        ENVIRONMENT: "development",
        AUDIT_SUBJECT_HMAC_KEY: undefined,
      },
    );

    expect(response.status).toBe(500);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a mismatched PATCH identity before evaluating the audit secret", async () => {
    const update = vi.fn(() => Promise.resolve(STORED_PROFILE));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const application = createApp({
      accessVerifier: () => Promise.resolve({ sub: SUBJECT }),
      profileRepositoryFactory: () => ({ ...repository, update }),
    });
    const response = await application.request(
      new Request(`${ORIGIN}/v1/profiles/current`, {
        method: "PATCH",
        headers: {
          Accept: "application/vnd.api+json",
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            type: "profiles",
            id: "different-owner",
            attributes: { firstName: "Grace" },
          },
        }),
      }),
      undefined,
      {
        ...TEST_BINDINGS,
        ENVIRONMENT: "development",
        AUDIT_SUBJECT_HMAC_KEY: undefined,
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      errors: [{ code: "resource_identity_mismatch" }],
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps public routes healthy but fails a missing profile DB binding with a stable code", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bindingsWithoutDatabase = {
      ENVIRONMENT: "test",
      RATE_LIMIT_MODE: "none",
    } as unknown as RuntimeBindings;
    const application = createApp({ accessVerifier: () => Promise.resolve({ sub: SUBJECT }) });

    const publicResponse = await application.request(
      new Request(`${ORIGIN}/health`),
      undefined,
      bindingsWithoutDatabase,
    );
    const profileResponse = await application.request(
      new Request(`${ORIGIN}/v1/profiles/current`, {
        headers: {
          Accept: "application/vnd.api+json",
          "X-Request-ID": "missing-database-id",
        },
      }),
      undefined,
      bindingsWithoutDatabase,
    );

    expect(publicResponse.status).toBe(200);
    expect(profileResponse.status).toBe(500);
    expect(errorLog).toHaveBeenCalledWith({
      schema_version: 1,
      event: "operator.error",
      level: "error",
      code: "runtime_configuration_invalid",
      request_id: "missing-database-id",
    });
  });
});

describe("custom span wrapper", () => {
  it("uses only the fixed names and preserves callback values", () => {
    const names: string[] = [];
    const span = { isTraced: true, setAttribute: vi.fn() };
    const tracer: Tracer = {
      enterSpan(name, callback) {
        names.push(name);
        return callback(span);
      },
    };
    const spanNames = [
      "access.verify",
      "profile.service",
      "profile.repository",
      "response.validate",
    ] as const satisfies readonly SpanName[];

    const values = spanNames.map((name) => enterSpanWith(tracer, name, (activeSpan) => activeSpan?.isTraced));

    expect(names).toEqual(spanNames);
    expect(values).toEqual([true, true, true, true]);
    expect(span.setAttribute).not.toHaveBeenCalled();
  });

  it("preserves errors and has a behaviorally equivalent no-op path", () => {
    const failure = new Error("span callback failure");
    const span = { isTraced: true, setAttribute: vi.fn() };
    const tracer: Tracer = {
      enterSpan(_name, callback) {
        return callback(span);
      },
    };

    expect(() =>
      enterSpanWith(tracer, "response.validate", () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(enterSpanWith(undefined, "response.validate", (activeSpan) => activeSpan)).toBeUndefined();
    expect(() =>
      enterSpanWith(undefined, "response.validate", () => {
        throw failure;
      }),
    ).toThrow(failure);
  });
});
