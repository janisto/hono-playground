const OPERATION_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const PROFILE_PATH = "/v1/profile";
const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";

export type OpenApiDeploymentProfile = "custom-domain-production" | "workers-dev-demo";
export type OpenApiRateLimitMode = "workers-binding" | "workers-binding+waf";

export type DeploymentOpenApiOptions = Readonly<{
  deploymentProfile: OpenApiDeploymentProfile;
  managedOauthEnabled: boolean;
  rateLimitMode: OpenApiRateLimitMode;
}>;

export type DeploymentOpenApiDocument = Readonly<Record<string, unknown>>;

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = {
  [key: string]: JsonValue;
  components?: JsonValue;
  paths?: JsonValue;
  security?: JsonValue;
};
type UnknownObject = Record<string, unknown> & {
  CloudflareAccessCookie?: unknown;
  CloudflareAccessOAuth?: unknown;
  components?: unknown;
  in?: unknown;
  name?: unknown;
  openapi?: unknown;
  paths?: unknown;
  security?: unknown;
  securitySchemes?: unknown;
};

const isObject = (value: unknown): value is UnknownObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireObject = (value: unknown, label: string): UnknownObject => {
  if (!isObject(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
};

const cloneJson = (value: unknown, ancestors = new Set<object>()): JsonValue => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("OpenAPI documents must contain only finite JSON numbers");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new Error("OpenAPI documents must not contain JavaScript object cycles");
    }
    ancestors.add(value);
    const clone = value.map((item) => cloneJson(item, ancestors));
    ancestors.delete(value);
    return clone;
  }
  if (!isObject(value)) {
    throw new TypeError("OpenAPI documents must contain only JSON values");
  }
  if (ancestors.has(value)) {
    throw new Error("OpenAPI documents must not contain JavaScript object cycles");
  }

  ancestors.add(value);
  const clone = Object.fromEntries(
    Object.entries(value).map(([key, child]): [string, JsonValue] => [
      key,
      cloneJson(child, ancestors),
    ]),
  );
  ancestors.delete(value);
  return clone;
};

const deepFreeze = <T extends JsonValue>(value: T): T => {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
  } else if (isObject(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child as JsonValue);
    }
  }
  Object.freeze(value);
  return value;
};

const assertAllowedOptions = (options: DeploymentOpenApiOptions): void => {
  if (
    options.deploymentProfile !== "workers-dev-demo" &&
    options.deploymentProfile !== "custom-domain-production"
  ) {
    throw new Error(`Unsupported deployment profile: ${String(options.deploymentProfile)}`);
  }
  if (
    options.rateLimitMode !== "workers-binding" &&
    options.rateLimitMode !== "workers-binding+waf"
  ) {
    throw new Error(`Unsupported rate-limit mode: ${String(options.rateLimitMode)}`);
  }
  if (typeof options.managedOauthEnabled !== "boolean") {
    throw new TypeError("managedOauthEnabled must be a boolean");
  }
  if (
    options.deploymentProfile === "workers-dev-demo" &&
    options.rateLimitMode === "workers-binding+waf"
  ) {
    throw new Error("workers.dev cannot truthfully advertise a zone-scoped WAF rate limit");
  }
};

const assertNoAccessAssertionParameter = (value: unknown): void => {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoAccessAssertionParameter(item);
    }
    return;
  }
  if (!isObject(value)) {
    return;
  }

  if (
    typeof value.name === "string" &&
    value.name.toLowerCase() === ACCESS_ASSERTION_HEADER &&
    typeof value.in === "string" &&
    value.in.toLowerCase() === "header"
  ) {
    throw new Error("Cf-Access-Jwt-Assertion is injected by Access and must not be client input");
  }
  for (const child of Object.values(value)) {
    assertNoAccessAssertionParameter(child);
  }
};

const securityRequirements = (managedOauthEnabled: boolean): JsonValue[] => [
  { CloudflareAccessCookie: [] },
  ...(managedOauthEnabled ? [{ CloudflareAccessOAuth: [] }] : []),
];

/**
 * Deep-clones a canonical OpenAPI 3.1 document and decorates only its deployment/authentication view.
 * The input remains untouched and the returned document is deeply frozen.
 */
export const decorateOpenApiForDeployment = (
  document: unknown,
  options: DeploymentOpenApiOptions,
): DeploymentOpenApiDocument => {
  assertAllowedOptions(options);
  const source = requireObject(document, "OpenAPI document");
  if (source.openapi !== "3.1.0") {
    throw new Error("Deployment decoration requires an OpenAPI 3.1.0 document");
  }
  assertNoAccessAssertionParameter(source);

  const decorated = requireObject(cloneJson(source), "Cloned OpenAPI document") as JsonObject;
  decorated["x-cloudflare-deployment-profile"] = options.deploymentProfile;
  decorated["x-cloudflare-edge-access-scope"] =
    options.deploymentProfile === "workers-dev-demo" ? "worker" : "profile-path";
  decorated["x-cloudflare-rate-limit-mode"] = options.rateLimitMode;

  const components = Object.hasOwn(decorated, "components")
    ? requireObject(decorated.components, "OpenAPI components")
    : {};
  decorated.components = components as JsonObject;
  const securitySchemes = Object.hasOwn(components, "securitySchemes")
    ? requireObject(components.securitySchemes, "OpenAPI components.securitySchemes")
    : {};
  components.securitySchemes = securitySchemes;

  securitySchemes.CloudflareAccessCookie = {
    type: "apiKey",
    in: "cookie",
    name: "CF_Authorization",
    description:
      "Cloudflare Access browser session cookie. Cloudflare Access issues and manages this HttpOnly credential; the initial API accepts only user identities, and browser JavaScript must not read or set it.",
  };
  if (options.managedOauthEnabled) {
    securitySchemes.CloudflareAccessOAuth = {
      type: "http",
      scheme: "bearer",
      description:
        "Opaque, user-based bearer token obtained through Cloudflare Access Managed OAuth. Discover authorization by following the live Access WWW-Authenticate challenge and its RFC 9728 protected-resource and RFC 8414 authorization-server metadata. Cloudflare Access issues and manages this credential; the initial API accepts only user identities.",
      "x-cloudflare-managed-oauth": true,
    };
  } else {
    delete securitySchemes.CloudflareAccessOAuth;
  }

  const paths = requireObject(decorated.paths, "OpenAPI paths");
  let profileOperationCount = 0;
  for (const [path, pathValue] of Object.entries(paths)) {
    if (path.startsWith("x-")) {
      continue;
    }
    const pathItem = requireObject(pathValue, `OpenAPI path item ${path}`);
    for (const method of OPERATION_METHODS) {
      if (!Object.hasOwn(pathItem, method)) {
        continue;
      }
      const operation = requireObject(
        pathItem[method],
        `OpenAPI operation ${method.toUpperCase()} ${path}`,
      );
      delete operation.security;
      if (path === PROFILE_PATH) {
        profileOperationCount += 1;
        if (options.deploymentProfile === "custom-domain-production") {
          operation.security = securityRequirements(options.managedOauthEnabled);
        }
      }
    }
  }

  if (profileOperationCount === 0) {
    throw new Error(`OpenAPI document has no operations at ${PROFILE_PATH}`);
  }

  if (options.deploymentProfile === "workers-dev-demo") {
    decorated.security = securityRequirements(options.managedOauthEnabled);
  } else {
    delete decorated.security;
  }

  return deepFreeze(decorated);
};
