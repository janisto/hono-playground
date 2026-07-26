export interface PaginationLinkQuery {
  readonly filterCategory?: string;
  readonly pageLimit: string;
}

export interface PaginationLinks {
  readonly self: string;
  readonly next?: string;
  readonly prev?: string;
}

function assertRelativePath(basePath: string): void {
  if (
    !basePath.startsWith("/") ||
    basePath.startsWith("//") ||
    basePath.includes("?") ||
    basePath.includes("#")
  ) {
    throw new TypeError("pagination base path must be a relative absolute-path reference");
  }
}

export function buildPaginationTarget(
  basePath: string,
  query: PaginationLinkQuery,
  cursor: string | null,
): string {
  assertRelativePath(basePath);
  const search = new URLSearchParams();
  if (query.filterCategory !== undefined) {
    search.set("filter[category]", query.filterCategory);
  }
  search.set("page[limit]", query.pageLimit);
  if (cursor) search.set("page[cursor]", cursor);
  return `${basePath}?${search.toString()}`;
}

export function buildPaginationLinks(
  basePath: string,
  query: PaginationLinkQuery,
  currentCursor: string | null,
  nextCursor: string | null,
  prevCursor: string | null,
): PaginationLinks {
  const self = buildPaginationTarget(basePath, query, currentCursor);
  const next = nextCursor === null ? undefined : buildPaginationTarget(basePath, query, nextCursor);
  const prev = prevCursor === null ? undefined : buildPaginationTarget(basePath, query, prevCursor);
  return {
    self,
    ...(next === undefined ? {} : { next }),
    ...(prev === undefined ? {} : { prev }),
  };
}
