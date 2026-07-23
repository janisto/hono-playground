import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import { CANONICAL_OPENAPI_DOCUMENT } from "../../src/openapi/canonical.js";
import {
  getStandaloneSchemaRegistry,
  STANDALONE_SCHEMA_NAMES,
  type StandaloneSchemaName,
} from "../../src/openapi/standalone.js";

const ITEM = {
  id: "item-001",
  name: "Alpha Widget",
  category: "electronics",
  price: 29.99,
  in_stock: true,
  created_at: "2024-01-15T10:30:00.000Z",
  description: "A versatile electronic widget for everyday use",
};

const PROFILE_CREATE = {
  first_name: "Ada",
  last_name: "Lovelace",
  email: "ada@example.com",
  phone_number: "+358401234567",
  marketing: false,
  terms: true,
};

const PROFILE = {
  id: "subject-1",
  ...PROFILE_CREATE,
  created_at: "2026-07-22T10:00:00.000Z",
  updated_at: "2026-07-22T10:00:00.000Z",
};

const PROBLEM = {
  title: "Not Found",
  status: 404,
  detail: "Profile not found",
};

const VALIDATION_ERROR = {
  location: "body.name",
  message: "String should have at least 1 character",
};

const representativePayloads = {
  HealthResponse: { status: "healthy" },
  GreetingRequest: { name: "Ada", language: "en" },
  Greeting: { message: "Hello, Ada!" },
  Item: ITEM,
  ItemList: { items: [ITEM], total: 1 },
  ProfileCreate: PROFILE_CREATE,
  ProfileUpdate: { marketing: true },
  Profile: PROFILE,
  ProblemResponse: PROBLEM,
  ValidationErrorDetail: VALIDATION_ERROR,
  ValidationProblemResponse: {
    title: "Unprocessable Entity",
    status: 422,
    detail: "validation failed",
    errors: [VALIDATION_ERROR],
  },
} satisfies Record<StandaloneSchemaName, unknown>;

const collectReferences = (value: unknown, references: string[] = []): string[] => {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, references);
    return references;
  }
  if (typeof value !== "object" || value === null) return references;

  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref") {
      if (typeof child !== "string") throw new Error("Schema reference must be a string");
      references.push(child);
    } else {
      collectReferences(child, references);
    }
  }
  return references;
};

const compileSchemas = (): ReadonlyMap<StandaloneSchemaName, ValidateFunction> => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addKeyword({ keyword: "example" });
  addFormats(ajv);
  const registry = getStandaloneSchemaRegistry(CANONICAL_OPENAPI_DOCUMENT);

  return new Map(
    STANDALONE_SCHEMA_NAMES.map((name) => {
      const schema = registry.get(name);
      if (schema === undefined) throw new Error(`Missing standalone schema ${name}`);
      return [name, ajv.compile(schema)] as const;
    }),
  );
};

describe("standalone JSON Schema contract", () => {
  it("contains exactly 11 Draft 2020-12 schemas with local references", () => {
    const registry = getStandaloneSchemaRegistry(CANONICAL_OPENAPI_DOCUMENT);

    expect([...registry.keys()]).toEqual(STANDALONE_SCHEMA_NAMES);
    expect(registry.size).toBe(11);
    for (const [name, schema] of registry) {
      expect(Reflect.get(schema, "$schema"), name).toBe(
        "https://json-schema.org/draft/2020-12/schema",
      );
      for (const reference of collectReferences(schema)) {
        expect(reference, `${name} contains a non-local reference`).toMatch(/^#\/(?:\$defs\/)/);
      }
    }
  });

  it("compiles every schema with Ajv 2020 and validates representative payloads", () => {
    const validators = compileSchemas();

    expect(validators.size).toBe(11);
    for (const name of STANDALONE_SCHEMA_NAMES) {
      const validate = validators.get(name);
      if (validate === undefined) throw new Error(`Missing validator ${name}`);
      expect(validate(representativePayloads[name]), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("rejects invalid success and Problem payloads at the standalone boundary", () => {
    const validators = compileSchemas();
    const validate = (name: StandaloneSchemaName, payload: unknown): boolean => {
      const validator = validators.get(name);
      if (validator === undefined) throw new Error(`Missing validator ${name}`);
      return validator(payload);
    };

    expect(validate("HealthResponse", { status: "degraded" })).toBe(false);
    expect(validate("Item", { ...ITEM, price: -1 })).toBe(false);
    expect(validate("Profile", { ...PROFILE, terms: false })).toBe(false);
    expect(validate("Profile", { ...PROFILE, email: "not-an-email" })).toBe(false);
    expect(validate("ProblemResponse", { ...PROBLEM, status: 200 })).toBe(false);
    expect(
      validate("ValidationProblemResponse", {
        title: "Unprocessable Entity",
        status: 422,
        detail: "validation failed",
        errors: [{ ...VALIDATION_ERROR, private_value: "must not be present" }],
      }),
    ).toBe(false);
  });
});
