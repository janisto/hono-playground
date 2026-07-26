import { expect, test } from "@playwright/test";

test("renders the pinned Swagger UI from the OpenAPI 3.1 document", async ({ page }) => {
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`);
  });

  const documentResponse = page.waitForResponse(
    (candidate) => new URL(candidate.url()).pathname === "/openapi.json",
  );
  const navigation = await page.goto("/api-docs");

  expect(navigation?.status()).toBe(200);
  await expect(page).toHaveTitle("Hono Playground API");
  await expect(page.locator(".swagger-ui .info .title")).toContainText("Hono Playground");

  const response = await documentResponse;
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(await response.json()).toMatchObject({
    openapi: "3.1.0",
    info: { title: "Hono Playground", version: "0.1.0" },
  });

  expect(pageErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
