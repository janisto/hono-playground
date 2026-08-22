import { JSON_API_MEDIA_TYPE } from "../models/json-api.ts";
import { AppError } from "./errors.ts";
import { isAbsoluteUri } from "./uri.ts";

type MediaRange = {
  type: string;
  subtype: string;
  quality: number;
  representationParameters: ReadonlyMap<string, ParameterValue>;
};

type ParameterValue = {
  value: string;
  quoted: boolean;
};

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const Q_VALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u;
const splitQuoted = (value: string, separator: string): { parts: string[]; complete: boolean } => {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;

  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quoted) {
      current += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      current += character;
      continue;
    }
    if (character === separator && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return { parts, complete: !quoted && !escaped };
};

const parameterValue = (raw: string): ParameterValue | null => {
  if (TOKEN.test(raw)) return { value: raw, quoted: false };
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return null;
  const value = raw.slice(1, -1);
  if (/[\r\n]/u.test(value)) return null;
  return { value: value.replaceAll(/\\(.)/gu, "$1"), quoted: true };
};

const isJsonApiUriList = (parameter: ParameterValue): boolean => {
  if (!parameter.quoted || parameter.value.length === 0) return false;
  const uris = parameter.value.split(" ");
  return uris.every((uri) => uri.length > 0 && isAbsoluteUri(uri));
};

const parseMediaRange = (raw: string): MediaRange | null => {
  const split = splitQuoted(raw, ";");
  if (!split.complete) return null;
  const segments = split.parts.map((part) => part.trim());
  const mediaType = segments.shift();
  if (mediaType === undefined || mediaType.length === 0) return null;

  const slash = mediaType.indexOf("/");
  if (slash <= 0 || slash !== mediaType.lastIndexOf("/")) return null;
  const type = mediaType.slice(0, slash).toLowerCase();
  const subtype = mediaType.slice(slash + 1).toLowerCase();
  if ((type !== "*" && !TOKEN.test(type)) || (subtype !== "*" && !TOKEN.test(subtype))) {
    return null;
  }
  if (type === "*" && subtype !== "*") return null;

  let quality = 1;
  let sawQuality = false;
  const representationParameters = new Map<string, ParameterValue>();
  for (const segment of segments) {
    const equals = segment.indexOf("=");
    const rawName = equals < 0 ? segment : segment.slice(0, equals);
    const rawValue = equals < 0 ? "" : segment.slice(equals + 1);
    if (rawName !== rawName.trim() || rawValue !== rawValue.trim()) return null;
    const name = rawName.toLowerCase();
    if (!TOKEN.test(name)) return null;
    if (name === "q") {
      if (equals <= 0) return null;
      const value = parameterValue(rawValue);
      if (sawQuality || value === null || value.quoted || !Q_VALUE.test(value.value)) return null;
      quality = Number(value.value);
      sawQuality = true;
      continue;
    }
    if (equals <= 0) return null;
    const value = parameterValue(rawValue);
    if (value === null || representationParameters.has(name)) return null;
    representationParameters.set(name, value);
  }

  return { type, subtype, quality, representationParameters };
};

const matchingRanges = (headerValue: string, representation: string): MediaRange[] => {
  const [candidateType, candidateSubtype] = representation.toLowerCase().split("/");
  if (candidateType === undefined || candidateSubtype === undefined) return [];
  const split = splitQuoted(headerValue, ",");
  // An unterminated quote makes the current member and its remaining commas ambiguous.
  const parts = split.complete ? split.parts : split.parts.slice(0, -1);

  return parts
    .map((part) => parseMediaRange(part.trim()))
    .filter((range): range is MediaRange => range !== null)
    .filter(
      (range) =>
        (range.type === "*" || range.type === candidateType) &&
        (range.subtype === "*" || range.subtype === candidateSubtype),
    );
};

const acceptsBySpecificity = (ranges: readonly MediaRange[]): boolean => {
  if (ranges.length === 0) return false;
  const specificity = (range: MediaRange): number => (range.type === "*" ? 0 : range.subtype === "*" ? 1 : 2);
  const mostSpecific = Math.max(...ranges.map(specificity));
  const typeMatches = ranges.filter((range) => specificity(range) === mostSpecific);
  const parameterCount = Math.max(...typeMatches.map((range) => range.representationParameters.size));
  return typeMatches
    .filter((range) => range.representationParameters.size === parameterCount)
    .some((range) => range.quality > 0);
};

const jsonCandidateQuality = (headerValue: string, representation: string, withCharset: boolean): number | null => {
  const ranges = matchingRanges(headerValue, representation).filter((range) => {
    if (range.representationParameters.size === 0) return true;
    if (!withCharset || range.representationParameters.size !== 1) return false;
    return range.representationParameters.get("charset")?.value.toLowerCase() === "utf-8";
  });
  if (ranges.length === 0) return null;
  const specificity = (range: MediaRange): number => (range.type === "*" ? 0 : range.subtype === "*" ? 1 : 2);
  const mostSpecific = Math.max(...ranges.map(specificity));
  const typeMatches = ranges.filter((range) => specificity(range) === mostSpecific);
  const parameterCount = Math.max(...typeMatches.map((range) => range.representationParameters.size));
  return Math.max(
    ...typeMatches
      .filter((range) => range.representationParameters.size === parameterCount)
      .map((range) => range.quality),
  );
};

export const selectJsonContentType = (
  headerValue: string | null,
  representation = "application/json",
): string | null => {
  if (headerValue === null) return representation;
  const baseQuality = jsonCandidateQuality(headerValue, representation, false);
  const charsetQuality = jsonCandidateQuality(headerValue, representation, true);
  const baseAccepted = baseQuality !== null && baseQuality > 0;
  const charsetAccepted = charsetQuality !== null && charsetQuality > 0;
  if (!baseAccepted && !charsetAccepted) return null;
  return charsetAccepted && (baseQuality === null || charsetQuality > baseQuality)
    ? `${representation}; charset=utf-8`
    : representation;
};

export const selectProblemContentType = (headerValue: string | null): string =>
  selectJsonContentType(headerValue, "application/problem+json") ?? "application/problem+json";

export const accepts = (headerValue: string | null, representation: string): boolean => {
  const plainJson = representation === "application/json" || representation === "application/problem+json";
  if (plainJson) return selectJsonContentType(headerValue, representation) !== null;
  if (headerValue === null) return true;
  return acceptsBySpecificity(
    matchingRanges(headerValue, representation).filter((range) => range.representationParameters.size === 0),
  );
};

const supportedJsonApiRange = (range: MediaRange): boolean => {
  if (range.type === "*" || range.subtype === "*") {
    return range.representationParameters.size === 0;
  }

  for (const [name, value] of range.representationParameters) {
    if (name === "ext") return false;
    if (name !== "profile" || !isJsonApiUriList(value)) return false;
  }
  return true;
};

export const acceptsJsonApi = (headerValue: string | null): boolean => {
  if (headerValue === null) return true;
  const ranges = matchingRanges(headerValue, JSON_API_MEDIA_TYPE);
  return acceptsBySpecificity(ranges.filter(supportedJsonApiRange));
};

export const isSupportedJsonApiContentType = (headerValue: string | null): boolean => {
  if (headerValue === null) return false;
  const split = splitQuoted(headerValue, ";");
  if (!split.complete) return false;
  const segments = split.parts.map((part) => part.trim());
  if (segments.shift()?.toLowerCase() !== JSON_API_MEDIA_TYPE) return false;

  const parameters = new Map<string, ParameterValue>();
  for (const segment of segments) {
    const equals = segment.indexOf("=");
    if (equals <= 0) return false;
    const rawName = segment.slice(0, equals);
    const rawValue = segment.slice(equals + 1);
    if (rawName !== rawName.trim() || rawValue !== rawValue.trim()) return false;
    const name = rawName.toLowerCase();
    const value = parameterValue(rawValue);
    if (!TOKEN.test(name) || value === null || parameters.has(name)) return false;
    parameters.set(name, value);
  }

  for (const [name, value] of parameters) {
    if (name === "ext") return false;
    if (name !== "profile" || !isJsonApiUriList(value)) return false;
  }
  return true;
};

export const requireAccept = (
  headerValue: string | null,
  representation: string,
  _advertised = representation,
): string => {
  const selected =
    representation === "application/json" || representation === "application/problem+json"
      ? selectJsonContentType(headerValue, representation)
      : accepts(headerValue, representation)
        ? representation
        : null;
  if (selected === null) {
    throw new AppError({
      status: 406,
      code: "not_acceptable",
      source: { header: "Accept" },
    });
  }
  return selected;
};

export const requireJsonApiAccept = (headerValue: string | null): string => {
  if (!acceptsJsonApi(headerValue)) {
    throw new AppError({
      status: 406,
      code: "not_acceptable",
      source: { header: "Accept" },
    });
  }
  return JSON_API_MEDIA_TYPE;
};
