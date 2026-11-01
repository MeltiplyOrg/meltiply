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

/**
 * Tracks which schemas a pass has already inspected. Strict and refinement visits are
 * recorded separately because a dereferenced component can be reachable both as a
 * composite member and as a standalone schema; exempting the first visit must not
 * suppress the stricter later one.
 */
interface VisitedSchemas {
  refinement: WeakSet<object>;
  strict: WeakSet<object>;
}

/**
 * Reports every object-shaped schema that would accept undeclared properties.
 *
 * A schema is object-shaped when it declares `type: "object"` or carries `properties`
 * — `properties` without an explicit type still validates those properties while
 * leaving the object open, so both forms must be closed by `additionalProperties`.
 * Untyped composite members (`allOf`/`anyOf`/`oneOf`) are exempt because they refine a
 * parent that owns the closing `additionalProperties`; a member that declares
 * `type: "object"` stands on its own and must close itself. Children of both forms are
 * still inspected strictly.
 *
 * @param schema - Schema node to inspect.
 * @param path - Human-readable location used in failure messages.
 * @param failures - Accumulator receiving offending paths.
 * @param visited - Per-kind memo of already inspected schema objects.
 * @param refinement - True when the node itself is a composite member, not a root.
 */
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
  // Only an untyped composite member may inherit closure from its parent.
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

/** Reject unconstrained request/response objects before frontend clients consume them. */
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
