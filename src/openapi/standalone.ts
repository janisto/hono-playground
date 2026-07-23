const JSON_SCHEMA_DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const COMPONENT_SCHEMA_REFERENCE_PREFIX = "#/components/schemas/";

const standaloneSchemaNames = [
  "HealthResponse",
  "GreetingRequest",
  "Greeting",
  "Item",
  "ItemList",
  "ProfileCreate",
  "ProfileUpdate",
  "Profile",
  "ProblemResponse",
  "ValidationErrorDetail",
  "ValidationProblemResponse",
] as const;

export const STANDALONE_SCHEMA_NAMES = Object.freeze(standaloneSchemaNames);

export type StandaloneSchemaName = (typeof STANDALONE_SCHEMA_NAMES)[number];
export type StandaloneSchema = Readonly<Record<string, unknown>>;

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = {
  [key: string]: JsonValue;
  $defs?: JsonValue;
  $schema?: JsonValue;
};
type UnknownObject = Record<string, unknown> & {
  $defs?: unknown;
  $ref?: unknown;
  $schema?: unknown;
  components?: unknown;
  openapi?: unknown;
  schemas?: unknown;
};

const registryCache = new WeakMap<object, ReadonlyMap<StandaloneSchemaName, StandaloneSchema>>();

const isObject = (value: unknown): value is UnknownObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireObject = (value: unknown, label: string): UnknownObject => {
  if (!isObject(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
};

const decodeJsonPointerSegment = (segment: string): string => {
  if (/~(?:[^01]|$)/.test(segment)) {
    throw new Error(`Malformed JSON Pointer segment in schema reference: ${segment}`);
  }
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
};

const encodeJsonPointerSegment = (segment: string): string =>
  segment.replaceAll("~", "~0").replaceAll("/", "~1");

const referencedComponentName = (reference: unknown): string => {
  if (typeof reference !== "string") {
    throw new TypeError("Every $ref must be a string");
  }
  if (!reference.startsWith(COMPONENT_SCHEMA_REFERENCE_PREFIX)) {
    const kind = reference.startsWith("#") ? "Unsupported local" : "External";
    throw new Error(`${kind} schema reference: ${reference}`);
  }

  const pointerSegment = reference.slice(COMPONENT_SCHEMA_REFERENCE_PREFIX.length);
  if (pointerSegment.length === 0 || pointerSegment.includes("/")) {
    throw new Error(`Malformed component schema reference: ${reference}`);
  }
  return decodeJsonPointerSegment(pointerSegment);
};

const schemasFrom = (source: unknown): UnknownObject => {
  const sourceObject = requireObject(source, "OpenAPI document or components");
  let components: UnknownObject;

  if (Object.hasOwn(sourceObject, "openapi")) {
    if (sourceObject.openapi !== "3.1.0") {
      throw new Error("Standalone schemas require an OpenAPI 3.1.0 document");
    }
    components = requireObject(sourceObject.components, "OpenAPI components");
  } else {
    components = sourceObject;
  }

  return requireObject(components.schemas, "OpenAPI components.schemas");
};

const schemaComponent = (schemas: UnknownObject, name: string): UnknownObject => {
  if (!Object.hasOwn(schemas, name)) {
    throw new Error(`Missing OpenAPI component schema: ${name}`);
  }
  return requireObject(schemas[name], `OpenAPI component schema ${name}`);
};

const collectReferencedComponents = (
  rootName: string,
  schemas: UnknownObject,
): ReadonlySet<string> => {
  const referenced = new Set<string>();
  const scannedComponents = new Set<string>([rootName]);

  const scanValue = (value: unknown, ancestors: Set<object>): void => {
    if (Array.isArray(value)) {
      if (ancestors.has(value)) {
        throw new Error("OpenAPI schemas must not contain JavaScript object cycles");
      }
      ancestors.add(value);
      for (const item of value) {
        scanValue(item, ancestors);
      }
      ancestors.delete(value);
      return;
    }
    if (!isObject(value)) {
      return;
    }
    if (ancestors.has(value)) {
      throw new Error("OpenAPI schemas must not contain JavaScript object cycles");
    }

    ancestors.add(value);
    if (Object.hasOwn(value, "$ref")) {
      const name = referencedComponentName(value.$ref);
      schemaComponent(schemas, name);
      referenced.add(name);
      if (!scannedComponents.has(name)) {
        scannedComponents.add(name);
        scanValue(schemaComponent(schemas, name), ancestors);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "$ref") {
        scanValue(child, ancestors);
      }
    }
    ancestors.delete(value);
  };

  scanValue(schemaComponent(schemas, rootName), new Set());
  return referenced;
};

const cloneAndRewriteReferences = (value: unknown, ancestors = new Set<object>()): JsonValue => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("OpenAPI schemas must contain only finite JSON numbers");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new Error("OpenAPI schemas must not contain JavaScript object cycles");
    }
    ancestors.add(value);
    const clone = value.map((item) => cloneAndRewriteReferences(item, ancestors));
    ancestors.delete(value);
    return clone;
  }
  if (!isObject(value)) {
    throw new TypeError("OpenAPI schemas must contain only JSON values");
  }
  if (ancestors.has(value)) {
    throw new Error("OpenAPI schemas must not contain JavaScript object cycles");
  }

  ancestors.add(value);
  const entries = Object.entries(value).map(([key, child]): [string, JsonValue] => {
    if (key === "$ref") {
      const name = referencedComponentName(child);
      return [key, `#/$defs/${encodeJsonPointerSegment(name)}`];
    }
    return [key, cloneAndRewriteReferences(child, ancestors)];
  });
  ancestors.delete(value);
  return Object.fromEntries(entries);
};

const deepFreeze = <T extends JsonValue>(value: T): T => {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
  } else if (isObject(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child as JsonValue);
    }
  }
  Object.freeze(value);
  return value;
};

const buildStandaloneSchema = (
  name: StandaloneSchemaName,
  schemas: UnknownObject,
): StandaloneSchema => {
  const sourceSchema = schemaComponent(schemas, name);
  if (
    Object.hasOwn(sourceSchema, "$schema") &&
    sourceSchema.$schema !== JSON_SCHEMA_DRAFT_2020_12
  ) {
    throw new Error(`${name} contains a conflicting $schema declaration`);
  }

  const referenced = [...collectReferencedComponents(name, schemas)].sort();
  const rewrittenRoot = requireObject(
    cloneAndRewriteReferences(sourceSchema),
    `Cloned OpenAPI component schema ${name}`,
  ) as JsonObject;
  const existingDefinitions = Object.hasOwn(rewrittenRoot, "$defs")
    ? requireObject(rewrittenRoot.$defs, `${name}.$defs`)
    : {};

  for (const referencedName of referenced) {
    if (Object.hasOwn(existingDefinitions, referencedName)) {
      throw new Error(`${name}.$defs collides with referenced component schema ${referencedName}`);
    }
  }

  const generatedDefinitions = referenced.map((referencedName): [string, JsonValue] => [
    referencedName,
    cloneAndRewriteReferences(schemaComponent(schemas, referencedName)),
  ]);
  const mergedDefinitions = Object.fromEntries([
    ...Object.entries(existingDefinitions).map(
      ([definitionName, definition]): [string, JsonValue] => [
        definitionName,
        definition as JsonValue,
      ],
    ),
    ...generatedDefinitions,
  ]);

  const document: JsonObject = {
    ...rewrittenRoot,
    $schema: JSON_SCHEMA_DRAFT_2020_12,
  };
  if (Object.keys(mergedDefinitions).length > 0) {
    document.$defs = mergedDefinitions;
  } else {
    delete document.$defs;
  }

  return deepFreeze(document);
};

const immutableMap = <K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> => {
  const target = new Map(entries);
  const rejectMutation = (): never => {
    throw new TypeError("Standalone schema registry is immutable");
  };
  let proxy: ReadonlyMap<K, V>;

  proxy = new Proxy(target, {
    defineProperty: rejectMutation,
    deleteProperty: rejectMutation,
    get(inner, property) {
      if (property === "set" || property === "delete" || property === "clear") {
        return rejectMutation;
      }
      if (property === "forEach") {
        return (callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) =>
          inner.forEach((entryValue, key) => {
            callback.call(thisArg, entryValue, key, proxy);
          });
      }
      const value = Reflect.get(inner, property, inner);
      return typeof value === "function" ? value.bind(inner) : value;
    },
    set: rejectMutation,
  });
  Object.freeze(proxy);
  return proxy;
};

/**
 * Builds and caches the exact public standalone-schema registry for an OpenAPI 3.1 document or its
 * `components` object. Returned schema documents and the Map facade are immutable.
 */
export const getStandaloneSchemaRegistry = (
  source: unknown,
): ReadonlyMap<StandaloneSchemaName, StandaloneSchema> => {
  const cacheKey = requireObject(source, "OpenAPI document or components");
  const cached = registryCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const schemas = schemasFrom(cacheKey);
  const registry = immutableMap(
    STANDALONE_SCHEMA_NAMES.map((name): readonly [StandaloneSchemaName, StandaloneSchema] => [
      name,
      buildStandaloneSchema(name, schemas),
    ]),
  );
  registryCache.set(cacheKey, registry);
  return registry;
};
