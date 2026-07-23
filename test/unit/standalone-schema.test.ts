import { describe, expect, it } from "vitest";

import {
  getStandaloneSchemaRegistry,
  STANDALONE_SCHEMA_NAMES,
  type StandaloneSchema,
  type StandaloneSchemaName,
} from "../../src/openapi/standalone.js";

type TestObject = Record<string, unknown> & {
  $defs?: unknown;
  $schema?: unknown;
  Greeting?: unknown;
  GreetingRequest?: unknown;
  title?: unknown;
};
type ComponentSchemas = {
  [Name in StandaloneSchemaName]?: Record<string, unknown>;
};

const object = (value: unknown): TestObject => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected object");
  }
  return value as TestObject;
};

const componentsFixture = () => {
  const schemas = Object.fromEntries(
    STANDALONE_SCHEMA_NAMES.map((name) => [name, { type: "object", title: name }]),
  ) as unknown as ComponentSchemas;
  schemas.Greeting = {
    type: "object",
    title: "Greeting",
    properties: { request: { $ref: "#/components/schemas/GreetingRequest" } },
  };
  schemas.GreetingRequest = {
    type: "object",
    title: "GreetingRequest",
    properties: { response: { $ref: "#/components/schemas/Greeting" } },
  };
  schemas.ItemList = {
    type: "object",
    title: "ItemList",
    properties: {
      items: { type: "array", items: { $ref: "#/components/schemas/Item" } },
    },
  };
  schemas.ValidationProblemResponse = {
    allOf: [{ $ref: "#/components/schemas/ProblemResponse" }],
    title: "ValidationProblemResponse",
    type: "object",
    properties: {
      errors: {
        type: "array",
        items: { $ref: "#/components/schemas/ValidationErrorDetail" },
      },
    },
  };
  return { schemas };
};

describe("standalone schema registry", () => {
  it("exports exactly the eleven explicit schemas as immutable Draft 2020-12 documents", () => {
    const document = { openapi: "3.1.0", components: componentsFixture() };
    const registry = getStandaloneSchemaRegistry(document);

    expect([...registry.keys()]).toEqual(STANDALONE_SCHEMA_NAMES);
    expect(registry.size).toBe(11);

    const greeting = object(registry.get("Greeting"));
    const definitions = object(greeting.$defs);
    expect(greeting.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(greeting).toMatchObject({
      properties: { request: { $ref: "#/$defs/GreetingRequest" } },
    });
    expect(definitions.GreetingRequest).toMatchObject({
      properties: { response: { $ref: "#/$defs/Greeting" } },
    });
    expect(definitions.Greeting).toMatchObject({
      properties: { request: { $ref: "#/$defs/GreetingRequest" } },
    });

    const validation = object(registry.get("ValidationProblemResponse"));
    expect(Object.keys(object(validation.$defs)).sort()).toEqual([
      "ProblemResponse",
      "ValidationErrorDetail",
    ]);
    expect(JSON.stringify(validation)).not.toContain("#/components/schemas/");

    expect(Object.isFrozen(greeting)).toBe(true);
    expect(Object.isFrozen(definitions)).toBe(true);
    expect(() => {
      greeting.title = "mutated";
    }).toThrow(TypeError);
    expect(() => {
      (registry as Map<StandaloneSchemaName, StandaloneSchema>).set(
        "HealthResponse",
        Object.freeze({}),
      );
    }).toThrow("immutable");
  });

  it("deep-clones once and returns the same cached registry for the same source identity", () => {
    const components = componentsFixture();
    const first = getStandaloneSchemaRegistry(components);
    object(components.schemas.HealthResponse).title = "changed after generation";
    const second = getStandaloneSchemaRegistry(components);

    expect(second).toBe(first);
    expect(object(second.get("HealthResponse")).title).toBe("HealthResponse");
  });

  it("accepts a components object directly and follows transitive local references", () => {
    const registry = getStandaloneSchemaRegistry(componentsFixture());
    const itemList = object(registry.get("ItemList"));

    expect(itemList).toMatchObject({
      properties: { items: { items: { $ref: "#/$defs/Item" } } },
      $defs: { Item: { title: "Item" } },
    });
  });

  it("rejects a missing public component", () => {
    const components = componentsFixture();
    delete components.schemas.HealthResponse;

    expect(() => getStandaloneSchemaRegistry(components)).toThrow(
      "Missing OpenAPI component schema: HealthResponse",
    );
  });

  it("rejects external and missing transitive references", () => {
    const external = componentsFixture();
    external.schemas.HealthResponse = { $ref: "https://schemas.example/health.json" };
    expect(() => getStandaloneSchemaRegistry(external)).toThrow("External schema reference");

    const missing = componentsFixture();
    missing.schemas.HealthResponse = { $ref: "#/components/schemas/NotPresent" };
    expect(() => getStandaloneSchemaRegistry(missing)).toThrow(
      "Missing OpenAPI component schema: NotPresent",
    );
  });

  it("rejects collisions between an existing $defs entry and a collected component", () => {
    const components = componentsFixture();
    components.schemas.HealthResponse = {
      type: "object",
      $defs: { Item: { type: "string" } },
      properties: { item: { $ref: "#/components/schemas/Item" } },
    };

    expect(() => getStandaloneSchemaRegistry(components)).toThrow(
      "HealthResponse.$defs collides with referenced component schema Item",
    );
  });

  it("rejects a non-3.1 OpenAPI document", () => {
    expect(() =>
      getStandaloneSchemaRegistry({ openapi: "3.0.3", components: componentsFixture() }),
    ).toThrow("OpenAPI 3.1.0");
  });
});
