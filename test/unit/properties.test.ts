import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseRuntimeConfig } from "../../src/core/config.js";
import { accepts } from "../../src/core/content-negotiation.js";
import { requireSameOriginForUnsafeProfile } from "../../src/core/origin.js";
import { requestId } from "../../src/core/request-context.js";
import type { RuntimeBindings } from "../../src/core/types.js";
import { ProfileCreateSchema } from "../../src/models/profile.js";
import { decodeCursor, encodeCursor, InvalidCursorError } from "../../src/pagination/cursor.js";
import { buildPaginationLinks } from "../../src/pagination/link.js";

const TEST_BINDINGS = {
  DB: {} as D1Database,
  ENVIRONMENT: "test",
  RATE_LIMIT_MODE: "none",
} satisfies RuntimeBindings;

const safeCharacters = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-"];
const alphanumericCharacters = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"];

describe("bounded contract properties", () => {
  it("round-trips bounded Unicode cursor values through canonical Base64URL", () => {
    const cursorType = fc
      .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), { minLength: 1, maxLength: 12 })
      .map((characters) => characters.join(""));
    const cursorValue = fc
      .array(fc.constantFrom("a", "Z", "0", ":", " ", "é", "漢", "🙂"), {
        minLength: 1,
        maxLength: 24,
      })
      .map((characters) => characters.join(""));

    fc.assert(
      fc.property(cursorType, cursorValue, (type, value) => {
        const encoded = encodeCursor(type, value);
        expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(decodeCursor(encoded)).toEqual({ cursorType: type, value });
      }),
      { numRuns: 150 },
    );
  });

  it("rejects any generated cursor containing a non-Base64URL alphabet character", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{1,12}$/u),
        fc.stringMatching(/^[A-Za-z0-9:-]{1,40}$/u),
        fc.constantFrom("!", " ", "+", "/", "%"),
        fc.nat(),
        (type, value, invalidCharacter, requestedIndex) => {
          const encoded = encodeCursor(type, value);
          const index = requestedIndex % (encoded.length + 1);
          const malformed = `${encoded.slice(0, index)}${invalidCharacter}${encoded.slice(index)}`;
          expect(() => decodeCursor(malformed)).toThrow(InvalidCursorError);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("keeps generated pagination links ordered, relative, and duplicate-free", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.constantFrom("electronics", "tools", "accessories", "robotics", "power", "components"),
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 30 }),
        (limit, category, nextItem, previousItem) => {
          const next = encodeCursor("item", `item-${String(nextItem).padStart(3, "0")}`);
          const previous = encodeCursor("item", `item-${String(previousItem).padStart(3, "0")}`);
          const links = buildPaginationLinks(
            "/v1/items",
            { filterCategory: category, pageLimit: String(limit) },
            null,
            next,
            previous,
          );
          for (const [target, cursor] of [
            [links.next, next],
            [links.prev, previous],
          ] as const) {
            if (target === undefined) throw new Error("Generated pagination link is missing");
            const url = new URL(target, "https://worker.example");
            expect(url.origin).toBe("https://worker.example");
            expect(url.pathname).toBe("/v1/items");
            expect(url.searchParams.getAll("filter[category]")).toEqual([category]);
            expect(url.searchParams.getAll("page[limit]")).toEqual([String(limit)]);
            expect(url.searchParams.getAll("page[cursor]")).toEqual([cursor]);
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  it("preserves every bounded safe request ID and replaces arbitrary unsafe values", () => {
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
          expect(requestId(candidate)).toMatch(/^[0-9a-f]{32}$/);
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

  it("uses lexical exact-origin equality for generated HTTPS origins", () => {
    const label = fc
      .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"), {
        minLength: 1,
        maxLength: 24,
      })
      .map((characters) => characters.join(""));

    fc.assert(
      fc.property(label, (hostLabel) => {
        const origin = `https://${hostLabel}.example`;
        expect(() =>
          requireSameOriginForUnsafeProfile(
            new Request(`${origin}/v1/profiles`, { method: "POST", headers: { Origin: origin } }),
          ),
        ).not.toThrow();
        expect(() =>
          requireSameOriginForUnsafeProfile(
            new Request(`${origin}/v1/profiles`, {
              method: "POST",
              headers: { Origin: `https://${hostLabel}.invalid` },
            }),
          ),
        ).toThrow("origin_not_allowed");
      }),
      { numRuns: 100 },
    );
  });

  it("rejects arbitrary unsupported runtime modes instead of defaulting", () => {
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

  it("accepts only ASCII E.164 digits and counts profile names by code point", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9 }),
        fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 6, maxLength: 13 }),
        (countryDigit, remainder) => {
          const digits = `${countryDigit}${remainder.join("")}`;
          const base = {
            firstName: "🙂".repeat(100),
            lastName: "Lovelace",
            email: "ada@example.com",
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
    [" USER+tag@EXAMPLE.COM ", true, "user+tag@example.com"],
    ["a@b.co", true, "a@b.co"],
    ["plainaddress", false, undefined],
    ["user@example", false, undefined],
    ["user@localhost", false, undefined],
    ["user@-example.com", false, undefined],
    ['"quoted"@example.com', false, undefined],
    ["user@[192.0.2.1]", false, undefined],
    ["δοκιμή@example.com", false, undefined],
    ["user..dots@example.com", false, undefined],
  ])("freezes the pinned Zod email corpus for %s", (email, accepted, normalized) => {
    const result = ProfileCreateSchema.safeParse({
      firstName: "Ada",
      lastName: "Lovelace",
      email,
      phoneNumber: "+12025550123",
      termsAccepted: true,
    });
    expect(result.success).toBe(accepted);
    if (result.success) expect(result.data.email).toBe(normalized);
  });
});
