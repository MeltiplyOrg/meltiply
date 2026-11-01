import { describe, expect, it } from "vite-plus/test";

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

/**
 * Every operation whose request schema carries a `brand_profile_id` property.
 * Descending from `properties` (not `required`) keeps the required-field check
 * meaningful: a field that is declared but optional still has to be found here
 * and then rejected by the assertion below.
 */
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

/**
 * Resolves a dereferenced component schema by name, failing if it is absent.
 * Its structural JsonSchema type supports the brand-profile contract assertions.
 */
function schemaOf(document: ContractDocument, name: string): JsonSchema {
  const schema: JsonSchema | undefined = document.components?.schemas?.[name];
  expect(schema, `components.schemas.${name}`).toBeDefined();
  return schema!;
}

/**
 * Collects the effective query parameters of one operation by merging
 * path-item-level and operation-level parameter lists, mirroring OpenAPI
 * parameter inheritance. Fails the test when the operation is absent.
 */
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

/**
 * Finds the brand_profile_id query parameter of one operation, or undefined
 * when the operation does not declare one.
 */
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

  it("exposes the full brand profile management operation set", () => {
    const expected: Array<["delete" | "get" | "patch" | "post", string, string]> = [
      ["get", "/brand-profiles", "listBrandProfiles"],
      ["post", "/brand-profiles", "createBrandProfile"],
      ["get", "/brand-profiles/deleted", "listDeletedBrandProfiles"],
      ["get", "/brand-profiles/{profile_id}", "getBrandProfile"],
      ["patch", "/brand-profiles/{profile_id}", "updateBrandProfile"],
      ["delete", "/brand-profiles/{profile_id}", "deleteBrandProfile"],
      ["post", "/brand-profiles/{profile_id}/restore", "restoreBrandProfile"],
    ];
    for (const [method, path, operationId] of expected) {
      const operation = document.paths[path]?.[method];
      expect(operation?.operationId, `${method.toUpperCase()} ${path}`).toBe(operationId);
    }
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

  /**
   * Locks the nullable short description contract so every Brand Profile response
   * carries either a 280-character plain-text summary or null. The field is always
   * present in the response (never omitted) and stays optional on write payloads.
   * This lets the Channels board describe a profile without inventing client-only
   * profile metadata.
   */
  it("exposes a nullable short description on every brand profile", () => {
    const schema = schemaOf(document, "BrandProfile");
    expect(schema.required).toContain("description");
    expect(schema.properties?.description).toMatchObject({
      maxLength: 280,
      type: ["string", "null"],
    });
  });

  /**
   * Keeps profile creation focused on a name and accessible color while accepting
   * a nullable short description; updates must retain their partial-patch shape.
   */
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

  it("filters aggregate reads by an optional brand_profile_id query parameter", () => {
    const filtered: Array<["get", string]> = [
      ["get", "/platforms"],
      ["get", "/posts"],
      ["get", "/distributions"],
      ["get", "/calendar"],
      ["get", "/analytics"],
      ["get", "/analytics/posts"],
      ["get", "/analytics/dashboard"],
      ["get", "/inbox"],
    ];
    for (const [method, path] of filtered) {
      const parameter = brandProfileQueryParameter(document, path, method);
      expect(parameter, `GET ${path} brand_profile_id`).toBeDefined();
      expect(parameter!.required ?? false, `GET ${path}`).toBe(false);
      expect(parameter!.schema, `GET ${path}`).toMatchObject({
        type: "string",
        format: "uuid",
      });
    }
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

  /**
   * Exercises the generated validator with the optional description payload so
   * the OpenAPI limit protects both creation and description-only updates. Each
   * rejection asserts the failing keyword and field, so an unrelated validation
   * failure (for example a missing required sibling) cannot satisfy it.
   */
  it("accepts and rejects brand profile payloads at the validator seam", () => {
    expect(
      validator.validateRequest("createBrandProfile", {
        name: "Alpha Brand",
        description: "Editorial tools for independent publishers.",
        color: paletteColor,
      }),
    ).toBeUndefined();
    expect(
      validator.validateRequest("createBrandProfile", {
        name: "Alpha Brand",
        color: "not-a-palette-color",
      }),
    ).toMatch(/^data\/color must be equal to one of the allowed values/);
    expect(validator.validateRequest("createBrandProfile", { name: "Alpha Brand" })).toMatch(
      /required property 'color'/,
    );
    expect(
      validator.validateRequest("createBrandProfile", {
        name: "Alpha Brand",
        color: paletteColor,
        description: "",
      }),
    ).toMatch(/data\/description must match pattern/);
    expect(
      validator.validateRequest("updateBrandProfile", { color: paletteColor }),
    ).toBeUndefined();
    expect(validator.validateRequest("updateBrandProfile", { description: null })).toBeUndefined();
    expect(
      validator.validateRequest("updateBrandProfile", { description: "x".repeat(280) }),
    ).toBeUndefined();
    expect(
      validator.validateRequest("updateBrandProfile", {
        description: "x".repeat(281),
      }),
    ).toMatch(/data\/description must NOT have more than 280 characters/);
    expect(validator.validateRequest("updateBrandProfile", {})).toMatch(
      /data must NOT have fewer than 1 properties/,
    );
    expect(
      validator.validateResponse("listBrandProfiles", 200, {
        profiles: [brandProfileFixture],
      }),
    ).toBeUndefined();
    expect(
      validator.validateResponse("listBrandProfiles", 200, {
        profiles: [{ ...brandProfileFixture, color: "mauve" }],
      }),
    ).toMatch(/data\/profiles\/0\/color must be equal to one of the allowed values/);
  });

  it("rejects brand-owned mutations that omit brand_profile_id", () => {
    const owned = brandOwnedMutations(document);
    // Anti-vacuity guard: the derived set must still contain every mutation that
    // owns content, so deleting the property from the contract fails loudly here
    // instead of shrinking the loop to nothing.
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

    for (const operationId of owned) {
      expect(
        validator.validateRequest(operationId, {}),
        `${operationId} must require brand_profile_id`,
      ).toMatch(/brand_profile_id/);
    }

    expect(
      validator.validateRequest("createPost", {
        brand_profile_id: brandProfileId,
        default_text: "Hello world",
      }),
    ).toBeUndefined();
    expect(
      validator.validateRequest("replyToComment", {
        brand_profile_id: brandProfileId,
        text: "Thanks!",
      }),
    ).toBeUndefined();
  });
});
