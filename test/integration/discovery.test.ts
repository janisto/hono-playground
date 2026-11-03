import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import indexGuide from "../../llms.txt?raw";
import fullGuide from "../../llms-full.txt?raw";
import { createApp } from "../../src/app.ts";
import type { RuntimeBindings } from "../../src/core/types.ts";

const ORIGIN = "https://worker.example";
const CATALOG_TYPE = 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';
const INDEX_LINK = { target: "/llms.txt", relation: "describedby", type: "text/plain" };
const CATALOG_LINK = { target: "/.well-known/api-catalog", relation: "api-catalog", type: "application/linkset+json" };
const SCHEMA_LINK = { target: "/openapi.json", relation: "service-desc", type: "application/json" };
const unavailable = vi.fn(async () => {
  throw new Error("discovery called an unavailable dependency");
});
const blockedBinding = vi.fn((name: PropertyKey): never => {
  throw new Error(`discovery read ${String(name)}`);
});
const bindings = new Proxy(env as unknown as RuntimeBindings, {
  get(target, property, receiver) {
    if (
      [
        "DB",
        "ACCESS_TEAM_DOMAIN",
        "ACCESS_AUD",
        "PUBLIC_RATE_LIMITER",
        "PROFILE_READ_RATE_LIMITER",
        "PROFILE_WRITE_RATE_LIMITER",
      ].includes(String(property))
    ) {
      return blockedBinding(property);
    }
    return Reflect.get(target, property, receiver) as unknown;
  },
});
const app = createApp({
  accessVerifier: unavailable,
  profileRepositoryFactory: () => blockedBinding("profile repository"),
  githubClientOptions: { fetch: unavailable },
});
const request = (path: string, init: RequestInit = {}) =>
  app.request(new Request(`${ORIGIN}${path}`, init), undefined, bindings);
const links = (response: Response) =>
  [...(response.headers.get("Link") ?? "").matchAll(/<([^>]+)>;\s*rel="([^"]+)"(?:;\s*type="([^"]+)")?/gu)].map(
    (match) => ({ target: match[1], relation: match[2], type: match[3] }),
  );

describe("public API discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    expect(unavailable).not.toHaveBeenCalled();
    expect(blockedBinding).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("bootstraps schema, guides, and health from the origin without dependencies", async () => {
    const response = await request("/.well-known/api-catalog");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(CATALOG_TYPE);
    expect(links(response)).toEqual(expect.arrayContaining([CATALOG_LINK, INDEX_LINK]));
    const catalog = await response.json<{
      linkset: {
        anchor: string;
        "service-desc": { href: string; type: string }[];
        "service-doc": { href: string; type: string }[];
        status: { href: string; type: string }[];
      }[];
    }>();
    expect(Object.keys(catalog)).toEqual(["linkset"]);
    expect(catalog.linkset).toHaveLength(1);
    const context = catalog.linkset.at(0);
    if (context === undefined) throw new Error("catalog has no application context");
    expect(new URL(context.anchor, `${ORIGIN}/.well-known/api-catalog`).href).toBe(`${ORIGIN}/`);
    expect(context["service-desc"]).toEqual([{ href: "/openapi.json", type: "application/json" }]);
    expect(context["service-doc"]).toEqual(
      expect.arrayContaining([
        { href: "/llms.txt", type: "text/plain" },
        { href: "/llms-full.txt", type: "text/plain" },
      ]),
    );
    expect(context.status).toEqual([{ href: "/health", type: "application/json" }]);
    await Promise.all(
      [...context["service-desc"], ...context["service-doc"], ...context.status].map(async (target) => {
        const url = new URL(target.href, `${ORIGIN}/.well-known/api-catalog`);
        expect(url.origin).toBe(ORIGIN);
        const found = await request(url.pathname, { headers: { Accept: target.type } });
        expect(found.status).toBe(200);
        expect(found.headers.get("Content-Type")).toContain(target.type);
      }),
    );
  });

  it.each([
    ["/llms.txt", indexGuide],
    ["/llms-full.txt", fullGuide],
  ])("serves unchanged same-build guide bytes at %s", async (path, content) => {
    const incoming = new Request(`${ORIGIN}${path}`, {
      headers: {
        Accept: "text/plain; charset=utf-8",
        "Cf-Access-Jwt-Assertion": "invalid",
        "Content-Type": "application/cbor",
        "Content-Encoding": "gzip",
        "Content-Length": "1000001",
      },
    });
    const response = await app.request(incoming, undefined, bindings);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("Content-Length")).toBe(String(new TextEncoder().encode(content).byteLength));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Request-ID")).toMatch(/^[0-9a-f]{32}$/u);
    expect(response.headers.get("Vary")).toContain("Accept");
    expect(content).toMatch(/^# Hono Playground API/u);
    expect(await response.text()).toBe(content);
    expect(incoming.bodyUsed).toBe(false);
  });

  it("preserves catalog GET metadata in bodyless HEAD responses", async () => {
    const get = await request("/.well-known/api-catalog");
    const head = await request("/.well-known/api-catalog", { method: "HEAD" });
    expect(head.status).toBe(200);
    for (const name of ["Content-Type", "Content-Length", "Link", "Cache-Control", "Vary"])
      expect(head.headers.get(name)).toBe(get.headers.get(name));
    expect(head.headers.get("Content-Length")).toBe(String(new TextEncoder().encode(await get.text()).byteLength));
    expect(links(head)).toEqual(expect.arrayContaining([CATALOG_LINK, INDEX_LINK]));
    expect(await head.text()).toBe("");
  });

  it.each([
    ["application/linkset+json", 200],
    ['application/linkset+json;profile="https://www.rfc-editor.org/info/rfc9727"', 200],
    ['application/linkset+json;q=1;profile="https://www.rfc-editor.org/info/rfc9727"', 200],
    ['application/linkset+json;profile="https://invalid.example";q=1', 406],
    ['application/linkset+json;q=1;profile="https://invalid.example"', 406],
    ['application/linkset+json;q=0;profile="https://www.rfc-editor.org/info/rfc9727", */*;q=1', 406],
    ["application/linkset+json;q=1;unknown=ignored", 406],
    ["application/json", 406],
  ] as const)("negotiates catalog %s as %s", async (accept, status) => {
    const response = await request("/.well-known/api-catalog", { headers: { Accept: accept } });
    expect(response.status).toBe(status);
    expect(response.headers.get("Content-Type")).toBe(status === 200 ? CATALOG_TYPE : "application/problem+json");
  });

  it.each([
    ["GET", "/llms.txt?unknown=1", "text/plain", 400, "invalid_request"],
    ["GET", "/llms-full.txt?x=1&x=2", "text/plain", 400, "invalid_request"],
    ["GET", "/.well-known/api-catalog?%FF=1", "application/linkset+json", 400, "invalid_request"],
    ["GET", "/llms.txt", "text/plain;q=1;charset=latin1", 406, "not_acceptable"],
    ["GET", "/llms.txt", "text/plain;q=0;charset=utf-8, text/plain;q=1", 406, "not_acceptable"],
    ["GET", "/llms-full.txt", "application/cbor", 406, "not_acceptable"],
    ["POST", "/.well-known/api-catalog", "application/vnd.api+json", 405, "method_not_allowed"],
    ["PUT", "/llms.txt", "application/json", 405, "method_not_allowed"],
  ] as const)("returns JSON Problem Details for %s %s with %s", async (method, path, accept, status, code) => {
    const response = await request(path, { method, headers: { Accept: accept } });
    expect(response.status).toBe(status);
    expect(response.headers.get("Content-Type")).toBe("application/problem+json");
    expect(await response.json()).toMatchObject({ type: "about:blank", status, code });
    if (status === 405) expect(response.headers.get("Allow")).toContain("GET");
  });

  it("retains GET error metadata without a HEAD body for a late invalid catalog profile", async () => {
    const headers = { Accept: 'application/linkset+json;q=1;profile="https://invalid.example"' };
    const get = await request("/.well-known/api-catalog", { headers });
    const head = await request("/.well-known/api-catalog", { headers, method: "HEAD" });
    expect(get.status).toBe(406);
    expect(head.status).toBe(406);
    expect(head.headers.get("Content-Type")).toBe("application/problem+json");
    expect(head.headers.get("Content-Length")).toBe(String(new TextEncoder().encode(await get.text()).byteLength));
    expect(await head.text()).toBe("");
  });

  it.each(["/.env", "/AGENTS.md", "/package.json", "/src/app.ts", "/llms.txt/extra"])(
    "does not expose repository file %s",
    async (path) => {
      expect((await request(path)).status).toBe(404);
    },
  );

  it("advertises the index and health discovery links without changing the operation inventory", async () => {
    for (const path of ["/openapi.json", "/llms-full.txt", "/.well-known/api-catalog"]) {
      const response = await request(path);
      expect(links(response)).toContainEqual(INDEX_LINK);
    }
    const health = await request("/health");
    expect(links(health)).toEqual(expect.arrayContaining([CATALOG_LINK, SCHEMA_LINK]));
    const schema = await request("/openapi.json");
    expect(await schema.json()).toMatchObject({
      paths: { "/health": { get: { responses: { "200": { headers: { Link: { required: true } } } } } } },
    });
    const ui = await request("/api-docs");
    expect(links(ui)).toContainEqual(INDEX_LINK);
  });
});
