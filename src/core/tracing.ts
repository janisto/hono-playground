import { tracing } from "cloudflare:workers";

export type SpanName = "access.verify" | "profile.service" | "profile.repository" | "response.validate";

type MinimalSpan = {
  readonly isTraced: boolean;
  setAttribute(name: string, value: string | number | boolean): void;
};

export type Tracer = {
  enterSpan<T>(name: string, callback: (span: MinimalSpan) => T): T;
};

export const enterSpanWith = <T>(
  tracer: Tracer | undefined,
  name: SpanName,
  callback: (span: MinimalSpan | undefined) => T,
): T => (tracer === undefined ? callback(undefined) : tracer.enterSpan(name, callback));

const isTracer = (candidate: unknown): candidate is Tracer =>
  typeof candidate === "object" && candidate !== null && typeof Reflect.get(candidate, "enterSpan") === "function";

const nativeTracer = isTracer(tracing) ? tracing : undefined;

export const enterSpan = <T>(name: SpanName, callback: (span: MinimalSpan | undefined) => T): T =>
  enterSpanWith(nativeTracer, name, callback);
