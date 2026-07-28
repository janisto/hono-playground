const ABSOLUTE_URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const URI_REFERENCE_CHARACTERS = /^[A-Za-z0-9:/?#[\]@!$&'()*+,;=._~%+-]*$/u;
const INVALID_PERCENT_ESCAPE = /%(?![0-9A-Fa-f]{2})/u;
const URI_REFERENCE_BASE = "https://uri-reference.invalid/";

export const isUriReference = (value: string): boolean =>
  URI_REFERENCE_CHARACTERS.test(value) &&
  !INVALID_PERCENT_ESCAPE.test(value) &&
  URL.canParse(value, URI_REFERENCE_BASE);

export const isAbsoluteUri = (value: string): boolean =>
  ABSOLUTE_URI_SCHEME.test(value) && isUriReference(value) && URL.canParse(value);
