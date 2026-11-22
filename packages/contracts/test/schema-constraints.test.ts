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

interface VisitedSchemas {
  refinement: WeakSet<object>;
  strict: WeakSet<object>;
}

function findUnconstrainedObjects(
  schema: JsonSchema,
  path: string,
  failures: string[],
  visited: VisitedSchemas,
  refinement = false,
): void {
  const seen = refinement ? visited.refinement : visited.strict;
  if (seen.has(schema)) return;
  seen.add(schema);

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const declaresObject = types.includes("object");
  const objectShaped = declaresObject || schema.properties !== undefined;
  const inheritsClosure = refinement && !declaresObject;
  if (
    !inheritsClosure &&
    objectShaped &&
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
      findUnconstrainedObjects(member, `${path}.${keyword}[${index}]`, failures, visited, true),
    );
  }
}

describe("frontend-consumed schemas", async () => {
  const operations = operationsById(await loadContractDocument());

  it("contains no unconstrained object requests or responses", () => {
    const failures: string[] = [];
    const visited: VisitedSchemas = {
      refinement: new WeakSet<object>(),
      strict: new WeakSet<object>(),
    };

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
