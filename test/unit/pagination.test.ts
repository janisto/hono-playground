import { describe, expect, it } from "vitest";

import { ITEMS } from "../../src/data/items.js";
import { ItemListSchema, ItemSchema } from "../../src/models/items.js";
import {
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  MAX_CURSOR_LENGTH,
} from "../../src/pagination/cursor.js";
import { buildLinkHeader } from "../../src/pagination/link.js";
import { getLastQueryValue, paginate } from "../../src/pagination/paginate.js";

const paginateItems = (cursor: string | null = null, limit = 5) =>
  paginate({
    items: ITEMS,
    cursor,
    limit,
    cursorType: "item",
    getId: (item) => item.id,
    basePath: "/v1/items",
  });

describe("item fixture", () => {
  it("matches the pinned serialized fixture SHA-256", async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(ITEMS)),
    );
    const hexadecimal = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");

    expect(hexadecimal).toBe("0f4e58e17f19c095b73a6eebf590e079e6531d56f647d320f701f984d3e0784d");
  });

  it("contains the exact ordered 30-item reference data", () => {
    expect(ITEMS).toHaveLength(30);
    expect(ITEMS[0]).toEqual({
      id: "item-001",
      name: "Alpha Widget",
      category: "electronics",
      price: 29.99,
      in_stock: true,
      created_at: "2024-01-15T10:30:00.000Z",
      description: "A versatile electronic widget for everyday use",
    });
    expect(ITEMS.at(-1)).toEqual({
      id: "item-030",
      name: "Zeta Premium Cable",
      category: "accessories",
      price: 19.99,
      in_stock: true,
      created_at: "2024-02-14T15:30:00.000Z",
      description: "Gold-plated premium cable",
    });
    expect(ITEMS.map((item) => item.id)).toEqual(
      Array.from({ length: 30 }, (_, index) => `item-${String(index + 1).padStart(3, "0")}`),
    );
    expect(
      Object.fromEntries(
        ["electronics", "tools", "accessories", "robotics", "power", "components"].map(
          (category) => [category, ITEMS.filter((item) => item.category === category).length],
        ),
      ),
    ).toEqual({
      electronics: 13,
      tools: 6,
      accessories: 4,
      robotics: 2,
      power: 2,
      components: 3,
    });
  });

  it("is runtime validated and immutable", () => {
    expect(ItemSchema.array().safeParse(ITEMS).success).toBe(true);
    expect(ItemListSchema.safeParse({ items: ITEMS, total: 30 }).success).toBe(true);
    expect(Object.isFrozen(ITEMS)).toBe(true);
    expect(ITEMS.every((item) => Object.isFrozen(item))).toBe(true);
    expect(ItemSchema.safeParse({ ...ITEMS[0], price: -1 }).success).toBe(false);
    expect(ItemSchema.safeParse({ ...ITEMS[0], unexpected: true }).success).toBe(false);
  });
});

describe("cursor codec", () => {
  it("uses unpadded UTF-8 Base64URL", () => {
    expect(encodeCursor("item", "item-001")).toBe("aXRlbTppdGVtLTAwMQ");
    expect(decodeCursor("aXRlbTppdGVtLTAwMQ")).toEqual({
      cursorType: "item",
      value: "item-001",
    });
  });

  it.each(["aXRlbTppdGVtLTAwMQ", "aXRlbTppdGVtLTAwMQ=", "aXRlbTppdGVtLTAwMQ=="])(
    "accepts valid partial or complete terminal padding: %s",
    (cursor) => {
      expect(decodeCursor(cursor)).toEqual({ cursorType: "item", value: "item-001" });
    },
  );

  it("treats an empty query value as the first-page sentinel", () => {
    expect(decodeCursor("")).toEqual({ cursorType: "", value: "" });
    expect(paginateItems("").items[0]?.id).toBe("item-001");
  });

  it.each([
    "aXRlbTppdGVtLTAwMQ===",
    "aXRlbTppdGVtLTAwMQ==x",
    "aXRlbTppdGVtLTAwMQ ==",
    "aXRlbTppdGVtLTAwMQ!!",
    "A",
    "_w",
  ])("rejects malformed Base64URL or invalid UTF-8 without echoing it: %s", (cursor) => {
    expect(() => decodeCursor(cursor)).toThrowError(
      new InvalidCursorError("invalid cursor format"),
    );
  });

  it("rejects a cursor above the application limit", () => {
    expect(() => decodeCursor("x".repeat(MAX_CURSOR_LENGTH + 1))).toThrowError(
      new InvalidCursorError("cursor exceeds maximum length"),
    );
  });

  it("rejects decoded data without the type separator", () => {
    expect(() => decodeCursor("bm8tY29sb24taGVyZQ")).toThrow("invalid cursor format");
  });
});

describe("pagination", () => {
  it("returns the first page and exact next link", () => {
    const result = paginateItems();

    expect(result.items.map((item) => item.id)).toEqual([
      "item-001",
      "item-002",
      "item-003",
      "item-004",
      "item-005",
    ]);
    expect(result.total).toBe(30);
    expect(result.nextCursor).toBe("aXRlbTppdGVtLTAwNQ");
    expect(result.prevCursor).toBeNull();
    expect(result.linkHeader).toBe('</v1/items?limit=5&cursor=aXRlbTppdGVtLTAwNQ>; rel="next"');
  });

  it("returns the second page with next followed by a cursorless prev", () => {
    const result = paginateItems(encodeCursor("item", "item-005"));

    expect(result.items[0]?.id).toBe("item-006");
    expect(result.nextCursor).toBe("aXRlbTppdGVtLTAxMA");
    expect(result.prevCursor).toBe("");
    expect(result.linkHeader).toBe(
      '</v1/items?limit=5&cursor=aXRlbTppdGVtLTAxMA>; rel="next", </v1/items?limit=5>; rel="prev"',
    );
  });

  it("preserves the reference prev calculation for an unaligned cursor", () => {
    const result = paginateItems(encodeCursor("item", "item-007"));

    expect(result.items[0]?.id).toBe("item-008");
    expect(result.prevCursor).toBe(encodeCursor("item", "item-002"));
  });

  it("accepts a final-item cursor as an exhausted page with a usable prev", () => {
    const result = paginateItems(encodeCursor("item", "item-030"), 20);

    expect(result.items).toEqual([]);
    expect(result.total).toBe(30);
    expect(result.nextCursor).toBeNull();
    expect(result.prevCursor).toBe(encodeCursor("item", "item-010"));
    expect(result.linkHeader).toBe(
      `</v1/items?limit=20&cursor=${encodeCursor("item", "item-010")}>; rel="prev"`,
    );
  });

  it("uses the filtered sequence for cursor lookup, slicing, and total", () => {
    const electronics = ITEMS.filter((item) => item.category === "electronics");
    const result = paginate({
      items: electronics,
      cursor: encodeCursor("item", "item-005"),
      limit: 3,
      cursorType: "item",
      getId: (item) => item.id,
      basePath: "/v1/items",
      category: "electronics",
    });

    expect(result.items.map((item) => item.id)).toEqual(["item-008", "item-009", "item-010"]);
    expect(result.total).toBe(13);
    expect(result.linkHeader).toContain("category=electronics&limit=3&cursor=");
  });

  it.each([
    [encodeCursor("other", "item-001"), "invalid cursor type: expected 'item'"],
    [encodeCursor("item", ""), "cursor value cannot be empty"],
    [encodeCursor("item", "missing"), "cursor references unknown item"],
  ])("rejects invalid cursor semantics", (cursor, detail) => {
    expect(() => paginateItems(cursor)).toThrowError(new InvalidCursorError(detail));
  });

  it("rejects invalid internal limits", () => {
    expect(() => paginateItems(null, 0)).toThrow("pagination limit must be a positive integer");
    expect(() => paginateItems(null, 1.5)).toThrow("pagination limit must be a positive integer");
  });
});

describe("query and link helpers", () => {
  it("selects the last repeated scalar query value and preserves empty values", () => {
    const search = new URLSearchParams("limit=2&limit=5&cursor=first&cursor=&unknown=x");

    expect(getLastQueryValue(search, "limit")).toBe("5");
    expect(getLastQueryValue(search, "cursor")).toBe("");
    expect(getLastQueryValue(search, "category")).toBeUndefined();
  });

  it("builds next before prev and emits each supported parameter once", () => {
    expect(
      buildLinkHeader("/v1/items", { category: "electronics", limit: "5" }, "next-cursor", ""),
    ).toBe(
      '</v1/items?category=electronics&limit=5&cursor=next-cursor>; rel="next", </v1/items?category=electronics&limit=5>; rel="prev"',
    );
  });

  it.each(["https://example.com/v1/items", "//example.com/v1/items", "/v1/items?x=1"])(
    "rejects host-bearing or pre-queried base paths: %s",
    (basePath) => {
      expect(() => buildLinkHeader(basePath, { limit: "5" }, null, null)).toThrow(
        "pagination base path must be a relative absolute-path reference",
      );
    },
  );
});
