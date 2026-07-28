export type DeploymentStagePolicy = Readonly<{
  environment: "development" | "staging" | "production";
  persistent: boolean;
}>;

const PERSONAL_DEVELOPMENT_STAGE = /^dev_[a-z0-9][-_a-z0-9]*$/u;
const PROJECT_ZONE = "hono-playground.dev";

export const deploymentStagePolicy = (stage: string): DeploymentStagePolicy => {
  if (stage === "prod") {
    return { environment: "production", persistent: true };
  }
  if (stage === "staging") {
    return { environment: "staging", persistent: true };
  }
  if (PERSONAL_DEVELOPMENT_STAGE.test(stage)) {
    return { environment: "development", persistent: false };
  }
  throw new RangeError(`Unsupported deployment stage "${stage}"; use prod, staging, or dev_<name>`);
};

export const deploymentTraceSamplingRate = (environment: DeploymentStagePolicy["environment"]): number =>
  environment === "production" ? 0.01 : 1;

export const deploymentHostname = (stage: "prod" | "staging", hostname: string): string => {
  const expectedHostname = stage === "prod" ? PROJECT_ZONE : `staging.${PROJECT_ZONE}`;
  if (hostname !== expectedHostname) {
    throw new RangeError(`Invalid WORKER_DOMAIN for ${stage}; use ${expectedHostname}`);
  }
  return hostname;
};
