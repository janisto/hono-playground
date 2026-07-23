import { CANONICAL_OPENAPI_DOCUMENT } from "./canonical.js";
import {
  type DeploymentOpenApiDocument,
  type DeploymentOpenApiOptions,
  decorateOpenApiForDeployment,
  type OpenApiDeploymentProfile,
  type OpenApiRateLimitMode,
} from "./deployment.js";
import { getStandaloneSchemaRegistry } from "./standalone.js";

const PROFILES = ["workers-dev-demo", "custom-domain-production"] as const;
const OAUTH_STATES = [false, true] as const;
const RATE_LIMIT_MODES = ["workers-binding", "workers-binding+waf"] as const;

const variantKey = (options: DeploymentOpenApiOptions): string =>
  `${options.deploymentProfile}:${String(options.managedOauthEnabled)}:${options.rateLimitMode}`;

const buildDeploymentDocuments = (): Readonly<Record<string, DeploymentOpenApiDocument>> => {
  const documents: Record<string, DeploymentOpenApiDocument> = {};
  for (const deploymentProfile of PROFILES) {
    for (const managedOauthEnabled of OAUTH_STATES) {
      for (const rateLimitMode of RATE_LIMIT_MODES) {
        if (deploymentProfile === "workers-dev-demo" && rateLimitMode === "workers-binding+waf") {
          continue;
        }
        const options = { deploymentProfile, managedOauthEnabled, rateLimitMode } as const;
        documents[variantKey(options)] = decorateOpenApiForDeployment(
          CANONICAL_OPENAPI_DOCUMENT,
          options,
        );
      }
    }
  }
  return Object.freeze(documents);
};

const DEPLOYMENT_DOCUMENTS = buildDeploymentDocuments();

export const STANDALONE_SCHEMA_REGISTRY = getStandaloneSchemaRegistry(CANONICAL_OPENAPI_DOCUMENT);

export const getDeploymentOpenApiDocument = (
  options: Readonly<{
    deploymentProfile: OpenApiDeploymentProfile;
    managedOauthEnabled: boolean;
    rateLimitMode: OpenApiRateLimitMode;
  }>,
): DeploymentOpenApiDocument => {
  const document = DEPLOYMENT_DOCUMENTS[variantKey(options)];
  if (document === undefined) throw new TypeError("Unsupported OpenAPI deployment variant");
  return document;
};
