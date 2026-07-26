import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";

import {
  healthRoute,
  itemGetRoute,
  itemsRoute,
  profileDeleteRoute,
  profileGetRoute,
  profilePatchRoute,
  profilePostRoute,
} from "./api/routes.ts";
import { ACCESS_ASSERTION_HEADER, createAccessVerifier } from "./auth/access.ts";
import type { AccessVerifier } from "./auth/types.ts";
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
import { HealthResponseSchema } from "./models/health.ts";
import { type Item, ItemCollectionDocumentSchema, ItemDocumentSchema, type ItemResource } from "./models/items.ts";
import { JSON_API_MEDIA_TYPE, JSON_API_OBJECT } from "./models/json-api.ts";
import { type Profile, ProfileDocumentSchema, type ProfileResource } from "./models/profile.ts";
import { InvalidCursorError, MAX_CURSOR_LENGTH } from "./pagination/cursor.ts";
import { paginate } from "./pagination/paginate.ts";
import { DrizzleProfileRepository, type ProfileRepository } from "./repositories/profile-repository.ts";
import { ProfileService } from "./services/profile-service.ts";

export type AppDependencies = {
  accessVerifier?: AccessVerifier;
  profileRepositoryFactory?: (c: Context<AppEnvironment>) => ProfileRepository;
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

const accessMiddleware = (dependencies: AppDependencies): MiddlewareHandler<AppEnvironment> => {
  return async (c, next) => {
    const verifier =
      dependencies.accessVerifier ??
      createAccessVerifier({
        teamDomain: c.env.ACCESS_TEAM_DOMAIN,
        audience: c.env.ACCESS_AUD,
      });
    const identity = await enterSpan("access.verify", () => verifier(c.req.header(ACCESS_ASSERTION_HEADER)));
    c.set("identitySubject", identity.sub);
    await next();
  };
};

const profileLimiter: MiddlewareHandler<AppEnvironment> = async (c, next) => {
  const subject = c.get("identitySubject");
  if (subject === undefined) throw internalError();
  await enforceProfileRateLimit(c, subject, c.req.method === "GET" || c.req.method === "HEAD" ? "read" : "write");
  await next();
};

const strictJsonBody: MiddlewareHandler<AppEnvironment> = async (c, next) => {
  if (c.req.method !== "POST" && c.req.method !== "PATCH") {
    await next();
    return;
  }
  const text = c.get("jsonApiBodyText");
  if (text === undefined) throw internalError("runtime_configuration_invalid");
  try {
    assertStrictJsonText(text);
  } catch {
    throw invalidJsonError();
  }
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
  return {
    type: "items",
    id,
    attributes: {
      ...attributes,
      createdAt: createdAt.toISOString(),
    },
    links: { self: `/v1/items/${id}` },
  };
};

const profileResource = (profile: Profile): ProfileResource => {
  const { id, createdAt, updatedAt, ...attributes } = profile;
  return {
    type: "profiles",
    id,
    attributes: {
      ...attributes,
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    },
    links: { self: "/v1/profiles/current" },
  };
};

const profileDocument = (profile: Profile) =>
  ProfileDocumentSchema.parse({
    jsonapi: JSON_API_OBJECT,
    links: {
      self: "/v1/profiles/current",
    },
    data: profileResource(profile),
  });

const hasUnrecognizedKey = (
  error: {
    readonly issues: readonly {
      readonly code: string;
      readonly path: readonly PropertyKey[];
      readonly keys?: readonly string[];
    }[];
  },
  path: readonly PropertyKey[],
  key: string,
): boolean =>
  error.issues.some(
    (issue) =>
      issue.code === "unrecognized_keys" &&
      issue.path.length === path.length &&
      issue.path.every((segment, index) => segment === path[index]) &&
      issue.keys?.includes(key) === true,
  );

const hasOwnMemberAt = (value: unknown, path: readonly PropertyKey[]): boolean => {
  let current = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) {
      return false;
    }
    current = Reflect.get(current, segment);
  }
  return true;
};

export const createApp = (dependencies: AppDependencies = {}) => {
  const app = new OpenAPIHono<AppEnvironment>({
    strict: true,
    defaultHook: async (result, c) => {
      if (!result.success) {
        const pathname = new URL(c.req.url).pathname;
        const document = result.target === "json" ? await c.req.json<unknown>() : undefined;
        if (
          c.req.method === "POST" &&
          pathname === "/v1/profiles" &&
          hasOwnMemberAt(document, ["data", "id"]) &&
          hasUnrecognizedKey(result.error, ["data"], "id")
        ) {
          throw new AppError({
            status: 403,
            code: "client_generated_id_unsupported",
            detail: "Client-generated profile IDs are not supported",
          });
        }
        if (
          pathname.startsWith("/v1/profiles") &&
          hasOwnMemberAt(document, ["data", "type"]) &&
          result.error.issues.some(
            (issue) => issue.path.length === 2 && issue.path[0] === "data" && issue.path[1] === "type",
          )
        ) {
          throw new AppError({
            status: 409,
            code: "resource_type_mismatch",
            detail: "Resource type does not match endpoint",
          });
        }
        throw zodValidationError(result.error, result.target === "query" ? "query" : "body");
      }
    },
  });

  app.use("*", lifecycle());
  app.use(
    "*",
    secureHeaders({
      permissionsPolicy: {},
      referrerPolicy: "strict-origin-when-cross-origin",
      strictTransportSecurity: false,
      xFrameOptions: "DENY",
    }),
  );
  app.use("*", runtimeConfiguration(dependencies.maximumRequestBytes));
  app.use("*", httpPolicy());
  app.use("/v1/profiles", accessMiddleware(dependencies));
  app.use("/v1/profiles/current", accessMiddleware(dependencies));
  app.use("/v1/profiles", profileLimiter);
  app.use("/v1/profiles/current", profileLimiter);
  app.use("/v1/profiles", strictJsonBody);
  app.use("/v1/profiles/current", strictJsonBody);

  app.openAPIRegistry.registerComponent("securitySchemes", "CloudflareAccess", {
    type: "apiKey",
    in: "cookie",
    name: "CF_Authorization",
    description: "Cloudflare Access browser session cookie.",
  });

  app.openapi(healthRoute, (c) => {
    const body = enterSpan("response.validate", () => HealthResponseSchema.parse({ status: "healthy" }));
    return c.json(body, 200);
  });

  app.openapi(itemsRoute, (c) => {
    const query = c.req.valid("query");
    const cursor = query["page[cursor]"];
    const category = query["filter[category]"];
    const limit = query["page[limit]"];
    if (cursor !== undefined && cursor.length > MAX_CURSOR_LENGTH) {
      throw new AppError({ status: 400, code: "invalid_cursor", detail: "Invalid cursor" });
    }
    const filtered = category === undefined ? ITEMS : ITEMS.filter((item) => item.category === category);

    let result: ReturnType<typeof paginate<(typeof ITEMS)[number]>>;
    try {
      result = paginate({
        items: filtered,
        ...(cursor === undefined ? {} : { cursor }),
        limit,
        cursorType: "item",
        getId: (item) => item.id,
        basePath: "/v1/items",
        ...(category === undefined ? {} : { category }),
      });
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        throw new AppError({ status: 400, code: "invalid_cursor", detail: "Invalid cursor" });
      }
      throw error;
    }

    const body = enterSpan("response.validate", () =>
      ItemCollectionDocumentSchema.parse({
        jsonapi: JSON_API_OBJECT,
        links: {
          ...result.links,
        },
        data: result.items.map(itemResource),
        meta: { total: result.total },
      }),
    );
    return jsonApiResponse(c.json(body, 200));
  });

  app.openapi(itemGetRoute, (c) => {
    const { itemId } = c.req.valid("param");
    const item = ITEMS.find((candidate) => candidate.id === itemId);
    if (item === undefined) {
      throw new AppError({ status: 404, code: "not_found", detail: "Item not found" });
    }
    const body = enterSpan("response.validate", () =>
      ItemDocumentSchema.parse({
        jsonapi: JSON_API_OBJECT,
        links: {
          self: `/v1/items/${item.id}`,
        },
        data: itemResource(item),
      }),
    );
    return jsonApiResponse(c.json(body, 200));
  });

  app.openapi(profilePostRoute, async (c) => {
    const subject = c.get("identitySubject");
    if (subject === undefined) throw internalError();
    const auditOwner = await profileAuditOwner(c, subject);
    const service = profileService(c, dependencies);
    const profile = await enterSpan("profile.service", () =>
      enterSpan("profile.repository", () => service.create(subject, c.req.valid("json").data.attributes)),
    );
    const body = enterSpan("response.validate", () => profileDocument(profile));
    const response = jsonApiResponse(c.json(body, 201));
    response.headers.set("Location", "/v1/profiles/current");
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
    const service = profileService(c, dependencies);
    const profile = await enterSpan("profile.service", () =>
      enterSpan("profile.repository", () => service.get(subject)),
    );
    const body = enterSpan("response.validate", () => profileDocument(profile));
    return jsonApiResponse(c.json(body, 200));
  });

  app.openapi(profilePatchRoute, async (c) => {
    const subject = c.get("identitySubject");
    if (subject === undefined) throw internalError();
    const input = c.req.valid("json").data;
    if (input.id !== subject) {
      throw new AppError({
        status: 409,
        code: "resource_identity_mismatch",
        detail: "Resource ID does not match the current profile",
      });
    }
    const auditOwner = await profileAuditOwner(c, subject);
    const service = profileService(c, dependencies);
    const profile = await enterSpan("profile.service", () =>
      enterSpan("profile.repository", () => service.update(subject, input.attributes ?? {})),
    );
    const body = enterSpan("response.validate", () => profileDocument(profile));
    console.log({
      schema_version: 1,
      event: "profile.audit",
      level: "info",
      action: "update",
      result: "success",
      request_id: c.get("requestId"),
      ...(auditOwner === undefined ? {} : { owner: auditOwner }),
    });
    return jsonApiResponse(c.json(body, 200));
  });

  app.openapi(profileDeleteRoute, async (c) => {
    const subject = c.get("identitySubject");
    if (subject === undefined) throw internalError();
    const auditOwner = await profileAuditOwner(c, subject);
    const service = profileService(c, dependencies);
    await enterSpan("profile.service", () => enterSpan("profile.repository", () => service.delete(subject)));
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

  const openApiDocument = app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "Hono Playground",
      version: "0.1.0",
      description: "Cloudflare Workers REST API using Hono, Alchemy, Drizzle, and JSON:API.",
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
    const error = new AppError({ status: 404, code: "not_found", detail: "Not Found" });
    const pathname = new URL(c.req.url).pathname;
    return pathname === "/v1" || pathname.startsWith("/v1/")
      ? jsonApiErrorResponse(error, c.req.method)
      : problemResponse(error, c.req.method);
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
    return isJsonApiRoute(metadata) || pathname === "/v1" || pathname.startsWith("/v1/")
      ? jsonApiErrorResponse(normalized, c.req.method)
      : problemResponse(normalized, c.req.method);
  });

  return app;
};

export const app = createApp();
