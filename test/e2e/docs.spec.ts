import { type APIResponse, expect, type Response, test } from "@playwright/test";

import { DOCS_ASSETS } from "../../src/generated/docs-assets.js";

const DOCS_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "script-src-elem 'self'",
  "script-src-attr 'none'",
  "style-src 'self'",
  "style-src-elem 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
].join("; ");

const API_CSP = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const CORS_RESPONSE_HEADERS = [
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "access-control-expose-headers",
  "access-control-max-age",
] as const;

const expectedPageAssets = [
  DOCS_ASSETS.stylesheet,
  DOCS_ASSETS.customStylesheet,
  DOCS_ASSETS.bundleScript,
  DOCS_ASSETS.initializerScript,
] as const;

type OpenApiDocument = Record<string, unknown> & {
  info?: unknown;
  openapi?: unknown;
};

type ResponseHeaderMap = Record<string, string> & { vary?: string };

const expectNoCors = (headers: Record<string, string>): void => {
  for (const name of CORS_RESPONSE_HEADERS) {
    expect(headers[name], `${name} must remain absent`).toBeUndefined();
  }
};

const expectCommonSecurityHeaders = (headers: Record<string, string>): void => {
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
  expect(headers["permissions-policy"]).toBe(
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()",
  );
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["strict-transport-security"]).toBeUndefined();
  expectNoCors(headers);
};

const responseHeaders = (response: APIResponse | Response): ResponseHeaderMap => response.headers();

test("same-origin Swagger UI is CSP-clean and exposes no manual Access credential input", async ({
  page,
  request,
  baseURL,
}) => {
  if (baseURL === undefined) {
    throw new Error("Playwright baseURL is required");
  }

  const expectedOrigin = new URL(baseURL).origin;
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const networkRequests: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("request", (webRequest) => networkRequests.push(webRequest.url()));
  page.on("requestfailed", (webRequest) => {
    failedRequests.push(
      `${webRequest.method()} ${webRequest.url()}: ${webRequest.failure()?.errorText}`,
    );
  });
  await page.addInitScript({
    content: `
      globalThis.__honoCspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        globalThis.__honoCspViolations.push(
          event.violatedDirective + ": " + event.blockedURI,
        );
      });
    `,
  });

  const openApiResponsePromise = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/openapi.json",
  );
  const docsResponse = await page.goto("/api-docs", { waitUntil: "networkidle" });
  expect(docsResponse).not.toBeNull();
  if (docsResponse === null) {
    throw new Error("Docs navigation returned no response");
  }
  expect(docsResponse.status()).toBe(200);

  const openApiResponse = await openApiResponsePromise;
  expect(openApiResponse.status()).toBe(200);
  expect(openApiResponse.headers()["content-type"]).toContain("application/json");
  const openApiDocument = (await openApiResponse.json()) as OpenApiDocument;
  expect(openApiDocument.openapi).toBe("3.1.0");
  expect(openApiDocument.info).toMatchObject({ title: "Hono Playground", version: "0.1.0" });
  expect(JSON.stringify(openApiDocument)).not.toContain("Cf-Access-Jwt-Assertion");

  await expect(page.locator(".swagger-ui .info .title")).toContainText("Hono Playground");
  await expect(page.locator(".docs-auth-banner")).toContainText("No token paste");
  await expect(page.locator(".docs-auth-banner")).toContainText(
    "existing same-origin browser session",
  );

  await expect(
    page.locator(
      ".swagger-ui .auth-wrapper, .swagger-ui .authorization__btn, .swagger-ui .btn.authorize, .swagger-ui .auth-container",
    ),
  ).toHaveCount(0);
  await expect(
    page.locator(
      'input[type="password"], input[name*="token" i], input[placeholder*="token" i], input[name*="authorization" i]',
    ),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /authorize/i })).toHaveCount(0);

  const cspViolations = await page.evaluate(() => {
    const value = Reflect.get(globalThis, "__honoCspViolations");
    return Array.isArray(value) ? value : ["CSP violation collector was not initialized"];
  });
  expect(cspViolations).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);

  for (const requestUrl of networkRequests) {
    const parsed = new URL(requestUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      expect(parsed.origin, `cross-origin browser request: ${requestUrl}`).toBe(expectedOrigin);
    } else {
      expect(["blob:", "data:"], `unexpected browser request scheme: ${requestUrl}`).toContain(
        parsed.protocol,
      );
    }
  }
  expect(networkRequests).toContain(new URL("/openapi.json", baseURL).href);
  for (const assetPath of expectedPageAssets) {
    expect(networkRequests, `${assetPath} must load in the browser`).toContain(
      new URL(assetPath, baseURL).href,
    );
  }

  const docsHeaders = responseHeaders(docsResponse);
  expect(docsHeaders["content-type"]).toContain("text/html");
  expect(docsHeaders["cache-control"]).toBe("no-store");
  expect(docsHeaders.vary).toBe("Accept");
  expect(docsHeaders["content-security-policy"]).toBe(DOCS_CSP);
  expect(docsHeaders["content-security-policy"]).not.toContain("style-src 'unsafe-inline'");
  expect(docsHeaders["x-request-id"]).toMatch(/^[0-9a-f]{32}$/);
  expectCommonSecurityHeaders(docsHeaders);

  for (const assetPath of Object.values(DOCS_ASSETS)) {
    expect(assetPath).toMatch(/^\/docs-assets\/[a-z0-9-]+\.[0-9a-f]{16}\.(?:css|js|png|txt)$/);
    const assetResponse = await request.get(assetPath);
    expect(assetResponse.status(), assetPath).toBe(200);
    const assetHeaders = responseHeaders(assetResponse);
    expect(assetHeaders["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(assetHeaders["content-security-policy"]).toBe(API_CSP);
    expect(assetHeaders["cross-origin-opener-policy"]).toBe("same-origin");
    expect(assetHeaders["cross-origin-resource-policy"]).toBe("same-origin");
    expect(assetHeaders["strict-transport-security"]).toBe("max-age=300");
    expect(assetHeaders["x-content-type-options"]).toBe("nosniff");
    expect(assetHeaders["x-frame-options"]).toBe("DENY");
    expectNoCors(assetHeaders);
  }
});

test("public health succeeds with the strict API header boundary", async ({ request }) => {
  const response = await request.get("/health", {
    headers: { Accept: "application/json" },
  });

  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "healthy" });
  const headers = responseHeaders(response);
  expect(headers["content-type"]).toContain("application/json");
  expect(headers["cache-control"]).toBe("no-store");
  expect(headers["content-security-policy"]).toBe(API_CSP);
  expect(headers["x-request-id"]).toMatch(/^[0-9a-f]{32}$/);
  expectCommonSecurityHeaders(headers);
});
