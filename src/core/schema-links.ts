const splitHeaderValues = (value: string): string[] =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

export const appendHeaderValue = (headers: Headers, name: string, value: string): void => {
  const current = headers.get(name);
  if (current === null) {
    headers.set(name, value);
    return;
  }

  const existing = splitHeaderValues(current);
  if (!existing.some((part) => part.toLowerCase() === value.toLowerCase())) {
    headers.set(name, [...existing, value].join(", "));
  }
};

export const appendVary = (headers: Headers, fieldName: string): void => {
  appendHeaderValue(headers, "Vary", fieldName);
};

export const schemaLink = (schemaName: string): string =>
  `</schemas/${schemaName}.json>; rel="describedBy"`;

export const appendSchemaLink = (headers: Headers, schemaName: string): void => {
  appendHeaderValue(headers, "Link", schemaLink(schemaName));
};
