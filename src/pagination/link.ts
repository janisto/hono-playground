export type PaginationLinks = Readonly<{ self: string; next?: string; prev?: string }>;

const assertRelativePath = (basePath: string): void => {
  if (!basePath.startsWith("/") || basePath.startsWith("//") || basePath.includes("?") || basePath.includes("#")) {
    throw new TypeError("pagination base path must be a relative absolute-path reference");
  }
};

export const buildItemTarget = (
  basePath: string,
  options: Readonly<{ limit?: number; cursor?: string; category?: string }>,
): string => {
  assertRelativePath(basePath);
  const query = new URLSearchParams();
  if (options.category !== undefined) query.set("filter[category]", options.category);
  if (options.limit !== undefined) query.set("page[limit]", String(options.limit));
  if (options.cursor !== undefined) query.set("page[cursor]", options.cursor);
  const encoded = query.toString();
  return encoded.length === 0 ? basePath : `${basePath}?${encoded}`;
};

export const buildGitHubTarget = (basePath: string, limit: number, cursor: string): string => {
  assertRelativePath(basePath);
  const query = new URLSearchParams({ limit: String(limit), cursor });
  return `${basePath}?${query.toString()}`;
};

export const serializeLinkHeader = (links: Readonly<{ next?: string; prev?: string }>): string | undefined => {
  const values = [
    ...(links.next === undefined ? [] : [`<${links.next}>; rel="next"`]),
    ...(links.prev === undefined ? [] : [`<${links.prev}>; rel="prev"`]),
  ];
  return values.length === 0 ? undefined : values.join(", ");
};
