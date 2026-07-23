export type EnvironmentName = "development" | "test" | "production";
export type DeploymentProfile = "workers-dev-demo" | "custom-domain-production";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type RateLimitMode = "none" | "workers-binding" | "workers-binding+waf";

type WidenGeneratedBinding<Value> = Value extends string ? string : Value;

export type RuntimeBindings = {
  [Name in keyof Env]?: WidenGeneratedBinding<Env[Name]>;
} & { DB: Env["DB"] };

export type RouteMetadata = {
  template: string;
  operationId: string;
  kind: "public" | "profile-read" | "profile-write" | "docs" | "unmatched";
};

export type TraceMetadata = {
  traceId: string;
  parentSpanId: string;
};

export type D1Metrics = {
  durationMs: number;
  rowsRead: number;
  rowsWritten: number;
};

export interface RuntimeConfig {
  environment: EnvironmentName;
  deploymentProfile: DeploymentProfile;
  logLevel: LogLevel;
  maximumRequestBytes: number;
  managedOauthEnabled: boolean;
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
