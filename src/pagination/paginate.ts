import { decodeCursor, encodeCursor, InvalidCursorError } from "./cursor.ts";
import { buildItemTarget, type PaginationLinks, serializeLinkHeader } from "./link.ts";

type ItemCursorState = Readonly<{
  version: 1;
  operation: "listItems";
  direction: "next" | "prev";
  limit: number;
  category: string | null;
  anchor: string;
}>;

const isItemCursor = (value: unknown): value is ItemCursorState => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 6 &&
    record["version"] === 1 &&
    record["operation"] === "listItems" &&
    (record["direction"] === "next" || record["direction"] === "prev") &&
    Number.isInteger(record["limit"]) &&
    (typeof record["category"] === "string" || record["category"] === null) &&
    typeof record["anchor"] === "string" &&
    record["anchor"].length > 0
  );
};

const cursorFor = (direction: "next" | "prev", limit: number, category: string | undefined, anchor: string): string =>
  encodeCursor({
    version: 1,
    operation: "listItems",
    direction,
    limit,
    category: category ?? null,
    anchor,
  } satisfies ItemCursorState);

export interface PaginateOptions<T> {
  readonly items: readonly T[];
  readonly cursor?: string;
  readonly limit: number;
  readonly getId: (item: T) => string;
  readonly basePath: string;
  readonly category?: string;
  readonly suppliedLimit: boolean;
}

export interface PaginationResult<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly links: PaginationLinks;
  readonly linkHeader?: string;
}

export const paginate = <T>(options: PaginateOptions<T>): PaginationResult<T> => {
  const { items, cursor, limit, getId, basePath, category } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("pagination limit must be an integer from 1 through 100");
  }
  let start = 0;
  let end = Math.min(items.length, limit);
  if (cursor !== undefined) {
    const state = decodeCursor(cursor);
    if (!isItemCursor(state) || state.limit !== limit || state.category !== (category ?? null)) {
      throw new InvalidCursorError();
    }
    const anchor = items.findIndex((item) => getId(item) === state.anchor);
    if (anchor < 0) throw new InvalidCursorError();
    if ((state.direction === "next" && anchor === items.length - 1) || (state.direction === "prev" && anchor === 0)) {
      throw new InvalidCursorError();
    }
    if (state.direction === "next") {
      start = anchor + 1;
      end = Math.min(items.length, start + limit);
    } else {
      end = anchor;
      start = Math.max(0, end - limit);
    }
  }

  const page = items.slice(start, end);
  const first = page[0];
  const last = page.at(-1);
  const next =
    last !== undefined && end < items.length
      ? buildItemTarget(basePath, {
          limit,
          ...(category === undefined ? {} : { category }),
          cursor: cursorFor("next", limit, category, getId(last)),
        })
      : undefined;
  const prev =
    first !== undefined && start > 0
      ? buildItemTarget(basePath, {
          limit,
          ...(category === undefined ? {} : { category }),
          cursor: cursorFor("prev", limit, category, getId(first)),
        })
      : undefined;
  const self = buildItemTarget(basePath, {
    ...(category === undefined ? {} : { category }),
    ...(options.suppliedLimit ? { limit } : {}),
    ...(cursor === undefined ? {} : { cursor }),
  });
  const links = { self, ...(next === undefined ? {} : { next }), ...(prev === undefined ? {} : { prev }) };
  const linkHeader = serializeLinkHeader(links);
  return { items: page, total: items.length, links, ...(linkHeader === undefined ? {} : { linkHeader }) };
};
