import { AppError } from "./errors.js";

type MediaRange = {
  type: string;
  subtype: string;
  quality: number;
  hasRepresentationParameters: boolean;
};

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const Q_VALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

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
  return quoted ? [] : parts;
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
  let hasRepresentationParameters = false;
  let sawQuality = false;
  for (const segment of segments) {
    const equals = segment.indexOf("=");
    if (equals <= 0) return null;
    const name = segment.slice(0, equals).trim().toLowerCase();
    const value = segment.slice(equals + 1).trim();
    if (!TOKEN.test(name) || value.length === 0) return null;
    if (name === "q") {
      if (sawQuality || !Q_VALUE.test(value)) return null;
      quality = Number(value);
      sawQuality = true;
    } else if (!sawQuality) {
      hasRepresentationParameters = true;
    }
  }

  return { type, subtype, quality, hasRepresentationParameters };
};

export const accepts = (headerValue: string | null, representation: string): boolean => {
  if (headerValue === null || headerValue.trim() === "") return true;
  const [candidateType, candidateSubtype] = representation.toLowerCase().split("/");
  if (candidateType === undefined || candidateSubtype === undefined) return false;

  const ranges = splitQuoted(headerValue, ",")
    .map((part) => parseMediaRange(part.trim()))
    .filter((range): range is MediaRange => range !== null)
    .filter((range) => !range.hasRepresentationParameters)
    .filter(
      (range) =>
        (range.type === "*" || range.type === candidateType) &&
        (range.subtype === "*" || range.subtype === candidateSubtype),
    );

  if (ranges.length === 0) return false;
  const specificity = (range: MediaRange): number =>
    range.type === "*" ? 0 : range.subtype === "*" ? 1 : 2;
  const mostSpecific = Math.max(...ranges.map(specificity));
  return ranges
    .filter((range) => specificity(range) === mostSpecific)
    .some((range) => range.quality > 0);
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
      detail: `Supported response formats: ${advertised}`,
    });
  }
};
