import type { WorkerEnv } from "../../alchemy.run.ts";
import type { BodyHeaderCheck } from "./body.ts";
import type { ParsedQuery } from "./query.ts";

export type EnvironmentName = "development" | "staging" | "test" | "production";
export type RateLimitMode = "none" | "workers-binding";

type WidenGeneratedBinding<Value> = Value extends string ? string : Value;

export type RuntimeBindings = {
  [Name in keyof WorkerEnv]?: WidenGeneratedBinding<WorkerEnv[Name]>;
} & { DB: WorkerEnv["DB"] };

export type RouteMetadata = {
  template: string;
  operationId: string;
  kind: "plain-public" | "json-api-public" | "profile-read" | "profile-write" | "docs" | "unmatched";
  queryNames: ReadonlySet<string>;
  bodyProfile?: "json" | "json-api";
};

export interface RuntimeConfig {
  environment: EnvironmentName;
  maximumRequestBytes: number;
  rateLimitMode: RateLimitMode;
  publicOrigin: string;
}

export type AppVariables = {
  requestId: string;
  routeMetadata: RouteMetadata;
  runtimeConfig: RuntimeConfig;
  identitySubject: string | undefined;
  bodyText: string | undefined;
  bodyHeaders: BodyHeaderCheck | undefined;
  parsedQuery: ParsedQuery;
  variesByOrigin: boolean;
  outcome: string;
};

export type AppEnvironment = {
  Bindings: RuntimeBindings;
  Variables: AppVariables;
};
