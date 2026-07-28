import { expect, test } from "@playwright/test";

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
