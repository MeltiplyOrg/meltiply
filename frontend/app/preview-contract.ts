import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import YAML from "yaml";
import { parseSync } from "oxc-parser";
import type { Plugin } from "vite-plus";
import {
  previewObjectSchema,
  type PreviewContract,
  type PreviewMethod,
  type PreviewOperation,
  type PreviewResponse,
} from "./src/preview/contract-types";
import { exampleForSchema, resolvePreviewReference } from "./preview-schema";

const virtualId = "virtual:preview-contract";
const resolvedId = `\0${virtualId}`;
const specificationPath = fileURLToPath(
  new URL("../../packages/contracts/openapi.yaml", import.meta.url),
);
const examplesPath = fileURLToPath(
  new URL("../../packages/contracts/examples/operations.yaml", import.meta.url),
);
const routerPath = fileURLToPath(new URL("./src/app-router.tsx", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const seedPath = fileURLToPath(
  new URL("../../scripts/cloudflare-local/postgres/seed.sql", import.meta.url),
);
const migrationDirectory = fileURLToPath(
  new URL("../../packages/database/migrations/", import.meta.url),
);
const seedCompilerPath = fileURLToPath(
  new URL("../../scripts/lib/preview-seed.ts", import.meta.url),
);
const methods: PreviewMethod[] = ["get", "post", "put", "patch", "delete", "head", "options"];
const serversSchema = Schema.Array(Schema.Struct({ url: Schema.String }));
const responseSchema = Schema.Struct({
  status: Schema.Number,
  body: Schema.optional(Schema.MutableJson),
});
const exampleSchema = Schema.Struct({
  success: responseSchema,
  errors: Schema.Array(responseSchema),
});
const routeOpeningSchema = Schema.Struct({
  type: Schema.Literal("JSXOpeningElement"),
  name: Schema.Struct({ type: Schema.Literal("JSXIdentifier"), name: Schema.Literal("Route") }),
  attributes: Schema.Array(Schema.Unknown),
});
const pathAttributeSchema = Schema.Struct({
  type: Schema.Literal("JSXAttribute"),
  name: Schema.Struct({ name: Schema.Literal("path") }),
  value: Schema.Struct({ type: Schema.Literal("Literal"), value: Schema.String }),
});

/** Reads literal Route paths from the actual TSX router, not a second hand-maintained navigation inventory. Wildcard fallbacks are excluded. */
function frontendRoutes(): string[] {
  const ast = parseSync(routerPath, readFileSync(routerPath, "utf8"), {
    lang: "tsx",
    sourceType: "module",
  });
  if (ast.errors.length)
    throw new Error(`Cannot compile preview routes: ${ast.errors[0]?.message}`);
  const routes = new Set<string>();
  /** Walks parser-owned objects; only schema-validated Route/path nodes contribute browser destinations. */
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (Schema.is(routeOpeningSchema)(value))
      for (const attribute of value.attributes) {
        if (Schema.is(pathAttributeSchema)(attribute) && attribute.value.value.startsWith("/"))
          routes.add(attribute.value.value.replace(/\/\*$/, ""));
      }
    const children: unknown[] = Object.values(value);
    children.forEach(visit);
  }
  visit(ast.program);
  return [...routes];
}

/** Compiles documented transport outcomes, then overlays tenant-scoped public data from the disposable SQL seed compiler. Catalog mismatches, invalid JSON, or seed-process failures abort the build; filesystem and database work never enters the browser graph. */
async function compileContract(): Promise<PreviewContract> {
  const source = Schema.decodeUnknownSync(previewObjectSchema)(
    YAML.parse(readFileSync(specificationPath, "utf8"), { merge: true }),
  );
  const document = Schema.decodeUnknownSync(
    Schema.Struct({
      servers: serversSchema,
      paths: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
    }),
  )(source);
  const catalog = Schema.decodeUnknownSync(
    Schema.Struct({
      fixtures: Schema.Record(Schema.String, Schema.MutableJson),
      operations: Schema.Record(Schema.String, exampleSchema),
    }),
  )(YAML.parse(readFileSync(examplesPath, "utf8"), { merge: true }));
  const operations: PreviewOperation[] = [];
  const ids = new Set<string>();
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of methods) {
      if (!pathItem[method]) continue;
      const operation = Schema.decodeUnknownSync(
        Schema.Struct({
          operationId: Schema.String,
          servers: Schema.optional(serversSchema),
          responses: Schema.Record(Schema.String, Schema.Unknown),
        }),
      )(pathItem[method]);
      const example = catalog.operations[operation.operationId];
      if (!example || ids.has(operation.operationId))
        throw new Error(`Missing or duplicate preview example: ${operation.operationId}`);
      const pathServers =
        pathItem.servers === undefined
          ? document.servers
          : Schema.decodeUnknownSync(serversSchema)(pathItem.servers);
      const server = (operation.servers ?? pathServers)[0];
      if (!server) throw new Error(`Missing preview API base: ${operation.operationId}`);
      for (const response of [example.success, ...example.errors])
        if (!operation.responses[String(response.status)])
          throw new Error(
            `Undocumented preview status ${operation.operationId}: ${response.status}`,
          );
      const prefix = new URL(server.url, "http://preview.invalid").pathname.replace(/\/$/, "");
      const examples = [example.success, ...example.errors];
      const responses: PreviewResponse[] = Object.entries(operation.responses)
        .filter(([status]) => /^\d{3}$/.test(status))
        .map(([status, definition]) => {
          const existing = examples.find((response) => response.status === Number(status));
          if (existing) return existing;
          const response = resolvePreviewReference(definition, source);
          const content = Schema.decodeUnknownSync(previewObjectSchema)(response.content ?? {});
          const media = content["application/json"];
          if (media === undefined) return { status: Number(status) };
          const json = Schema.decodeUnknownSync(previewObjectSchema)(media);
          return {
            status: Number(status),
            body:
              json.example !== undefined
                ? json.example
                : exampleForSchema(json.schema ?? {}, source),
          };
        });
      const success =
        example.success.status < 300
          ? example.success
          : (responses.find((response) => response.status >= 200 && response.status < 300) ??
            example.success);
      operations.push({
        operationId: operation.operationId,
        method,
        path: `${prefix}${path}`,
        success,
        errors: responses.filter((response) => response.status >= 400),
        responses,
      });
      ids.add(operation.operationId);
    }
  }
  for (const id of Object.keys(catalog.operations))
    if (!ids.has(id)) throw new Error(`Preview example has no operation: ${id}`);
  const fixtures = Object.fromEntries(
    Object.entries(catalog.fixtures).filter(
      ([key]) => !["bearer_authorization", "session_cookie"].includes(key),
    ),
  );
  const { stdout } = await promisify(execFile)("bun", ["run", "--silent", "preview:seed"], {
    cwd: repositoryRoot,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  const seed = Schema.decodeUnknownSync(
    Schema.Struct({
      responses: Schema.Record(Schema.String, Schema.MutableJson),
      fixtures: previewObjectSchema,
    }),
  )(JSON.parse(stdout));
  const operationsById = new Map(operations.map((operation) => [operation.operationId, operation]));
  for (const [operationId, body] of Object.entries(seed.responses)) {
    const operation = operationsById.get(operationId);
    if (!operation) throw new Error(`Seed projection has no documented operation: ${operationId}`);
    operation.success = { ...operation.success, body };
    operation.responses = operation.responses.map((response) =>
      response.status === operation.success.status ? operation.success : response,
    );
    operation.seeded = true;
  }
  return { operations, fixtures, seedFixtures: seed.fixtures, routes: frontendRoutes() };
}

/** Supplies a browser-safe, transport-header-free manifest only to preview/test builds; parser and filesystem dependencies never enter the frontend bundle. */
export function previewContractPlugin(): Plugin {
  let compiled: Promise<PreviewContract> | undefined;
  return {
    name: "preview-contract",
    resolveId(id) {
      return id === virtualId ? resolvedId : undefined;
    },
    watchChange() {
      compiled = undefined;
    },
    load(id) {
      if (id !== resolvedId) return;
      for (const path of [
        specificationPath,
        examplesPath,
        routerPath,
        seedPath,
        migrationDirectory,
        seedCompilerPath,
      ])
        this.addWatchFile(path);
      compiled ??= compileContract();
      return compiled.then((contract) => `export default ${JSON.stringify(contract)};`);
    },
  };
}
