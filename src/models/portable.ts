import { z } from "@hono/zod-openapi";

export const SAFE_INTEGER_MAXIMUM = 9_007_199_254_740_991;

const TIMESTAMP_PATTERN =
  "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z$";

const BOUNDED_NAME_PATTERN =
  "^[^\\u0000-\\u001f\\u007f-\\u009f\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a" +
  "\\u2028\\u2029\\u202f\\u205f\\u3000]" +
  "(?:[^\\u0000-\\u001f\\u007f-\\u009f]{0,98}" +
  "[^\\u0000-\\u001f\\u007f-\\u009f\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a" +
  "\\u2028\\u2029\\u202f\\u205f\\u3000])?$";

const isPortableWhitespace = (value: string): boolean => {
  const code = value.codePointAt(0);
  return (
    code !== undefined &&
    ((code >= 0x09 && code <= 0x0d) ||
      code === 0x20 ||
      code === 0x85 ||
      code === 0xa0 ||
      code === 0x1680 ||
      (code >= 0x2000 && code <= 0x200a) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x202f ||
      code === 0x205f ||
      code === 0x3000)
  );
};

const hasPortableControl = (value: string): boolean => {
  for (const scalar of value) {
    const code = scalar.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f))) return true;
  }
  return false;
};

export const scalarLength = (value: string): number => Array.from(value).length;

export const isWellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (trailing < 0xdc00 || trailing > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
};

export const BoundedNameSchema = z
  .string()
  .refine(isWellFormedUnicode, { error: "Name must contain valid Unicode scalar values" })
  .refine(
    (value) => {
      const scalars = Array.from(value);
      const first = scalars[0];
      const last = scalars.at(-1);
      return first !== undefined && last !== undefined && !isPortableWhitespace(first) && !isPortableWhitespace(last);
    },
    { error: "Name must not have surrounding whitespace" },
  )
  .refine((value) => !hasPortableControl(value), { error: "Name must not contain control characters" })
  .refine((value) => scalarLength(value) >= 1, { error: "Name must contain at least 1 character" })
  .refine((value) => scalarLength(value) <= 100, { error: "Name must contain at most 100 characters" })
  .openapi({ minLength: 1, maxLength: 100, pattern: BOUNDED_NAME_PATTERN });

export const OpaqueIdSchema = z
  .string()
  .refine(isWellFormedUnicode, { error: "Identifier must contain valid Unicode scalar values" })
  .refine((value) => scalarLength(value) >= 1, { error: "Identifier must not be empty" })
  .refine((value) => scalarLength(value) <= 128, { error: "Identifier is too long" })
  .openapi({ minLength: 1, maxLength: 128 });

export const TimestampSchema = z
  .string()
  .regex(new RegExp(TIMESTAMP_PATTERN, "u"), { error: "Timestamp must use canonical UTC milliseconds" })
  .refine(
    (value) => {
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
    },
    { error: "Timestamp is invalid" },
  )
  .openapi({ format: "date-time", pattern: TIMESTAMP_PATTERN });

export const SafeIntegerSchema = z.int().min(0).max(SAFE_INTEGER_MAXIMUM);

export const PhoneNumberSchema = z
  .string()
  .regex(/^\+[1-9][0-9]{6,14}$/u, { error: "Invalid E.164 phone number" })
  .openapi({ pattern: "^\\+[1-9][0-9]{6,14}$", minLength: 8, maxLength: 16 });

export const stripAsciiWhitespace = (value: string): string => {
  let start = 0;
  let end = value.length;
  const whitespace = (code: number): boolean => code === 0x20 || (code >= 0x09 && code <= 0x0d);
  while (start < end && whitespace(value.charCodeAt(start))) start += 1;
  while (end > start && whitespace(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
};
