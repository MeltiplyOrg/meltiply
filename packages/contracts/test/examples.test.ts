import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import YAML from "yaml";

import {
  ContractValidator,
  loadContractDocument,
  operationsById,
} from "../test-support/validation";

interface ExampleResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface OperationExample {
  request?: unknown;
  success: ExampleResponse;
  errors: ExampleResponse[];
}

interface ExampleCatalog {
  operations: Record<string, OperationExample>;
}

const packageRoot = resolve(import.meta.dirname, "..");

async function loadDocuments() {
  const [openApi, examplesSource] = await Promise.all([
    loadContractDocument(),
    readFile(resolve(packageRoot, "examples/operations.yaml"), "utf8"),
  ]);
  const examples = YAML.parse(examplesSource, {
    merge: true,
  }) as ExampleCatalog;
  return { examples, openApi };
}

describe("operation examples", async () => {
  const { examples, openApi } = await loadDocuments();
  const operations = operationsById(openApi);
  const validator = await ContractValidator.create();

  it("has exactly one catalog entry for every OpenAPI operation", () => {
    expect(Object.keys(examples.operations).sort()).toEqual([...operations.keys()].sort());
  });

  it("includes one success and at least one error for every operation that documents an error", () => {
    for (const [operationId, example] of Object.entries(examples.operations)) {
      const operation = operations.get(operationId);
      expect(operation, operationId).toBeDefined();
      expect(example.success, `${operationId} success example`).toBeDefined();
      // Derived from the contract instead of naming an operation, so adding or
      // removing an error-less operation cannot silently change what is required.
      if (Object.keys(operation!.responses).some((status) => Number(status) >= 400)) {
        expect(example.errors.length, `${operationId} error examples`).toBeGreaterThan(0);
      }
      // Documented schemas exist for error statuses too, so a 4xx/5xx entry filed
      // under `success` would pass every schema check while contradicting the
      // catalog's own shape. Assert the classes the entry names are really used.
      expect(
        Number(example.success.status),
        `${operationId} success status ${example.success.status}`,
      ).toBeLessThan(400);
      for (const error of example.errors) {
        expect(
          Number(error.status),
          `${operationId} error status ${error.status}`,
        ).toBeGreaterThanOrEqual(400);
      }
    }
  });

  it("validates request and response bodies against the dereferenced OpenAPI schemas", () => {
    for (const [operationId, example] of Object.entries(examples.operations)) {
      const operation = operations.get(operationId);
      expect(operation, operationId).toBeDefined();
      if (!operation) continue;

      const jsonRequestSchema = operation.requestBody?.content?.["application/json"]?.schema;
      if (jsonRequestSchema) {
        expect(example.request, `${operationId} request example`).toBeDefined();
        expect(
          validator.validateRequest(operationId, example.request),
          `${operationId} request`,
        ).toBeUndefined();
      } else if (!operation.requestBody) {
        // Without this branch a request example could be added for an operation
        // that documents no request body at all and never be validated.
        expect(example.request, `${operationId} has no documented request body`).toBeUndefined();
      }

      for (const response of [example.success, ...example.errors]) {
        expect(
          operation.responses[String(response.status)],
          `${operationId} status ${response.status}`,
        ).toBeDefined();
        expect(
          validator.validateResponse(operationId, response.status, response.body),
          `${operationId} ${response.status}`,
        ).toBeUndefined();
      }
    }
  });
});
