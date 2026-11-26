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
let cachedDocumentPromise: Promise<ContractDocument> | undefined;

function isContractDocument(value: unknown): value is ContractDocument {
  return (
    value !== null &&
    typeof value === "object" &&
    "paths" in value &&
    typeof value.paths === "object" &&
    value.paths !== null
  );
}

export function loadContractDocument(): Promise<ContractDocument> {
  if (!cachedDocumentPromise) {
    cachedDocumentPromise = (async () => {
      const source = await readFile(openApiPath, "utf8");
      const dereferenced: unknown = await SwaggerParser.dereference(YAML.parse(source));
      if (!isContractDocument(dereferenced)) {
        throw new TypeError("OpenAPI document is missing top-level paths");
      }
      return dereferenced;
    })();
  }
  return cachedDocumentPromise;
}

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

  private constructor(document: ContractDocument) {
    this.operations = operationsById(document);
    this.#ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(this.#ajv);
  }

  static async create(): Promise<ContractValidator> {
    return new ContractValidator(await loadContractDocument());
  }

  validateRequest(operationId: string, body: unknown): string | undefined {
    const operation = this.operation(operationId);
    const schema = operation.requestBody?.content?.["application/json"]?.schema;
    return schema ? this.validate(schema, body) : undefined;
  }

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

  private operation(operationId: string): ContractOperation {
    const operation = this.operations.get(operationId);
    if (!operation) throw new Error(`unknown OpenAPI operation: ${operationId}`);
    return operation;
  }

  private validate(schema: object, body: unknown): string | undefined {
    let validator = this.#validators.get(schema);
    if (!validator) {
      validator = this.#ajv.compile(schema);
      this.#validators.set(schema, validator);
    }
    return validator(body) ? undefined : this.#ajv.errorsText(validator.errors);
  }
}
