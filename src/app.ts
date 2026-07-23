import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";

import {
  healthRoute,
  helloGetRoute,
  helloPostRoute,
  itemsRoute,
  profileDeleteRoute,
  profileGetRoute,
  profilePatchRoute,
  profilePostRoute,
} from "./api/routes.js";
import { ACCESS_ASSERTION_HEADER, createAccessVerifier } from "./auth/access.js";
import type { AccessVerifier } from "./auth/types.js";
import { auditPseudonym } from "./core/crypto.js";
import { AppError, internalError, problemResponse, zodValidationError } from "./core/errors.js";
import { httpPolicy } from "./core/http-policy.js";
import { lifecycle, runtimeConfiguration } from "./core/lifecycle.js";
import { enforceProfileRateLimit } from "./core/rate-limit.js";
import { appendHeaderValue, appendSchemaLink } from "./core/schema-links.js";
import { enterSpan } from "./core/tracing.js";
import type { AppEnvironment, D1Metrics } from "./core/types.js";
import { ITEMS } from "./data/items.js";
import { DOCS_ASSETS } from "./generated/docs-assets.js";
import { HealthResponseSchema } from "./models/health.js";
import { GreetingSchema, type Language } from "./models/hello.js";
import { ItemListSchema } from "./models/items.js";
import { ProfileSchema } from "./models/profile.js";
import { getDeploymentOpenApiDocument, STANDALONE_SCHEMA_REGISTRY } from "./openapi/artifacts.js";
import { InvalidCursorError, MAX_CURSOR_LENGTH } from "./pagination/cursor.js";
import { paginate } from "./pagination/paginate.js";
import { D1ProfileRepository, type ProfileRepository } from "./repositories/profile-repository.js";
import { ProfileService } from "./services/profile-service.js";

const GREETINGS: Readonly<Record<Language, string>> = {
  en: "Hello",
  fi: "Hei",
  es: "Hola",
  fr: "Bonjour",
  de: "Hallo",
};

export type AppDependencies = {
  accessVerifier?: AccessVerifier;
  profileRepositoryFactory?: (c: Context<AppEnvironment>) => ProfileRepository;
  now?: () => Date;
  maximumRequestBytes?: number;
};

const mergeD1Metrics = (current: D1Metrics, next: D1Metrics): D1Metrics => ({
  durationMs: current.durationMs + next.durationMs,
  rowsRead: current.rowsRead + next.rowsRead,
  rowsWritten: current.rowsWritten + next.rowsWritten,
});

const createRepository = (
  c: Context<AppEnvironment>,
  dependencies: AppDependencies,
): ProfileRepository => {
  const injected = dependencies.profileRepositoryFactory?.(c);
  if (injected !== undefined) return injected;
  const database = c.env.DB;
  if (
    database === undefined ||
    typeof database.prepare !== "function" ||
    typeof database.batch !== "function"
  ) {
    throw internalError("runtime_configuration_invalid");
  }
  return new D1ProfileRepository(database, {
    onMetadata: (metadata) => c.set("d1Metrics", mergeD1Metrics(c.get("d1Metrics"), metadata)),
  });
};

const profileService = (
  c: Context<AppEnvironment>,
  dependencies: AppDependencies,
): ProfileService =>
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
    const identity = await enterSpan("access.verify", () =>
      verifier(c.req.header(ACCESS_ASSERTION_HEADER)),
    );
    c.set("identitySubject", identity.sub);
    await next();
  };
};

const profileLimiter: MiddlewareHandler<AppEnvironment> = async (c, next) => {
  const subject = c.get("identitySubject");
  if (subject === undefined) throw internalError();
  await enforceProfileRateLimit(c, subject, c.req.method === "GET" ? "read" : "write");
  await next();
};

const profileAuditOwner = async (
  c: Context<AppEnvironment>,
  subject: string,
): Promise<string | undefined> => {
  if (
    c.env.AUDIT_SUBJECT_HMAC_KEY !== undefined &&
    c.env.AUDIT_SUBJECT_HMAC_KEY === c.env.RATE_LIMIT_KEY_HMAC_KEY
  ) {
    throw internalError("runtime_configuration_invalid");
  }
  return auditPseudonym(c.env.AUDIT_SUBJECT_HMAC_KEY, subject);
};

const addSchemaLink = <T extends Response>(response: T, schemaName: string): T => {
  appendSchemaLink(response.headers, schemaName);
  return response;
};

const docsHtml = (): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Hono Playground API</title>
    <link rel="icon" type="image/png" sizes="16x16" href="${DOCS_ASSETS.favicon16}">
    <link rel="icon" type="image/png" sizes="32x32" href="${DOCS_ASSETS.favicon32}">
    <link rel="stylesheet" href="${DOCS_ASSETS.stylesheet}">
    <link rel="stylesheet" href="${DOCS_ASSETS.customStylesheet}">
  </head>
  <body>
    <main id="swagger-ui"></main>
    <script src="${DOCS_ASSETS.bundleScript}"></script>
    <script src="${DOCS_ASSETS.initializerScript}"></script>
  </body>
</html>`;

export const createApp = (dependencies: AppDependencies = {}) => {
  const app = new OpenAPIHono<AppEnvironment>({
    strict: true,
    defaultHook: (result) => {
      if (!result.success) {
        throw zodValidationError(result.error, result.target === "query" ? "query" : "body");
      }
    },
  });

  app.use(
    "*",
    lifecycle(
      dependencies.maximumRequestBytes === undefined
        ? {}
        : { maximumRequestBytes: dependencies.maximumRequestBytes },
    ),
  );
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
  app.use("/v1/profile", accessMiddleware(dependencies));
  app.use("/v1/profile", profileLimiter);

  app.openapi(healthRoute, (c) => {
    const body = enterSpan("response.validate", () =>
      HealthResponseSchema.parse({ status: "healthy" }),
    );
    return addSchemaLink(c.json(body, 200), "HealthResponse");
  });

  app.openapi(helloGetRoute, (c) => {
    const body = enterSpan("response.validate", () =>
      GreetingSchema.parse({ message: "Hello, World!" }),
    );
    return addSchemaLink(c.json(body, 200), "Greeting");
  });

  app.openapi(helloPostRoute, (c) => {
    const input = c.req.valid("json");
    const body = enterSpan("response.validate", () =>
      GreetingSchema.parse({ message: `${GREETINGS[input.language]}, ${input.name}!` }),
    );
    return addSchemaLink(c.json(body, 200), "Greeting");
  });

  app.openapi(itemsRoute, (c) => {
    const query = c.req.valid("query");
    if (query.cursor !== undefined && query.cursor.length > MAX_CURSOR_LENGTH) {
      throw new AppError({ status: 400, code: "invalid_cursor", detail: "Invalid cursor" });
    }
    const filtered =
      query.category === undefined
        ? ITEMS
        : ITEMS.filter((item) => item.category === query.category);

    let result: ReturnType<typeof paginate<(typeof ITEMS)[number]>>;
    try {
      result = paginate({
        items: filtered,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        limit: query.limit,
        cursorType: "item",
        getId: (item) => item.id,
        basePath: "/v1/items",
        ...(query.category === undefined ? {} : { category: query.category }),
      });
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        throw new AppError({ status: 400, code: "invalid_cursor", detail: "Invalid cursor" });
      }
      throw error;
    }

    const body = enterSpan("response.validate", () =>
      ItemListSchema.parse({ items: result.items, total: result.total }),
    );
    const response = c.json(body, 200);
    if (result.linkHeader !== null) appendHeaderValue(response.headers, "Link", result.linkHeader);
    return addSchemaLink(response, "ItemList");
  });

  app.openapi(profilePostRoute, async (c) => {
    const subject = c.get("identitySubject");
    if (subject === undefined) throw internalError();
    const auditOwner = await profileAuditOwner(c, subject);
    const service = profileService(c, dependencies);
    const profile = await enterSpan("profile.service", () =>
      enterSpan("profile.repository", () => service.create(subject, c.req.valid("json"))),
    );
    const body = enterSpan("response.validate", () => ProfileSchema.parse(profile));
    const response = addSchemaLink(c.json(body, 201), "Profile");
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
    const service = profileService(c, dependencies);
    const profile = await enterSpan("profile.service", () =>
      enterSpan("profile.repository", () => service.get(subject)),
    );
    const body = enterSpan("response.validate", () => ProfileSchema.parse(profile));
    return addSchemaLink(c.json(body, 200), "Profile");
  });

  app.openapi(profilePatchRoute, async (c) => {
    const subject = c.get("identitySubject");
    if (subject === undefined) throw internalError();
    const auditOwner = await profileAuditOwner(c, subject);
    const service = profileService(c, dependencies);
    const profile = await enterSpan("profile.service", () =>
      enterSpan("profile.repository", () => service.update(subject, c.req.valid("json"))),
    );
    const body = enterSpan("response.validate", () => ProfileSchema.parse(profile));
    console.log({
      schema_version: 1,
      event: "profile.audit",
      level: "info",
      action: "update",
      result: "success",
      request_id: c.get("requestId"),
      ...(auditOwner === undefined ? {} : { owner: auditOwner }),
    });
    return addSchemaLink(c.json(body, 200), "Profile");
  });

  app.openapi(profileDeleteRoute, async (c) => {
    const subject = c.get("identitySubject");
    if (subject === undefined) throw internalError();
    const auditOwner = await profileAuditOwner(c, subject);
    const service = profileService(c, dependencies);
    await enterSpan("profile.service", () =>
      enterSpan("profile.repository", () => service.delete(subject)),
    );
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

  app.get("/openapi.json", (c) => {
    const config = c.get("runtimeConfig");
    const document = getDeploymentOpenApiDocument({
      deploymentProfile: config.deploymentProfile,
      managedOauthEnabled: config.managedOauthEnabled,
      rateLimitMode:
        config.rateLimitMode === "workers-binding+waf" ? "workers-binding+waf" : "workers-binding",
    });
    return c.json(document);
  });

  app.get("/schemas/:schemaName", (c) => {
    const pathname = new URL(c.req.url).pathname;
    const rawName = pathname.slice("/schemas/".length).replace(/\.json$/, "");
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(rawName)) {
      throw new AppError({ status: 404, code: "schema_not_found", detail: "Schema not found" });
    }
    const schema = STANDALONE_SCHEMA_REGISTRY.get(rawName as never);
    if (schema === undefined) {
      throw new AppError({ status: 404, code: "schema_not_found", detail: "Schema not found" });
    }
    const response = c.json(schema, 200);
    response.headers.set("Content-Type", "application/schema+json");
    return addSchemaLink(response, rawName);
  });

  app.get("/api-docs", (c) => c.html(docsHtml()));

  app.notFound((c) => {
    c.set("outcome", "not_found");
    return problemResponse(
      new AppError({ status: 404, code: "not_found", detail: "Not Found" }),
      c.req.method,
    );
  });

  app.onError((error, c) => {
    const normalized =
      error instanceof AppError
        ? error
        : error instanceof HTTPException && error.message === "Malformed JSON in request body"
          ? zodValidationError({
              issues: [
                { code: "custom", path: [], message: "Invalid JSON body", input: undefined },
              ],
            } as never)
          : internalError();
    c.set("outcome", normalized.code);
    if (normalized.operatorCode !== undefined) {
      console.error({
        schema_version: 1,
        event: "operator.error",
        level: "error",
        code: normalized.operatorCode,
      });
    } else if (normalized.status >= 500) {
      console.error({
        schema_version: 1,
        event: "operator.error",
        level: "error",
        code: "unhandled_exception",
      });
    }
    return problemResponse(normalized, c.req.method);
  });

  return app;
};

export const app = createApp();
