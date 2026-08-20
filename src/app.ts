import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import {
  githubOwnerRepositoriesRoute,
  githubOwnerRoute,
  githubRepositoryActivityRoute,
  githubRepositoryLanguagesRoute,
  githubRepositoryRoute,
  githubRepositoryTagsRoute,
  healthRoute,
  helloGetRoute,
  helloPostRoute,
  itemsRoute,
  profileDeleteRoute,
  profileGetRoute,
  profilePatchRoute,
  profilePostRoute,
} from "./api/routes.ts";
import { ACCESS_ASSERTION_HEADER, createAccessVerifier } from "./auth/access.ts";
import type { AccessVerifier } from "./auth/types.ts";
import { readBoundedJsonBody } from "./core/body.ts";
import { selectProblemContentType } from "./core/content-negotiation.ts";
import { auditPseudonym } from "./core/crypto.ts";
import {
  AppError,
  internalError,
  invalidJsonError,
  jsonApiErrorResponse,
  problemResponse,
  zodValidationError,
} from "./core/errors.ts";
import { httpPolicy } from "./core/http-policy.ts";
import { lifecycle, runtimeConfiguration } from "./core/lifecycle.ts";
import { enforceProfileRateLimit } from "./core/rate-limit.ts";
import { apiDocumentationRoute, isJsonApiRoute, openApiDocumentRoute, resolveRoute } from "./core/routes.ts";
import { assertStrictJsonText } from "./core/strict-json.ts";
import { enterSpan } from "./core/tracing.ts";
import type { AppEnvironment } from "./core/types.ts";
import { ITEMS } from "./data/items.ts";
import { renderSwaggerUiBody, SWAGGER_UI_VERSION } from "./docs/swagger.ts";
import {
  GitHubActivityPageSchema,
  GitHubLanguagesSchema,
  GitHubOwnerSchema,
  GitHubRepositoryPageSchema,
  GitHubRepositorySchema,
  GitHubTagPageSchema,
} from "./models/github.ts";
import { HealthResponseSchema } from "./models/health.ts";
import { GreetingSchema } from "./models/hello.ts";
import { type Item, ItemCollectionDocumentSchema, type ItemResource } from "./models/items.ts";
import {
  JSON_API_MEDIA_TYPE,
  JSON_API_OBJECT,
  JsonApiIncludedSchema,
  JsonApiRelationshipsSchema,
  JsonApiResourceTypeSchema,
} from "./models/json-api.ts";
import { type Profile, ProfileDocumentSchema, type ProfileResource } from "./models/profile.ts";
import { InvalidCursorError } from "./pagination/cursor.ts";
import { buildGitHubTarget, serializeLinkHeader } from "./pagination/link.ts";
import { paginate } from "./pagination/paginate.ts";
import { DrizzleProfileRepository, type ProfileRepository } from "./repositories/profile-repository.ts";
import { GitHubClient, type GitHubClientOptions } from "./services/github-client.ts";
import { GitHubService } from "./services/github-service.ts";
import { ProfileService } from "./services/profile-service.ts";

export type AppDependencies = {
  accessVerifier?: AccessVerifier;
  profileRepositoryFactory?: (c: Context<AppEnvironment>) => ProfileRepository;
  githubClientOptions?: GitHubClientOptions;
  now?: () => Date;
  maximumRequestBytes?: number;
};

const createRepository = (c: Context<AppEnvironment>, dependencies: AppDependencies): ProfileRepository => {
  const injected = dependencies.profileRepositoryFactory?.(c);
  if (injected !== undefined) return injected;
  const database = c.env.DB;
  if (database === undefined || typeof database.prepare !== "function" || typeof database.batch !== "function") {
    throw internalError("runtime_configuration_invalid");
  }
  return new DrizzleProfileRepository(database);
};

const profileService = (c: Context<AppEnvironment>, dependencies: AppDependencies): ProfileService =>
  dependencies.now === undefined
    ? new ProfileService(createRepository(c, dependencies))
    : new ProfileService(createRepository(c, dependencies), dependencies.now);

const accessMiddleware =
  (dependencies: AppDependencies): MiddlewareHandler<AppEnvironment> =>
  async (c, next) => {
    const verifier =
      dependencies.accessVerifier ??
      createAccessVerifier({ teamDomain: c.env.ACCESS_TEAM_DOMAIN, audience: c.env.ACCESS_AUD });
    const assertion = c.req.header(ACCESS_ASSERTION_HEADER);
    if (assertion === undefined || assertion.length === 0 || assertion.includes(",")) {
      throw new AppError({ code: "forbidden", source: { header: ACCESS_ASSERTION_HEADER } });
    }
    const identity = await enterSpan("access.verify", () => verifier(assertion));
    c.set("identitySubject", identity.sub);
    await next();
  };

const profileLimiter: MiddlewareHandler<AppEnvironment> = async (c, next) => {
  const subject = c.get("identitySubject");
  if (subject === undefined) throw internalError();
  await enforceProfileRateLimit(c, subject, c.req.method === "GET" || c.req.method === "HEAD" ? "read" : "write");
  await next();
};

const strictBody: MiddlewareHandler<AppEnvironment> = async (c, next) => {
  const headers = c.get("bodyHeaders");
  if (headers === undefined) {
    await next();
    return;
  }
  const text = await readBoundedJsonBody(c.req.raw, c.get("runtimeConfig").maximumRequestBytes, headers);
  try {
    assertStrictJsonText(text);
  } catch {
    throw invalidJsonError();
  }
  Object.assign(c.req.bodyCache, { text: Promise.resolve(text) });
  c.set("bodyText", text);
  await next();
};

const profileAuditOwner = async (c: Context<AppEnvironment>, subject: string): Promise<string | undefined> => {
  if (c.get("runtimeConfig").environment !== "test" && c.env.AUDIT_SUBJECT_HMAC_KEY === undefined) {
    throw internalError("runtime_configuration_invalid");
  }
  if (c.env.AUDIT_SUBJECT_HMAC_KEY !== undefined && c.env.AUDIT_SUBJECT_HMAC_KEY === c.env.RATE_LIMIT_KEY_HMAC_KEY) {
    throw internalError("runtime_configuration_invalid");
  }
  return auditPseudonym(c.env.AUDIT_SUBJECT_HMAC_KEY, subject);
};

const jsonApiResponse = <T extends Response>(response: T): T => {
  response.headers.set("Content-Type", JSON_API_MEDIA_TYPE);
  return response;
};

const itemResource = (item: Item): ItemResource => {
  const { id, createdAt, ...attributes } = item;
  return { type: "items", id, attributes: { ...attributes, createdAt: createdAt.toISOString() } };
};

const profileResource = (profile: Profile): ProfileResource => {
  const { id, createdAt, updatedAt, ...attributes } = profile;
  return {
    type: "profiles",
    id,
    attributes: { ...attributes, createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString() },
    links: { self: "/v1/profile" },
  };
};

const profileDocument = (profile: Profile) =>
  ProfileDocumentSchema.parse({
    jsonapi: JSON_API_OBJECT,
    links: { self: "/v1/profile" },
    data: profileResource(profile),
  });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parsedBody = (c: Context<AppEnvironment>): unknown => {
  const text = c.get("bodyText");
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw invalidJsonError();
  }
};

const profileProtocolRules = (document: unknown, method: "POST" | "PATCH", subject?: string): void => {
  if (!isObject(document)) return;
  if (JsonApiIncludedSchema.safeParse(document["included"]).success) {
    throw new AppError({ code: "relationships_unsupported", source: { pointer: "/included" } });
  }
  const data = document["data"];
  if (!isObject(data)) return;
  if (JsonApiRelationshipsSchema.safeParse(data["relationships"]).success) {
    throw new AppError({ code: "relationships_unsupported", source: { pointer: "/data/relationships" } });
  }
  if (method === "POST" && Object.hasOwn(data, "id")) {
    throw new AppError({ code: "client_generated_id_unsupported", source: { pointer: "/data/id" } });
  }
  if (JsonApiResourceTypeSchema.safeParse(data["type"]).success && data["type"] !== "profiles") {
    throw new AppError({ code: "profile_resource_mismatch", source: { pointer: "/data/type" } });
  }
  if (method === "PATCH" && typeof data["id"] === "string" && subject !== undefined && data["id"] !== subject) {
    throw new AppError({ code: "profile_resource_mismatch", source: { pointer: "/data/id" } });
  }
};

const githubLink = (
  path: string,
  limit: number,
  result: Readonly<{ nextCursor?: string; prevCursor?: string }>,
): string | undefined =>
  serializeLinkHeader({
    ...(result.nextCursor === undefined ? {} : { next: buildGitHubTarget(path, limit, result.nextCursor) }),
    ...(result.prevCursor === undefined ? {} : { prev: buildGitHubTarget(path, limit, result.prevCursor) }),
  });

export const createApp = (dependencies: AppDependencies = {}) => {
  const githubService = new GitHubService(new GitHubClient(dependencies.githubClientOptions));
  const app = new OpenAPIHono<AppEnvironment>({
    strict: true,
    defaultHook: async (result, c) => {
      if (result.success) return;
      const target = result.target === "param" ? "path" : result.target === "query" ? "query" : "body";
      const document = result.target === "json" ? parsedBody(c) : undefined;
      if (result.target === "json" && new URL(c.req.url).pathname === "/v1/profile") {
        profileProtocolRules(document, c.req.method === "POST" ? "POST" : "PATCH", c.get("identitySubject"));
      }
      throw zodValidationError(result.error, target, document);
    },
  });

  app.use("*", lifecycle());
  app.use(
    "*",
    secureHeaders({
      permissionsPolicy: {
        accelerometer: [],
        camera: [],
        geolocation: [],
        gyroscope: [],
        microphone: [],
        payment: [],
        usb: [],
      },
      referrerPolicy: "strict-origin-when-cross-origin",
      strictTransportSecurity: false,
      xFrameOptions: "DENY",
    }),
  );
  app.use("*", runtimeConfiguration(dependencies.maximumRequestBytes));
  app.use("*", httpPolicy());
  app.use("/v1/hello", strictBody);
  app.use("/v1/profile/*", accessMiddleware(dependencies));
  app.use("/v1/profile/*", profileLimiter);
  app.use("/v1/profile/*", strictBody);

  app.openAPIRegistry.registerComponent("securitySchemes", "CloudflareAccess", {
    type: "apiKey",
    in: "cookie",
    name: "CF_Authorization",
    description: "Cloudflare Access browser session cookie.",
  });

  app.openapi(healthRoute, (c) => c.json(HealthResponseSchema.parse({ status: "healthy" }), 200));
  app.openapi(helloGetRoute, (c) => c.json(GreetingSchema.parse({ message: "Hello, World!" }), 200));
  app.openapi(helloPostRoute, (c) => {
    const { name } = c.req.valid("json");
    return c.json(GreetingSchema.parse({ message: `Hello, ${name}!` }), 200);
  });

  app.openapi(itemsRoute, (c) => {
    const query = c.req.valid("query");
    const category = query["filter[category]"];
    const cursor = query["page[cursor]"];
    const filtered = category === undefined ? ITEMS : ITEMS.filter((item) => item.category === category);
    let result: ReturnType<typeof paginate<(typeof ITEMS)[number]>>;
    try {
      result = paginate({
        items: filtered,
        limit: query["page[limit]"],
        getId: (item) => item.id,
        basePath: "/v1/items",
        suppliedLimit: c.get("parsedQuery").has("page[limit]"),
        ...(cursor === undefined ? {} : { cursor }),
        ...(category === undefined ? {} : { category }),
      });
    } catch (error) {
      if (error instanceof InvalidCursorError)
        throw new AppError({ code: "invalid_request", source: { parameter: "page[cursor]" } });
      throw error;
    }
    const body = ItemCollectionDocumentSchema.parse({
      jsonapi: JSON_API_OBJECT,
      links: result.links,
      data: result.items.map(itemResource),
      meta: { total: result.total },
    });
    const response = jsonApiResponse(c.json(body, 200));
    if (result.linkHeader !== undefined) response.headers.set("Link", result.linkHeader);
    return response;
  });

  app.openapi(profilePostRoute, async (c) => {
    const subject = c.get("identitySubject");
    if (subject === undefined) throw internalError();
    profileProtocolRules(parsedBody(c), "POST", subject);
    const auditOwner = await profileAuditOwner(c, subject);
    const profile = await profileService(c, dependencies).create(subject, c.req.valid("json").data.attributes);
    const response = jsonApiResponse(c.json(profileDocument(profile), 201));
    response.headers.set("Location", "/v1/profile");
    console.log({
      schema_version: 1,
      event: "profile.audit",
      level: "info",
      action: "create",
      result: "success",
      request_id: c.get("requestId"),
      ...(auditOwner === undefined ? {} : { owner: auditOwner }),
    });
    return response;
  });

  app.openapi(profileGetRoute, async (c) => {
    const subject = c.get("identitySubject");
    if (subject === undefined) throw internalError();
    return jsonApiResponse(c.json(profileDocument(await profileService(c, dependencies).get(subject)), 200));
  });

  app.openapi(profilePatchRoute, async (c) => {
    const subject = c.get("identitySubject");
    if (subject === undefined) throw internalError();
    profileProtocolRules(parsedBody(c), "PATCH", subject);
    const auditOwner = await profileAuditOwner(c, subject);
    const profile = await profileService(c, dependencies).update(subject, c.req.valid("json").data.attributes);
    console.log({
      schema_version: 1,
      event: "profile.audit",
      level: "info",
      action: "update",
      result: "success",
      request_id: c.get("requestId"),
      ...(auditOwner === undefined ? {} : { owner: auditOwner }),
    });
    return jsonApiResponse(c.json(profileDocument(profile), 200));
  });

  app.openapi(profileDeleteRoute, async (c) => {
    const subject = c.get("identitySubject");
    if (subject === undefined) throw internalError();
    const auditOwner = await profileAuditOwner(c, subject);
    await profileService(c, dependencies).delete(subject);
    console.log({
      schema_version: 1,
      event: "profile.audit",
      level: "info",
      action: "delete",
      result: "success",
      request_id: c.get("requestId"),
      ...(auditOwner === undefined ? {} : { owner: auditOwner }),
    });
    return c.body(null, 204);
  });

  app.openapi(githubOwnerRoute, async (c) => {
    const { owner } = c.req.valid("param");
    return c.json(GitHubOwnerSchema.parse(await githubService.getOwner(owner, c.req.raw.signal)), 200);
  });

  app.openapi(githubOwnerRepositoriesRoute, async (c) => {
    const { owner } = c.req.valid("param");
    const { limit, cursor } = c.req.valid("query");
    const result = await githubService.listOwnerRepositories(
      owner,
      { limit, ...(cursor === undefined ? {} : { cursor }) },
      c.req.raw.signal,
    );
    const response = c.json(GitHubRepositoryPageSchema.parse({ repos: result.items, count: result.items.length }), 200);
    const link = githubLink(`/v1/github/owners/${owner}/repos`, limit, result);
    if (link !== undefined) response.headers.set("Link", link);
    return response;
  });

  app.openapi(githubRepositoryRoute, async (c) => {
    const { owner, repo } = c.req.valid("param");
    return c.json(GitHubRepositorySchema.parse(await githubService.getRepository(owner, repo, c.req.raw.signal)), 200);
  });

  app.openapi(githubRepositoryActivityRoute, async (c) => {
    const { owner, repo } = c.req.valid("param");
    const { limit, cursor } = c.req.valid("query");
    const result = await githubService.listRepositoryActivity(
      owner,
      repo,
      { limit, ...(cursor === undefined ? {} : { cursor }) },
      c.req.raw.signal,
    );
    const response = c.json(
      GitHubActivityPageSchema.parse({ activities: result.items, count: result.items.length }),
      200,
    );
    const link = githubLink(`/v1/github/repos/${owner}/${repo}/activity`, limit, result);
    if (link !== undefined) response.headers.set("Link", link);
    return response;
  });

  app.openapi(githubRepositoryLanguagesRoute, async (c) => {
    const { owner, repo } = c.req.valid("param");
    const languages = await githubService.listRepositoryLanguages(owner, repo, c.req.raw.signal);
    return c.json(GitHubLanguagesSchema.parse({ languages }), 200);
  });

  app.openapi(githubRepositoryTagsRoute, async (c) => {
    const { owner, repo } = c.req.valid("param");
    const { limit, cursor } = c.req.valid("query");
    const result = await githubService.listRepositoryTags(
      owner,
      repo,
      { limit, ...(cursor === undefined ? {} : { cursor }) },
      c.req.raw.signal,
    );
    const response = c.json(GitHubTagPageSchema.parse({ tags: result.items, count: result.items.length }), 200);
    const link = githubLink(`/v1/github/repos/${owner}/${repo}/tags`, limit, result);
    if (link !== undefined) response.headers.set("Link", link);
    return response;
  });

  const openApiDocument = app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "Hono Playground",
      version: "0.1.0",
      description: "Cloudflare Workers portable API using Hono, Alchemy, Drizzle, and JSON:API.",
    },
    servers: [{ url: "/" }],
  });

  app.get(openApiDocumentRoute.path, (c) => c.json(openApiDocument));
  app.get(
    apiDocumentationRoute.path,
    swaggerUI({
      url: openApiDocumentRoute.path,
      title: "Hono Playground API",
      version: SWAGGER_UI_VERSION,
      manuallySwaggerUIHtml: renderSwaggerUiBody,
    }),
  );

  app.notFound((c) => {
    c.set("outcome", "not_found");
    const error = new AppError({ code: "not_found" });
    const pathname = new URL(c.req.url).pathname;
    const metadata = resolveRoute(pathname, c.req.method).metadata;
    return isJsonApiRoute(metadata)
      ? jsonApiErrorResponse(error, c.req.method)
      : problemResponse(error, c.req.method, selectProblemContentType(c.req.header("Accept") ?? null));
  });

  app.onError((error, c) => {
    const normalized =
      error instanceof AppError
        ? error
        : error instanceof HTTPException && error.message === "Malformed JSON in request body"
          ? invalidJsonError()
          : internalError();
    c.set("outcome", normalized.code);
    if (normalized.operatorCode !== undefined) {
      console.error({
        schema_version: 1,
        event: "operator.error",
        level: "error",
        code: normalized.operatorCode,
        request_id: c.get("requestId"),
      });
    } else if (normalized.status >= 500) {
      console.error({
        schema_version: 1,
        event: "operator.error",
        level: "error",
        code: "unhandled_exception",
        request_id: c.get("requestId"),
      });
    }
    const pathname = new URL(c.req.url).pathname;
    const metadata = resolveRoute(pathname, c.req.method).metadata;
    return isJsonApiRoute(metadata)
      ? jsonApiErrorResponse(normalized, c.req.method)
      : problemResponse(normalized, c.req.method, selectProblemContentType(c.req.header("Accept") ?? null));
  });

  return app;
};

export const app = createApp();
