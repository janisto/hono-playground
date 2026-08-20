import { AppError } from "./errors.ts";

export type ParsedQuery = ReadonlyMap<string, string>;

const decodeComponent = (value: string): string => {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    throw new AppError({ code: "invalid_request" });
  }
};

export const parseClosedQuery = (requestUrl: string, allowed: ReadonlySet<string>): ParsedQuery => {
  const question = requestUrl.indexOf("?");
  if (question < 0 || question === requestUrl.length - 1) return new Map();
  const result = new Map<string, string>();
  for (const rawMember of requestUrl.slice(question + 1).split("&")) {
    if (rawMember.length === 0) continue;
    const equals = rawMember.indexOf("=");
    const name = decodeComponent(equals < 0 ? rawMember : rawMember.slice(0, equals));
    const value = decodeComponent(equals < 0 ? "" : rawMember.slice(equals + 1));
    if (!allowed.has(name)) throw new AppError({ code: "invalid_request" });
    if (result.has(name)) throw new AppError({ code: "invalid_request", source: { parameter: name } });
    result.set(name, value);
  }
  return result;
};

export const validateCursorInput = (value: string, parameter = "cursor"): void => {
  if (value.length === 0 || value.length > 2_048 || !/^[!-~]+$/u.test(value)) {
    throw new AppError({ code: "invalid_request", source: { parameter } });
  }
};
