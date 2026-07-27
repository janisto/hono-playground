export type DeploymentStagePolicy = Readonly<{
  environment: "development" | "staging" | "production";
  persistent: boolean;
}>;

const PERSONAL_DEVELOPMENT_STAGE = /^dev_[a-z0-9][-_a-z0-9]*$/u;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
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

export const deploymentHostname = (hostname: string): string => {
  const labels = hostname.split(".");
  const valid =
    hostname === hostname.trim() &&
    hostname === hostname.toLowerCase() &&
    hostname.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => DNS_LABEL.test(label)) &&
    /[a-z]/u.test(labels.at(-1) ?? "") &&
    (hostname === PROJECT_ZONE || hostname.endsWith(`.${PROJECT_ZONE}`));

  if (!valid) {
    throw new RangeError(`Invalid WORKER_DOMAIN; use ${PROJECT_ZONE} or one of its subdomains`);
  }
  return hostname;
};
