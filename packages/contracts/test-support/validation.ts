import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

type HttpMethod = "delete" | "get" | "patch" | "post" | "put";

export interface ContractParameter {
  in: "cookie" | "header" | "path" | "query";
  name: string;
  required?: boolean;
  schema?: object;
}

export interface ContractOperation {
  operationId: string;
  parameters?: ContractParameter[];
  requestBody?: {
    content?: Record<string, { schema?: object }>;
  };
  responses: Record<
    string,
    {
      content?: Record<string, { schema?: object }>;
    }
  >;
}

export type ContractPathItem = Partial<Record<HttpMethod, ContractOperation>> & {
  parameters?: ContractParameter[];
};

export interface ContractDocument {
  components?: {
    schemas?: Record<string, object>;
  };
  paths: Record<string, ContractPathItem>;
}

const openApiPath = fileURLToPath(new URL("../openapi.yaml", import.meta.url));
const methods: HttpMethod[] = ["delete", "get", "patch", "post", "put"];

/**
 * Loads and dereferences the canonical OpenAPI 3.1 specification document from disk.
 * Resolves all $ref pointers using SwaggerParser to produce a self-contained ContractDocument.
 *
 * @returns Promise resolving to the dereferenced ContractDocument.
 */
export async function loadContractDocument(): Promise<ContractDocument> {
  const source = await readFile(openApiPath, "utf8");
  return (await SwaggerParser.dereference(YAML.parse(source))) as unknown as ContractDocument;
}

/**
 * Indexes all OpenAPI operations in the contract document by their unique operationId.
 * Iterates through all path items and HTTP methods (delete, get, patch, post, put).
 *
 * @param document - Dereferenced OpenAPI contract document.
 * @returns Map indexing operationId to ContractOperation descriptor.
 */
export function operationsById(document: ContractDocument) {
  const operations = new Map<string, ContractOperation>();
  for (const pathItem of Object.values(document.paths)) {
    for (const method of methods) {
      const operation = pathItem[method];
      if (operation) operations.set(operation.operationId, operation);
    }
  }
  return operations;
}

export class ContractValidator {
  readonly operations: Map<string, ContractOperation>;
  readonly #ajv: Ajv2020;
  readonly #validators = new WeakMap<object, ValidateFunction>();

  /**
   * Initializes the contract validator with indexed operations and an Ajv JSON schema engine.
   *
   * @param document - Dereferenced OpenAPI specification document.
   */
  private constructor(document: ContractDocument) {
    this.operations = operationsById(document);
    this.#ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(this.#ajv);
  }

  /**
   * Asynchronous factory that loads the OpenAPI specification and returns an initialized ContractValidator.
   *
   * @returns Promise resolving to a new ContractValidator instance.
   */
  static async create(): Promise<ContractValidator> {
    return new ContractValidator(await loadContractDocument());
  }

  /**
   * Validates an incoming HTTP request body against the documented JSON schema for an operation.
   *
   * @param operationId - Target OpenAPI operation ID.
   * @param body - Parsed JSON request payload.
   * @returns Undefined if valid, or a formatted validation error message string.
   */
  validateRequest(operationId: string, body: unknown): string | undefined {
    const operation = this.operation(operationId);
    const schema = operation.requestBody?.content?.["application/json"]?.schema;
    return schema ? this.validate(schema, body) : undefined;
  }

  /**
   * Validates an HTTP response status code and body against the OpenAPI operation schema.
   * Confirms the status code is documented, verifies schema conformance, and checks for unexpected body presence.
   *
   * @param operationId - Target OpenAPI operation ID.
   * @param status - HTTP response status code.
   * @param body - Parsed JSON response body or undefined.
   * @returns Undefined if conforming, or an error message explaining the discrepancy.
   */
  validateResponse(operationId: string, status: number, body: unknown): string | undefined {
    const operation = this.operation(operationId);
    const response = operation.responses[String(status)];
    if (!response) {
      return `status ${status} is not documented`;
    }
    const schema = response.content?.["application/json"]?.schema;
    if (!schema) {
      return body === undefined ? undefined : "response body is not documented";
    }
    if (body === undefined) {
      return "documented response body is missing";
    }
    return this.validate(schema, body);
  }

  /**
   * Resolves an operation descriptor by its operationId, failing if unknown.
   *
   * @param operationId - Operation identifier to look up.
   * @returns ContractOperation descriptor.
   * @throws {Error} When operationId is not in the contract document.
   */
  private operation(operationId: string): ContractOperation {
    const operation = this.operations.get(operationId);
    if (!operation) throw new Error(`unknown OpenAPI operation: ${operationId}`);
    return operation;
  }

  /**
   * Compiles or retrieves cached Ajv validator for a schema object and evaluates input data.
   *
   * @param schema - JSON schema object.
   * @param body - Data payload to validate against the schema.
   * @returns Undefined if validation passed, or formatted Ajv error text.
   */
  private validate(schema: object, body: unknown): string | undefined {
    let validator = this.#validators.get(schema);
    if (!validator) {
      validator = this.#ajv.compile(schema);
      this.#validators.set(schema, validator);
    }
    return validator(body) ? undefined : this.#ajv.errorsText(validator.errors);
  }
}
