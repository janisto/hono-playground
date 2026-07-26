import { decodeCursor, encodeCursor, InvalidCursorError } from "./cursor.ts";
import { buildPaginationLinks, type PaginationLinks } from "./link.ts";

export interface PaginateOptions<T> {
  readonly items: readonly T[];
  readonly cursor?: string | null;
  readonly limit: number;
  readonly cursorType: string;
  readonly getId: (item: T) => string;
  readonly basePath: string;
  readonly category?: string;
}

export interface PaginationResult<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly links: PaginationLinks;
  readonly nextCursor: string | null;
  readonly prevCursor: string | null;
}

export function paginate<T>(options: PaginateOptions<T>): PaginationResult<T> {
  const { items, cursor, limit, cursorType, getId, basePath, category } = options;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError("pagination limit must be a positive integer");
  }

  let startIndex = 0;
  if (cursor !== undefined && cursor !== null) {
    const decoded = decodeCursor(cursor);
    if (decoded.cursorType !== cursorType) {
      throw new InvalidCursorError(`invalid cursor type: expected '${cursorType}'`);
    }
    if (decoded.value.length === 0) {
      throw new InvalidCursorError("cursor value cannot be empty");
    }

    const cursorIndex = items.findIndex((item) => getId(item) === decoded.value);
    if (cursorIndex === -1) {
      throw new InvalidCursorError("cursor references unknown item");
    }
    startIndex = cursorIndex + 1;
  }

  const endIndex = startIndex + limit;
  const pageItems = items.slice(startIndex, endIndex);

  let nextCursor: string | null = null;
  const lastPageItem = pageItems.at(-1);
  if (endIndex < items.length && lastPageItem !== undefined) {
    nextCursor = encodeCursor(cursorType, getId(lastPageItem));
  }

  let prevCursor: string | null = null;
  if (startIndex > 0) {
    if (startIndex <= limit) {
      prevCursor = "";
    } else {
      const previousPageBoundary = items[startIndex - limit - 1];
      if (previousPageBoundary === undefined) {
        throw new Error("invalid pagination boundary");
      }
      prevCursor = encodeCursor(cursorType, getId(previousPageBoundary));
    }
  }

  const links = buildPaginationLinks(
    basePath,
    category === undefined ? { pageLimit: String(limit) } : { filterCategory: category, pageLimit: String(limit) },
    cursor ?? null,
    nextCursor,
    prevCursor,
  );

  return {
    items: pageItems,
    total: items.length,
    links,
    nextCursor,
    prevCursor,
  };
}
