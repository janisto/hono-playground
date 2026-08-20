import { expect, test } from "@playwright/test";

const PORTABLE_OPERATIONS = new Map([
  ["get /health", "getHealth"],
  ["get /v1/hello", "getHello"],
  ["post /v1/hello", "createHello"],
  ["get /v1/items", "listItems"],
  ["post /v1/profile", "createProfile"],
  ["get /v1/profile", "getProfile"],
  ["patch /v1/profile", "updateProfile"],
  ["delete /v1/profile", "deleteProfile"],
  ["get /v1/github/owners/{owner}", "getGitHubOwner"],
  ["get /v1/github/owners/{owner}/repos", "listGitHubOwnerRepositories"],
  ["get /v1/github/repos/{owner}/{repo}", "getGitHubRepository"],
  ["get /v1/github/repos/{owner}/{repo}/activity", "listGitHubRepositoryActivity"],
  ["get /v1/github/repos/{owner}/{repo}/languages", "listGitHubRepositoryLanguages"],
  ["get /v1/github/repos/{owner}/{repo}/tags", "listGitHubRepositoryTags"],
]);

const commonHeaders = (headers: Record<string, string>): void => {
  expect(headers["x-request-id"]).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  expect(headers["cache-control"]).toBe("no-store");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
};

test("renders the pinned Swagger UI from the OpenAPI 3.1 document", async ({ page, request: apiRequest }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const errorResponses: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (failedRequest) => {
    failedRequests.push(`${failedRequest.method()} ${failedRequest.url()}: ${failedRequest.failure()?.errorText}`);
  });
  page.on("response", (candidateResponse) => {
    if (candidateResponse.status() >= 400) {
      errorResponses.push(`${candidateResponse.status()} ${candidateResponse.url()}`);
    }
  });

  const documentResponse = page.waitForResponse((candidate) => new URL(candidate.url()).pathname === "/openapi.json");
  const navigation = await page.goto("/api-docs");

  expect(navigation?.status()).toBe(200);
  await expect(page).toHaveTitle("Hono Playground API");
  await expect(page.locator(".swagger-ui .info .title")).toContainText("Hono Playground");

  const openApiResponse = await documentResponse;
  expect(openApiResponse.status()).toBe(200);
  expect(openApiResponse.headers()["content-type"]).toContain("application/json");
  expect(await openApiResponse.json()).toMatchObject({
    openapi: "3.1.0",
    info: { title: "Hono Playground", version: "0.1.0" },
  });

  const profiledJsonApi = await apiRequest.get("/v1/items", {
    headers: { Accept: 'application/vnd.api+json;profile="https://example.test/profile"' },
  });
  expect(profiledJsonApi.status()).toBe(200);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(errorResponses).toEqual([]);
});

test("serves the portable public contract through a real Worker HTTP boundary", async ({ request }) => {
  const health = await request.get("/health", {
    headers: { Accept: "application/json", "X-Request-ID": "e2e-health" },
  });
  expect(health.status()).toBe(200);
  expect(health.headers()["content-type"]).toBe("application/json");
  expect(health.headers()["x-request-id"]).toBe("e2e-health");
  commonHeaders(health.headers());
  await expect(health.json()).resolves.toEqual({ status: "healthy" });

  const hello = await request.post("/v1/hello", {
    data: { name: "Ada" },
    headers: { Accept: "application/json" },
  });
  expect(hello.status()).toBe(200);
  expect(hello.headers()["content-type"]).toBe("application/json");
  commonHeaders(hello.headers());
  await expect(hello.json()).resolves.toEqual({ message: "Hello, Ada!" });

  const items = await request.get("/v1/items?page%5Blimit%5D=1", {
    headers: { Accept: "application/vnd.api+json" },
  });
  expect(items.status()).toBe(200);
  expect(items.headers()["content-type"]).toBe("application/vnd.api+json");
  commonHeaders(items.headers());
  await expect(items.json()).resolves.toMatchObject({
    jsonapi: { version: "1.1" },
    data: [{ type: "items", id: "item-001" }],
    meta: { total: 30 },
  });

  const openApi = await request.get("/openapi.json", { headers: { Accept: "application/json" } });
  expect(openApi.status()).toBe(200);
  commonHeaders(openApi.headers());
  const document = (await openApi.json()) as {
    openapi: string;
    paths: Record<string, Record<string, { operationId?: string }>>;
  };
  const operations = new Map<string, string | undefined>();
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of ["get", "post", "patch", "delete"]) {
      if (pathItem[method] !== undefined) operations.set(`${method} ${path}`, pathItem[method].operationId);
    }
  }
  expect(document.openapi).toBe("3.1.0");
  expect(operations).toEqual(PORTABLE_OPERATIONS);
});
