import type { WorkerEnv } from "../../alchemy.run.js";

export type EnvironmentName = "development" | "staging" | "test" | "production";
export type RateLimitMode = "none" | "workers-binding";

type WidenGeneratedBinding<Value> = Value extends string ? string : Value;

export type RuntimeBindings = {
  [Name in keyof WorkerEnv]?: WidenGeneratedBinding<WorkerEnv[Name]>;
} & { DB: WorkerEnv["DB"] };

export type RouteMetadata = {
  template: string;
  operationId: string;
  kind: "public" | "resource" | "profile-read" | "profile-write" | "docs" | "unmatched";
};

export interface RuntimeConfig {
  environment: EnvironmentName;
  maximumRequestBytes: number;
  rateLimitMode: RateLimitMode;
}

export type AppVariables = {
  requestId: string;
  routeMetadata: RouteMetadata;
  runtimeConfig: RuntimeConfig;
  identitySubject: string | undefined;
  jsonApiBodyText: string | undefined;
  outcome: string;
};

export type AppEnvironment = {
  Bindings: RuntimeBindings;
  Variables: AppVariables;
};
