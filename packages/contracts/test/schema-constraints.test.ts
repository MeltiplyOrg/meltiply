import { describe, expect, it } from "vite-plus/test";

import { loadContractDocument, operationsById } from "../test-support/validation";

interface JsonSchema {
  additionalProperties?: boolean | JsonSchema;
  allOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  type?: string | string[];
}

function findUnconstrainedObjects(
  schema: JsonSchema,
  path: string,
  failures: string[],
  visited: WeakSet<object>,
): void {
  if (visited.has(schema)) return;
  visited.add(schema);

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (
    types.includes("object") &&
    (schema.additionalProperties === undefined || schema.additionalProperties === true)
  ) {
    failures.push(path);
  }

  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    findUnconstrainedObjects(property, `${path}.properties.${name}`, failures, visited);
  }
  if (schema.items) {
    findUnconstrainedObjects(schema.items, `${path}.items`, failures, visited);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    findUnconstrainedObjects(
      schema.additionalProperties,
      `${path}.additionalProperties`,
      failures,
      visited,
    );
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    schema[keyword]?.forEach((member, index) =>
      findUnconstrainedObjects(member, `${path}.${keyword}[${index}]`, failures, visited),
    );
  }
}

/** Reject unconstrained request/response objects before frontend clients consume them. */
describe("frontend-consumed schemas", async () => {
  const operations = operationsById(await loadContractDocument());

  it("contains no unconstrained object requests or responses", () => {
    const failures: string[] = [];
    const visited = new WeakSet<object>();

    for (const [operationId, operation] of operations) {
      const requestSchema: JsonSchema | undefined =
        operation.requestBody?.content?.["application/json"]?.schema;
      if (requestSchema) {
        findUnconstrainedObjects(requestSchema, `${operationId}.request`, failures, visited);
      }

      for (const [status, response] of Object.entries(operation.responses)) {
        const responseSchema: JsonSchema | undefined =
          response.content?.["application/json"]?.schema;
        if (responseSchema) {
          findUnconstrainedObjects(
            responseSchema,
            `${operationId}.response.${status}`,
            failures,
            visited,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
