import type { TraceMetadata } from "./types.js";

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TRACE_PARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

export const requestId = (candidate: string | null): string =>
  candidate !== null && REQUEST_ID.test(candidate)
    ? candidate
    : crypto.randomUUID().replaceAll("-", "").toLowerCase();

export const parseTraceParent = (candidate: string | null): TraceMetadata | undefined => {
  if (candidate === null) return undefined;
  const match = TRACE_PARENT.exec(candidate.trim());
  if (match === null) return undefined;
  const [, version, traceId, parentSpanId] = match;
  if (
    version === undefined ||
    traceId === undefined ||
    parentSpanId === undefined ||
    version.toLowerCase() === "ff" ||
    /^0+$/.test(traceId) ||
    /^0+$/.test(parentSpanId)
  ) {
    return undefined;
  }
  return { traceId: traceId.toLowerCase(), parentSpanId: parentSpanId.toLowerCase() };
};
