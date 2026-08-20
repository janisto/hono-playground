import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseRuntimeConfig } from "../../src/core/config.ts";
import { accepts } from "../../src/core/content-negotiation.ts";
import { requireTrustedOriginForUnsafeProfile } from "../../src/core/origin.ts";
import { requestId } from "../../src/core/request-context.ts";
import type { RuntimeBindings } from "../../src/core/types.ts";
import { ProfileCreateSchema } from "../../src/models/profile.ts";
import { decodeCursor, encodeCursor, InvalidCursorError } from "../../src/pagination/cursor.ts";
import { buildItemTarget } from "../../src/pagination/link.ts";

const TEST_BINDINGS = {
  DB: {} as D1Database,
  ENVIRONMENT: "test",
  RATE_LIMIT_MODE: "none",
} satisfies RuntimeBindings;

const safeCharacters = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-"];
const alphanumericCharacters = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"];

describe("bounded portable contract properties", () => {
  it("round-trips canonical cursor state through unpadded Base64URL", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{1,20}$/u),
        fc.stringMatching(/^[A-Za-z0-9:-]{1,40}$/u),
        (operation, anchor) => {
          const state = { version: 1, operation, direction: "next", limit: 20, anchor };
          const encoded = encodeCursor(state);
          expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
          expect(decodeCursor(encoded)).toEqual(state);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("rejects a generated cursor after any non-Base64URL insertion", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9:-]{1,40}$/u),
        fc.constantFrom("!", " ", "+", "/", "%", "="),
        fc.nat(),
        (anchor, invalidCharacter, requestedIndex) => {
          const encoded = encodeCursor({ version: 1, operation: "listItems", anchor });
          const index = requestedIndex % (encoded.length + 1);
          const malformed = `${encoded.slice(0, index)}${invalidCharacter}${encoded.slice(index)}`;
          expect(() => decodeCursor(malformed)).toThrow(InvalidCursorError);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("keeps generated item links relative and duplicate-free", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.constantFrom("electronics", "tools", "accessories", "robotics", "power", "components"),
        fc.stringMatching(/^[A-Za-z0-9_-]{1,80}$/u),
        (limit, category, cursor) => {
          const target = buildItemTarget("/v1/items", { limit, category, cursor });
          const url = new URL(target, "https://worker.example");
          expect(url.origin).toBe("https://worker.example");
          expect(url.pathname).toBe("/v1/items");
          expect(url.searchParams.getAll("filter[category]")).toEqual([category]);
          expect(url.searchParams.getAll("page[limit]")).toEqual([String(limit)]);
          expect(url.searchParams.getAll("page[cursor]")).toEqual([cursor]);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("preserves bounded request IDs and replaces arbitrary unsafe values", () => {
    const safeId = fc
      .tuple(
        fc.constantFrom(...alphanumericCharacters),
        fc.array(fc.constantFrom(...safeCharacters), { maxLength: 127 }),
      )
      .map(([first, rest]) => first + rest.join(""));
    fc.assert(
      fc.property(safeId, (candidate) => {
        expect(requestId(candidate)).toBe(candidate);
      }),
      { numRuns: 150 },
    );
    fc.assert(
      fc.property(
        fc.string({ maxLength: 180 }).filter((candidate) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(candidate)),
        (candidate) => {
          expect(requestId(candidate)).toMatch(/^[0-9a-f]{32}$/u);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("accepts positive JSON q-values and rejects an exact q=0", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 999 }), (quality) => {
        const value = `0.${String(quality).padStart(3, "0")}`;
        expect(accepts(`application/json;q=${value}`, "application/json")).toBe(true);
      }),
      { numRuns: 100 },
    );
    expect(accepts("application/json;q=0", "application/json")).toBe(false);
  });

  it("uses exact trusted HTTPS-origin equality", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9]{1,24}$/u), (hostLabel) => {
        const origin = `https://${hostLabel}.example`;
        expect(() =>
          requireTrustedOriginForUnsafeProfile(
            new Request(`${origin}/v1/profile`, { method: "POST", headers: { Origin: origin } }),
            origin,
          ),
        ).not.toThrow();
        expect(() =>
          requireTrustedOriginForUnsafeProfile(
            new Request(`${origin}/v1/profile`, {
              method: "POST",
              headers: { Origin: `https://${hostLabel}.invalid` },
            }),
            origin,
          ),
        ).toThrow("forbidden");
      }),
      { numRuns: 100 },
    );
  });

  it("rejects unsupported runtime modes instead of defaulting", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 32 }).filter((value) => !["none", "workers-binding"].includes(value)),
        (rateLimitMode) => {
          expect(() => parseRuntimeConfig({ ...TEST_BINDINGS, RATE_LIMIT_MODE: rateLimitMode })).toThrow(
            "internal_error",
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("accepts only ASCII E.164 digits and counts names by Unicode scalar", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9 }),
        fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 6, maxLength: 13 }),
        (countryDigit, remainder) => {
          const digits = `${countryDigit}${remainder.join("")}`;
          const base = {
            firstName: "🙂".repeat(100),
            lastName: "Lovelace",
            contactEmail: "Ada@example.com",
            phoneNumber: `+${digits}`,
            termsAccepted: true,
          };
          expect(ProfileCreateSchema.safeParse(base).success).toBe(true);
          expect(
            ProfileCreateSchema.safeParse({
              ...base,
              phoneNumber: `+${[...digits].map((digit) => String.fromCodePoint(0x0660 + Number(digit))).join("")}`,
            }).success,
          ).toBe(false);
          expect(ProfileCreateSchema.safeParse({ ...base, firstName: "🙂".repeat(101) }).success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it.each([
    ["simple@example.com", true, "simple@example.com"],
    [" User+tag@EXAMPLE.COM ", true, "User+tag@example.com"],
    ["a@b.co", true, "a@b.co"],
    ["plainaddress", false, undefined],
    ["user@example", false, undefined],
    ["user@localhost", false, undefined],
    ["user@-example.com", false, undefined],
    ['"quoted"@example.com', false, undefined],
    ["user@[192.0.2.1]", false, undefined],
    ["δοκιμή@example.com", false, undefined],
    ["user..dots@example.com", false, undefined],
  ])("pins portable contact-email handling for %s", (contactEmail, accepted, normalized) => {
    const result = ProfileCreateSchema.safeParse({
      firstName: "Ada",
      lastName: "Lovelace",
      contactEmail,
      phoneNumber: "+12025550123",
      termsAccepted: true,
    });
    expect(result.success).toBe(accepted);
    if (result.success) expect(result.data.contactEmail).toBe(normalized);
  });
});
