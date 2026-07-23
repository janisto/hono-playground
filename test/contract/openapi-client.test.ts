import { env } from "cloudflare:workers";
import createClient from "openapi-fetch";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import type { RuntimeBindings } from "../../src/core/types.js";
import type { paths } from "../generated/openapi.js";

const origin = "https://worker.test";
const application = createApp();

const client = createClient<paths>({
  baseUrl: origin,
  fetch: async (request) => application.fetch(request, env as never),
});

const nextLink = (header: string | null): URL => {
  const match = /<([^>]+)>;\s*rel="next"/.exec(header ?? "");
  const target = match?.[1];
  if (target === undefined) throw new Error("Response did not contain a next link");
  return new URL(target, origin);
};

describe("generated openapi-fetch consumer", () => {
  it("calls the health operation through only the generated paths type", async () => {
    const { data, error, response } = await client.GET("/health");

    expect(response.status).toBe(200);
    expect(error).toBeUndefined();
    expect(data).toEqual({ status: "healthy" });
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("follows the item operation's returned next link", async () => {
    const first = await client.GET("/v1/items", {
      params: { query: { category: "electronics", limit: 2 } },
    });

    expect(first.response.status).toBe(200);
    expect(first.error).toBeUndefined();
    expect(first.data?.items.map((item) => item.id)).toEqual(["item-001", "item-002"]);
    expect(first.data?.total).toBe(13);

    const next = nextLink(first.response.headers.get("link"));
    expect(next.pathname).toBe("/v1/items");
    const category = next.searchParams.get("category");
    const cursor = next.searchParams.get("cursor");
    if (category !== "electronics" || cursor === null) {
      throw new Error("Next link did not preserve the typed item query");
    }
    const second = await client.GET("/v1/items", {
      params: {
        query: {
          category,
          limit: Number(next.searchParams.get("limit")),
          cursor,
        },
      },
    });

    expect(second.response.status).toBe(200);
    expect(second.error).toBeUndefined();
    expect(second.data?.items.map((item) => item.id)).toEqual(["item-004", "item-005"]);
    expect(second.data?.total).toBe(13);
  });

  it("decodes a typed validation Problem from an invalid generated operation request", async () => {
    const { data, error, response } = await client.POST("/v1/hello", {
      body: { language: "en", name: "" },
    });

    expect(response.status).toBe(422);
    expect(data).toBeUndefined();
    expect(error).toEqual({
      title: "Unprocessable Entity",
      status: 422,
      detail: "validation failed",
      errors: [
        {
          location: "body.name",
          message: "String should have at least 1 character",
        },
      ],
    });
    expect(response.headers.get("content-type")).toContain("application/problem+json");
  });

  it("follows the returned profile location through an injected-verifier lifecycle", async () => {
    const subject = `generated-client-${crypto.randomUUID()}`;
    const profileApplication = createApp({
      accessVerifier: async () => ({ sub: subject }),
      now: () => new Date("2026-07-22T12:00:00.000Z"),
    });
    const bindings = new Proxy(env as unknown as RuntimeBindings, {
      get(target, property, receiver) {
        if (property === "RATE_LIMIT_MODE") return "none";
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const profileClient = createClient<paths>({
      baseUrl: origin,
      fetch: async (request) => profileApplication.fetch(request, bindings),
    });

    const created = await profileClient.POST("/v1/profile", {
      body: {
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@example.com",
        phone_number: "+358401234567",
        terms: true,
      },
    });
    expect(created.response.status).toBe(201);
    expect(created.error).toBeUndefined();
    expect(created.data).toMatchObject({ id: subject, first_name: "Ada", marketing: false });

    const location = created.response.headers.get("location");
    if (location !== "/v1/profile") {
      throw new Error("Created profile did not return the generated profile path");
    }

    const fetched = await profileClient.GET(location);
    expect(fetched.response.status).toBe(200);
    expect(fetched.error).toBeUndefined();
    expect(fetched.data).toEqual(created.data);

    const updated = await profileClient.PATCH(location, {
      body: { first_name: "Grace", marketing: true },
    });
    expect(updated.response.status).toBe(200);
    expect(updated.error).toBeUndefined();
    expect(updated.data).toMatchObject({ id: subject, first_name: "Grace", marketing: true });

    const deleted = await profileClient.DELETE(location);
    expect(deleted.response.status).toBe(204);
    expect(deleted.error).toBeUndefined();

    const missing = await profileClient.GET(location);
    expect(missing.response.status).toBe(404);
    expect(missing.data).toBeUndefined();
    expect(missing.error).toMatchObject({ status: 404, detail: "Profile not found" });
  });
});
