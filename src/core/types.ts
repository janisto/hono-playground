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

export type TraceMetadata = {
  traceId: string;
  parentSpanId: string;
};

export type D1Metrics = {
  queryCount: number;
  rowsRead: number;
  rowsWritten: number;
};

export interface RuntimeConfig {
  environment: EnvironmentName;
  maximumRequestBytes: number;
  rateLimitMode: RateLimitMode;
}

export type AppVariables = {
  requestId: string;
  routeMetadata: RouteMetadata;
  traceMetadata: TraceMetadata | undefined;
  runtimeConfig: RuntimeConfig;
  identitySubject: string | undefined;
  d1Metrics: D1Metrics;
  outcome: string;
};

export type AppEnvironment = {
  Bindings: RuntimeBindings;
  Variables: AppVariables;
};
