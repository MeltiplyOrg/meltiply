import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

export interface ContractExampleResponse {
  body?: unknown;
  headers?: Record<string, string>;
  status: number;
}

export interface ContractOperationExample {
  errors: ContractExampleResponse[];
  request?: unknown;
  success: ContractExampleResponse;
}

interface ContractExampleCatalog {
  operations: Record<string, ContractOperationExample>;
}

const catalogPath = resolve(process.cwd(), "../../packages/contracts/examples/operations.yaml");
const catalog = YAML.parse(readFileSync(catalogPath, "utf8"), {
  merge: true,
}) as ContractExampleCatalog;

export function contractOperation(operationId: string): ContractOperationExample {
  const operation = catalog.operations[operationId];
  if (!operation) {
    throw new Error(`Unknown contract fixture: ${operationId}`);
  }
  return structuredClone(operation);
}

export function contractSuccessBody<T>(operationId: string): T {
  return contractOperation(operationId).success.body as T;
}
