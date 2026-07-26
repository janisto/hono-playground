import { JSON_API_MEDIA_TYPE } from "../models/json-api.js";
import { AppError } from "./errors.js";

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
const ABSOLUTE_URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const URI_CHARACTERS = /^[A-Za-z0-9:/?#[\]@!$&'()*+,;=._~%+-]+$/u;
const INVALID_PERCENT_ESCAPE = /%(?![0-9A-Fa-f]{2})/u;

const splitQuoted = (value: string, separator: string): string[] => {
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
  return quoted || escaped ? [] : parts;
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
  return uris.every((uri) => {
    if (
      uri.length === 0 ||
      !URI_CHARACTERS.test(uri) ||
      INVALID_PERCENT_ESCAPE.test(uri) ||
      !ABSOLUTE_URI_SCHEME.test(uri)
    ) {
      return false;
    }
    return URL.canParse(uri);
  });
};

const parseMediaRange = (raw: string): MediaRange | null => {
  const segments = splitQuoted(raw, ";").map((part) => part.trim());
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
    if (equals <= 0) return null;
    const name = segment.slice(0, equals).trim().toLowerCase();
    const value = parameterValue(segment.slice(equals + 1).trim());
    if (!TOKEN.test(name) || value === null) return null;
    if (name === "q") {
      if (sawQuality || value.quoted || !Q_VALUE.test(value.value)) return null;
      quality = Number(value.value);
      sawQuality = true;
    } else {
      if (representationParameters.has(name)) return null;
      representationParameters.set(name, value);
    }
  }

  return { type, subtype, quality, representationParameters };
};

const matchingRanges = (headerValue: string, representation: string): MediaRange[] => {
  const [candidateType, candidateSubtype] = representation.toLowerCase().split("/");
  if (candidateType === undefined || candidateSubtype === undefined) return [];

  return splitQuoted(headerValue, ",")
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
  const specificity = (range: MediaRange): number =>
    range.type === "*" ? 0 : range.subtype === "*" ? 1 : 2;
  const mostSpecific = Math.max(...ranges.map(specificity));
  return ranges
    .filter((range) => specificity(range) === mostSpecific)
    .some((range) => range.quality > 0);
};

export const accepts = (headerValue: string | null, representation: string): boolean => {
  if (headerValue === null || headerValue.trim() === "") return true;
  return acceptsBySpecificity(
    matchingRanges(headerValue, representation).filter(
      (range) => range.representationParameters.size === 0,
    ),
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
  if (headerValue === null || headerValue.trim() === "") return true;
  return acceptsBySpecificity(
    matchingRanges(headerValue, JSON_API_MEDIA_TYPE).filter(supportedJsonApiRange),
  );
};

export const isSupportedJsonApiContentType = (headerValue: string | null): boolean => {
  if (headerValue === null) return false;
  const segments = splitQuoted(headerValue, ";").map((part) => part.trim());
  if (segments.shift()?.toLowerCase() !== JSON_API_MEDIA_TYPE) return false;

  const parameters = new Map<string, ParameterValue>();
  for (const segment of segments) {
    const equals = segment.indexOf("=");
    if (equals <= 0) return false;
    const name = segment.slice(0, equals).trim().toLowerCase();
    const value = parameterValue(segment.slice(equals + 1).trim());
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
  advertised = representation,
): void => {
  if (!accepts(headerValue, representation)) {
    throw new AppError({
      status: 406,
      code: "not_acceptable",
      detail: `Supported response format: ${advertised}`,
      source: { header: "Accept" },
    });
  }
};

export const requireJsonApiAccept = (headerValue: string | null): void => {
  if (!acceptsJsonApi(headerValue)) {
    throw new AppError({
      status: 406,
      code: "not_acceptable",
      detail: `Supported response format: ${JSON_API_MEDIA_TYPE}`,
      source: { header: "Accept" },
    });
  }
};
