import { beforeAll, describe, expect, it } from "vite-plus/test";

import {
  ContractValidator,
  loadContractDocument,
  type ContractDocument,
  type ContractParameter,
} from "../test-support/validation";

interface JsonSchema {
  additionalProperties?: boolean | JsonSchema;
  enum?: unknown[];
  format?: string;
  items?: JsonSchema;
  minProperties?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  type?: string | string[];
}

const brandProfileId = "00000000-0000-4000-8000-000000000111";
const paletteColor = "#b91c1c";

const brandProfileFixture = {
  id: brandProfileId,
  org_id: "00000000-0000-4000-8000-000000000001",
  name: "Alpha Brand",
  color: paletteColor,
  description: "Editorial tools for independent publishers.",
  deleted_at: null,
  purge_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function brandOwnedMutations(document: ContractDocument): string[] {
  const owned: string[] = [];
  for (const pathItem of Object.values(document.paths)) {
    for (const method of ["delete", "get", "patch", "post", "put"] as const) {
      const operation = pathItem[method];
      const schema = operation?.requestBody?.content?.["application/json"]?.schema;
      const properties = schema && "properties" in schema ? schema.properties : undefined;
      if (
        operation &&
        properties &&
        typeof properties === "object" &&
        "brand_profile_id" in properties
      ) {
        owned.push(operation.operationId);
      }
    }
  }
  return owned.sort();
}

function schemaOf(document: ContractDocument, name: string): JsonSchema {
  const schema: JsonSchema | undefined = document.components?.schemas?.[name];
  expect(schema, `components.schemas.${name}`).toBeDefined();
  return schema!;
}

function queryParameters(
  document: ContractDocument,
  path: string,
  method: "delete" | "get" | "patch" | "post" | "put",
): ContractParameter[] {
  const pathItem = document.paths[path];
  const operation = pathItem?.[method];
  expect(operation, `${method.toUpperCase()} ${path}`).toBeDefined();
  return [...(pathItem?.parameters ?? []), ...(operation?.parameters ?? [])].filter(
    (parameter) => parameter.in === "query",
  );
}

function brandProfileQueryParameter(
  document: ContractDocument,
  path: string,
  method: "delete" | "get" | "patch" | "post" | "put",
): ContractParameter | undefined {
  return queryParameters(document, path, method).find(
    (parameter) => parameter.name === "brand_profile_id",
  );
}

describe("brand profile contract", async () => {
  const document = await loadContractDocument();
  const validator = await ContractValidator.create();
  const owned = brandOwnedMutations(document);

  beforeAll(() => {
    for (const operationId of [...owned, "createBrandProfile", "updateBrandProfile"]) {
      validator.validateRequest(operationId, {});
    }
    validator.validateResponse("listBrandProfiles", 200, {});
  });

  it.each([
    ["get", "/brand-profiles", "listBrandProfiles"],
    ["post", "/brand-profiles", "createBrandProfile"],
    ["get", "/brand-profiles/deleted", "listDeletedBrandProfiles"],
    ["get", "/brand-profiles/{profile_id}", "getBrandProfile"],
    ["patch", "/brand-profiles/{profile_id}", "updateBrandProfile"],
    ["delete", "/brand-profiles/{profile_id}", "deleteBrandProfile"],
    ["post", "/brand-profiles/{profile_id}/restore", "restoreBrandProfile"],
  ] as const)("exposes %s %s", (method, path, operationId) => {
    expect(document.paths[path]?.[method]?.operationId).toBe(operationId);
  });

  it("defines the workspace-owned brand profile resource with lifecycle timestamps", () => {
    const schema = schemaOf(document, "BrandProfile");
    expect(schema.required).toEqual(
      expect.arrayContaining([
        "id",
        "org_id",
        "name",
        "color",
        "deleted_at",
        "purge_at",
        "created_at",
        "updated_at",
      ]),
    );
    expect(schema.properties?.org_id).toMatchObject({
      type: "string",
      format: "uuid",
    });
    for (const field of ["deleted_at", "purge_at"] as const) {
      expect(schema.properties?.[field]?.type, field).toEqual(["string", "null"]);
      expect(schema.properties?.[field]?.format, field).toBe("date-time");
    }
    for (const field of ["created_at", "updated_at"] as const) {
      expect(schema.properties?.[field]?.type, field).toBe("string");
      expect(schema.properties?.[field]?.format, field).toBe("date-time");
    }
  });

  it("exposes a nullable short description on every brand profile", () => {
    const schema = schemaOf(document, "BrandProfile");
    expect(schema.required).toContain("description");
    expect(schema.properties?.description).toMatchObject({
      maxLength: 280,
      type: ["string", "null"],
    });
  });

  it("requires name and color while accepting an optional short description", () => {
    const create = schemaOf(document, "CreateBrandProfileRequest");
    expect(create.required).toEqual(expect.arrayContaining(["name", "color"]));
    expect(create.properties?.description).toMatchObject({
      maxLength: 280,
      type: ["string", "null"],
    });
    const update = schemaOf(document, "UpdateBrandProfileRequest");
    expect(update.required ?? []).not.toContain("name");
    expect(update.required ?? []).not.toContain("color");
    expect(update.minProperties).toBe(1);
  });

  it("fixes the color label to an accessible palette of at least 50 entries", () => {
    const palette = schemaOf(document, "BrandProfileColor");
    expect(palette.type).toBe("string");
    expect(Array.isArray(palette.enum)).toBe(true);
    expect(palette.enum!.length).toBeGreaterThanOrEqual(50);
    expect(palette.enum!.every((label, index) => palette.enum!.indexOf(label) === index)).toBe(
      true,
    );
    for (const label of palette.enum!) {
      expect(label).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(schemaOf(document, "BrandProfile").properties?.color).toEqual(palette);
    expect(schemaOf(document, "CreateBrandProfileRequest").properties?.color).toEqual(palette);
    expect(schemaOf(document, "UpdateBrandProfileRequest").properties?.color).toEqual(palette);
  });

  it.each([
    "/platforms",
    "/posts",
    "/distributions",
    "/calendar",
    "/analytics",
    "/analytics/posts",
    "/analytics/dashboard",
    "/inbox",
  ])("filters GET %s by an optional brand_profile_id", (path) => {
    const parameter = brandProfileQueryParameter(document, path, "get");

    expect(parameter).toBeDefined();
    expect(parameter!.required ?? false).toBe(false);
    expect(parameter!.schema).toMatchObject({ type: "string", format: "uuid" });
  });

  it("requires a brand_profile_id query parameter to read queues", () => {
    const parameter = brandProfileQueryParameter(document, "/queues", "get");
    expect(parameter).toBeDefined();
    expect(parameter!.required).toBe(true);
    expect(parameter!.schema).toMatchObject({
      type: "string",
      format: "uuid",
    });
  });

  it("assigns the Brand Profile when confirming OAuth, not at start", () => {
    expect(
      brandProfileQueryParameter(document, "/platforms/{platform}/connect", "get"),
    ).toBeUndefined();

    const startResponse = schemaOf(document, "OAuthStartResponse");
    expect(Object.keys(startResponse.properties ?? {})).not.toContain("brand_profile_id");

    const selection = schemaOf(document, "OAuthSelection");
    expect(selection.required ?? []).not.toContain("brand_profile_id");

    const confirm = schemaOf(document, "OAuthSelectionConfirmRequest");
    expect(confirm.required).toContain("brand_profile_id");
    expect(confirm.properties?.brand_profile_id).toMatchObject({
      type: "string",
      format: "uuid",
    });
  });

  const named = { name: "Alpha Brand", color: paletteColor };
  const accepted: [string, string, unknown][] = [
    ["a described profile", "createBrandProfile", { ...named, description: "Editorial tools." }],
    ["a colour change", "updateBrandProfile", { color: paletteColor }],
    ["a cleared description", "updateBrandProfile", { description: null }],
    ["a description of 280 characters", "updateBrandProfile", { description: "x".repeat(280) }],
  ];
  const rejected: [string, string, unknown, RegExp][] = [
    [
      "a colour outside the palette",
      "createBrandProfile",
      { ...named, color: "not-a-palette-color" },
      /^data\/color must be equal to one of the allowed values/,
    ],
    [
      "a missing colour",
      "createBrandProfile",
      { name: "Alpha Brand" },
      /required property 'color'/,
    ],
    [
      "an empty description",
      "createBrandProfile",
      { ...named, description: "" },
      /data\/description must match pattern/,
    ],
    [
      "a description of 281 characters",
      "updateBrandProfile",
      { description: "x".repeat(281) },
      /data\/description must NOT have more than 280 characters/,
    ],
    ["an empty update", "updateBrandProfile", {}, /data must NOT have fewer than 1 properties/],
  ];

  it.each(accepted)("accepts %s", (_example, operationId, body) => {
    expect(validator.validateRequest(operationId, body)).toBeUndefined();
  });

  it.each(rejected)("rejects %s", (_example, operationId, body, problem) => {
    expect(validator.validateRequest(operationId, body)).toMatch(problem);
  });

  it("accepts a listed profile", () => {
    expect(
      validator.validateResponse("listBrandProfiles", 200, { profiles: [brandProfileFixture] }),
    ).toBeUndefined();
  });

  it("rejects a listed profile with a colour outside the palette", () => {
    const profiles = [{ ...brandProfileFixture, color: "mauve" }];

    expect(validator.validateResponse("listBrandProfiles", 200, { profiles })).toMatch(
      /data\/profiles\/0\/color must be equal to one of the allowed values/,
    );
  });

  it("lists every brand-owned mutation", () => {
    expect(owned).toEqual(
      expect.arrayContaining([
        "confirmOAuthSelection",
        "createPost",
        "createQueue",
        "createUploadSession",
        "deletePost",
        "deleteQueue",
        "removePostFromQueue",
        "replyToComment",
        "schedulePost",
        "updatePost",
        "updateQueue",
      ]),
    );
  });

  it.each(owned)("requires brand_profile_id on %s", (operationId) => {
    expect(validator.validateRequest(operationId, {})).toMatch(/brand_profile_id/);
  });

  it.each([
    ["createPost", { brand_profile_id: brandProfileId, default_text: "Hello world" }],
    ["replyToComment", { brand_profile_id: brandProfileId, text: "Thanks!" }],
  ])("accepts %s with a brand profile", (operationId, body) => {
    expect(validator.validateRequest(operationId, body)).toBeUndefined();
  });
});
