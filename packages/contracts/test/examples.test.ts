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

  it("includes one success and at least one error for every non-health operation", () => {
    for (const [operationId, example] of Object.entries(examples.operations)) {
      expect(example.success, `${operationId} success example`).toBeDefined();
      if (operationId !== "getHealth") {
        expect(example.errors.length, `${operationId} error examples`).toBeGreaterThan(0);
      }
    }
  });

  it("validates request and response bodies against the dereferenced OpenAPI schemas", () => {
    for (const [operationId, example] of Object.entries(examples.operations)) {
      const operation = operations.get(operationId);
      expect(operation, operationId).toBeDefined();
      if (!operation) continue;

      if (operation.requestBody?.content?.["application/json"]?.schema) {
        expect(example.request, `${operationId} request example`).toBeDefined();
        expect(
          validator.validateRequest(operationId, example.request),
          `${operationId} request`,
        ).toBeUndefined();
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
