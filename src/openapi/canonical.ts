import { OpenAPIHono } from "@hono/zod-openapi";

import {
  healthRoute,
  helloGetRoute,
  helloPostRoute,
  itemsRoute,
  profileDeleteRoute,
  profileGetRoute,
  profilePatchRoute,
  profilePostRoute,
} from "../api/routes.js";

const routes = [
  healthRoute,
  helloGetRoute,
  helloPostRoute,
  itemsRoute,
  profilePostRoute,
  profileGetRoute,
  profilePatchRoute,
  profileDeleteRoute,
] as const;

type JsonValue = boolean | null | number | string | JsonValue[] | { [key: string]: JsonValue };

const normalizeJson = (value: unknown, ancestors = new Set<object>()): JsonValue => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("OpenAPI numbers must be finite");
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("OpenAPI document must not contain cycles");
    ancestors.add(value);
    const result = value.map((child) => {
      if (child === undefined) throw new TypeError("OpenAPI arrays must not contain undefined");
      return normalizeJson(child, ancestors);
    });
    ancestors.delete(value);
    return result;
  }
  if (typeof value !== "object" || value === null) {
    throw new TypeError("OpenAPI document must contain only JSON values");
  }
  if (ancestors.has(value)) throw new TypeError("OpenAPI document must not contain cycles");
  ancestors.add(value);
  const result: { [key: string]: JsonValue } = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) result[key] = normalizeJson(child, ancestors);
  }
  ancestors.delete(value);
  return result;
};

const deepFreeze = (value: unknown, visited = new Set<object>()): void => {
  if (typeof value !== "object" || value === null || visited.has(value)) return;
  visited.add(value);
  for (const child of Object.values(value)) deepFreeze(child, visited);
  Object.freeze(value);
};

export const buildCanonicalOpenApiDocument = (): Readonly<Record<string, unknown>> => {
  const registry = new OpenAPIHono();
  for (const route of routes) registry.openAPIRegistry.registerPath(route);
  const generated = registry.getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "Hono Playground", version: "0.1.0" },
    servers: [{ url: "/" }],
  });
  const document = normalizeJson(generated);
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new TypeError("Generated OpenAPI document must be an object");
  }
  deepFreeze(document);
  return document;
};

export const CANONICAL_OPENAPI_DOCUMENT = buildCanonicalOpenApiDocument();
