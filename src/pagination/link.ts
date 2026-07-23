export interface PaginationLinkQuery {
  readonly category?: string;
  readonly limit: string;
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

function buildTarget(basePath: string, query: PaginationLinkQuery, cursor: string | null): string {
  const search = new URLSearchParams();
  if (query.category !== undefined) {
    search.set("category", query.category);
  }
  search.set("limit", query.limit);
  if (cursor) {
    search.set("cursor", cursor);
  }
  return `${basePath}?${search.toString()}`;
}

export function buildLinkHeader(
  basePath: string,
  query: PaginationLinkQuery,
  nextCursor: string | null,
  prevCursor: string | null,
): string {
  assertRelativePath(basePath);

  const links: string[] = [];
  if (nextCursor) {
    links.push(`<${buildTarget(basePath, query, nextCursor)}>; rel="next"`);
  }
  if (prevCursor !== null) {
    links.push(`<${buildTarget(basePath, query, prevCursor)}>; rel="prev"`);
  }
  return links.join(", ");
}
