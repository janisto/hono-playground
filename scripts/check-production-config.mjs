import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse, printParseErrorCode } from "jsonc-parser";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const configPath = path.join(repositoryRoot, "wrangler.jsonc");
const source = readFileSync(configPath, "utf8");
const parseErrors = [];
const config = parse(source, parseErrors, {
  allowTrailingComma: true,
  disallowComments: false,
});
const failures = parseErrors.map(
  (error) =>
    `wrangler.jsonc parse error at offset ${error.offset}: ${printParseErrorCode(error.error)}`,
);

const check = (condition, message) => {
  if (!condition) failures.push(message);
};

if (config === null || typeof config !== "object" || Array.isArray(config)) {
  failures.push("wrangler.jsonc must contain an object");
} else {
  const deploymentProfile = config.vars?.DEPLOYMENT_PROFILE;
  check(config.vars?.ENVIRONMENT === "production", "ENVIRONMENT must be production");
  check(
    ["info", "warn", "error"].includes(config.vars?.LOG_LEVEL),
    "LOG_LEVEL must be info, warn, or error in production",
  );
  check(
    config.vars?.MAX_REQUEST_SIZE_BYTES === "1000000",
    "MAX_REQUEST_SIZE_BYTES must preserve the 1000000-byte production contract",
  );
  check(
    deploymentProfile === "workers-dev-demo" || deploymentProfile === "custom-domain-production",
    "DEPLOYMENT_PROFILE must select a production topology",
  );
  check(config.preview_urls === false, "preview_urls must remain disabled");

  if (deploymentProfile === "workers-dev-demo") {
    check(config.workers_dev === true, "workers-dev-demo requires workers_dev: true");
    check(!Object.hasOwn(config, "routes"), "workers-dev-demo must not declare custom routes");
    check(
      config.vars?.RATE_LIMIT_MODE === "workers-binding",
      "workers-dev-demo requires RATE_LIMIT_MODE=workers-binding",
    );
  }
  if (deploymentProfile === "custom-domain-production") {
    check(config.workers_dev === false, "custom-domain-production requires workers_dev: false");
    check(
      Array.isArray(config.routes) && config.routes.length > 0,
      "custom-domain-production requires a reviewed custom route",
    );
    check(
      config.vars?.RATE_LIMIT_MODE === "workers-binding" ||
        config.vars?.RATE_LIMIT_MODE === "workers-binding+waf",
      "custom-domain-production requires an enabled Workers rate limiter mode",
    );
  }

  const accessDomain = config.vars?.ACCESS_TEAM_DOMAIN;
  let validAccessDomain = false;
  if (
    typeof accessDomain === "string" &&
    /^https:\/\/[a-z0-9.-]+(?::443)?\/?$/iu.test(accessDomain) &&
    !/(?:replace|placeholder|example)/iu.test(accessDomain)
  ) {
    try {
      const url = new URL(accessDomain);
      validAccessDomain =
        url.protocol === "https:" &&
        url.hostname.endsWith(".cloudflareaccess.com") &&
        url.hostname !== "cloudflareaccess.com" &&
        url.username === "" &&
        url.password === "" &&
        url.port === "" &&
        url.pathname === "/" &&
        url.search === "" &&
        url.hash === "";
    } catch {
      validAccessDomain = false;
    }
  }
  check(validAccessDomain, "ACCESS_TEAM_DOMAIN must be the live canonical Access team domain");

  const audience = config.vars?.ACCESS_AUD;
  check(
    typeof audience === "string" &&
      audience.length > 0 &&
      audience.length <= 256 &&
      /^[\x21-\x7e]+$/u.test(audience) &&
      !/replace|placeholder|example/iu.test(audience),
    "ACCESS_AUD must be the live non-placeholder Access audience",
  );
  check(
    config.vars?.MANAGED_OAUTH_ENABLED === "true" || config.vars?.MANAGED_OAUTH_ENABLED === "false",
    "MANAGED_OAUTH_ENABLED must match live Access readback",
  );

  const databases = Array.isArray(config.d1_databases) ? config.d1_databases : [];
  const database = databases.find((candidate) => candidate?.binding === "DB");
  check(databases.length === 1 && database !== undefined, "exactly one DB binding is required");
  check(
    typeof database?.database_id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(database.database_id),
    "DB must use a live UUID database_id",
  );
  check(database?.remote !== true, "the production DB binding must not enable local remote mode");

  const localNamespaceIds = new Set(["1001", "1002", "1003"]);
  const rateLimits = Array.isArray(config.ratelimits) ? config.ratelimits : [];
  check(rateLimits.length === 3, "exactly three production rate-limit bindings are required");
  const namespaceIds = rateLimits.map((rateLimit) => rateLimit?.namespace_id);
  check(
    namespaceIds.every(
      (namespaceId) =>
        typeof namespaceId === "string" &&
        /^[1-9][0-9]*$/u.test(namespaceId) &&
        !localNamespaceIds.has(namespaceId),
    ),
    "rate-limit bindings must use reviewed production namespace IDs, not reserved local IDs 1001/1002/1003",
  );
  check(
    new Set(namespaceIds).size === namespaceIds.length,
    "production rate-limit namespace IDs must be unique",
  );
}

if (failures.length > 0) {
  console.error("Production configuration is not deployable:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Production configuration preflight passed; live identifiers remain operator-owned.");
}
