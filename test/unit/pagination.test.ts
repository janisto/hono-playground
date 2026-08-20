import { describe, expect, it } from "vitest";

import { ITEMS } from "../../src/data/items.ts";
import { ItemCollectionDocumentSchema, ItemSchema } from "../../src/models/items.ts";
import { JSON_API_OBJECT } from "../../src/models/json-api.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, MAX_CURSOR_LENGTH } from "../../src/pagination/cursor.ts";
import { buildItemTarget, serializeLinkHeader } from "../../src/pagination/link.ts";
import { paginate } from "../../src/pagination/paginate.ts";

const paginateItems = (
  options: { cursor?: string; limit?: number; category?: string; suppliedLimit?: boolean } = {},
) => {
  const items = options.category === undefined ? ITEMS : ITEMS.filter((item) => item.category === options.category);
  return paginate({
    items,
    limit: options.limit ?? 20,
    getId: (item) => item.id,
    basePath: "/v1/items",
    suppliedLimit: options.suppliedLimit ?? options.limit !== undefined,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ...(options.category === undefined ? {} : { category: options.category }),
  });
};

const cursorFrom = (target: string, name = "page[cursor]"): string => {
  const cursor = new URL(target, "https://worker.example").searchParams.get(name);
  if (cursor === null) throw new Error("pagination target has no cursor");
  return cursor;
};

describe("item fixture", () => {
  it("matches the immutable portable Money catalog shape", () => {
    expect(ItemSchema.array().safeParse(ITEMS).success).toBe(true);
    expect(ITEMS).toHaveLength(30);
    expect(ITEMS[0]).toMatchObject({
      id: "item-001",
      price: { amountMinor: 2999, currency: "USD" },
    });
    expect(Object.isFrozen(ITEMS)).toBe(true);
    expect(ITEMS.every((item) => Object.isFrozen(item) && Object.isFrozen(item.price))).toBe(true);
    expect(ItemSchema.safeParse({ ...ITEMS[0], price: { amountMinor: -1, currency: "USD" } }).success).toBe(false);
    expect(ItemSchema.safeParse({ ...ITEMS[0], priceCents: 2999 }).success).toBe(false);
    expect(
      ItemCollectionDocumentSchema.safeParse({
        jsonapi: JSON_API_OBJECT,
        links: { self: "/v1/items" },
        data: [],
        meta: { total: 0 },
      }).success,
    ).toBe(true);
  });
});

describe("canonical opaque cursor codec", () => {
  it("round-trips canonical JSON through unpadded Base64URL", () => {
    const state = {
      version: 1,
      operation: "listItems",
      direction: "next",
      limit: 20,
      category: null,
      anchor: "item-020",
    };
    const encoded = encodeCursor(state);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decodeCursor(encoded)).toEqual(state);
  });

  it.each(["", "A", "_w", "%%%%", "eyJhIjoxfQ=="])(
    "rejects empty, malformed, padded, or invalid UTF-8 input: %s",
    (cursor) => expect(() => decodeCursor(cursor)).toThrow(InvalidCursorError),
  );

  it("rejects a token above the public boundary", () => {
    expect(() => decodeCursor("x".repeat(MAX_CURSOR_LENGTH + 1))).toThrow(InvalidCursorError);
  });
});

describe("item pagination", () => {
  it("returns the exact default and filtered totals", () => {
    const first = paginateItems();
    expect(first.items.map((item) => item.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `item-${String(index + 1).padStart(3, "0")}`),
    );
    expect(first.total).toBe(30);
    expect(first.links.self).toBe("/v1/items");
    expect(first.links.prev).toBeUndefined();
    expect(first.links.next).toContain("page%5Blimit%5D=20&page%5Bcursor%5D=");
    expect(first.linkHeader).toBe(`<${first.links.next}>; rel="next"`);

    const electronics = paginateItems({ category: "electronics" });
    expect(electronics.total).toBe(13);
    expect(electronics.items.map((item) => item.id)).toEqual([
      "item-001",
      "item-002",
      "item-004",
      "item-005",
      "item-008",
      "item-009",
      "item-010",
      "item-015",
      "item-016",
      "item-025",
      "item-026",
      "item-028",
      "item-029",
    ]);
  });

  it("traverses three pages forward and back without duplicates or skips", () => {
    const first = paginateItems({ limit: 10 });
    const second = paginateItems({ limit: 10, cursor: cursorFrom(first.links.next ?? "") });
    const third = paginateItems({ limit: 10, cursor: cursorFrom(second.links.next ?? "") });
    expect([...first.items, ...second.items, ...third.items].map((item) => item.id)).toEqual(
      ITEMS.map((item) => item.id),
    );
    expect(third.links.next).toBeUndefined();
    const backToSecond = paginateItems({ limit: 10, cursor: cursorFrom(third.links.prev ?? "") });
    const backToFirst = paginateItems({ limit: 10, cursor: cursorFrom(backToSecond.links.prev ?? "") });
    expect(backToSecond.items.map((item) => item.id)).toEqual(second.items.map((item) => item.id));
    expect(backToFirst.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
  });

  it.each([
    {
      version: 1,
      operation: "otherOperation",
      direction: "next",
      limit: 5,
      category: null,
      anchor: "item-005",
    },
    {
      version: 1,
      operation: "listItems",
      direction: "sideways",
      limit: 5,
      category: null,
      anchor: "item-005",
    },
    {
      version: 1,
      operation: "listItems",
      direction: "next",
      limit: 20,
      category: null,
      anchor: "missing",
    },
  ])("rejects wrong-operation, direction, limit, filter, and stale cursor state", (state) => {
    expect(() => paginateItems({ limit: 5, cursor: encodeCursor(state) })).toThrow(InvalidCursorError);
  });

  it("rejects invalid internal limits", () => {
    expect(() => paginateItems({ limit: 0 })).toThrow("pagination limit must be an integer from 1 through 100");
    expect(() => paginateItems({ limit: 1.5 })).toThrow("pagination limit must be an integer from 1 through 100");
  });
});

describe("pagination links", () => {
  it("builds relative targets and serializes only available relations", () => {
    const target = buildItemTarget("/v1/items", {
      category: "electronics",
      limit: 5,
      cursor: "opaque",
    });
    expect(target).toBe("/v1/items?filter%5Bcategory%5D=electronics&page%5Blimit%5D=5&page%5Bcursor%5D=opaque");
    expect(serializeLinkHeader({ next: target, prev: "/v1/items?page%5Blimit%5D=5" })).toBe(
      `<${target}>; rel="next", </v1/items?page%5Blimit%5D=5>; rel="prev"`,
    );
    expect(serializeLinkHeader({})).toBeUndefined();
  });

  it.each(["https://example.com/v1/items", "//example.com/v1/items", "/v1/items?x=1"])(
    "rejects host-bearing or pre-queried base paths: %s",
    (basePath) => expect(() => buildItemTarget(basePath, {})).toThrow("relative absolute-path"),
  );
});
