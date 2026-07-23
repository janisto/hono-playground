import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("default Worker entrypoint", () => {
  it("serves health through the exported module fetch handler", async () => {
    const response = await SELF.fetch("https://worker.example/health", {
      headers: { Accept: "application/json", "CF-Connecting-IP": "192.0.2.10" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("X-Request-ID")).toMatch(/^[0-9a-f]{32}$/);
    expect(await response.json()).toEqual({ status: "healthy" });
  });
});
