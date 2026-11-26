import { beforeAll, describe, expect, it } from "vite-plus/test";

import { ContractValidator } from "../test-support/validation";

let validator: ContractValidator;

beforeAll(async () => {
  validator = await ContractValidator.create();
  validator.validateRequest("createBrandProfile", {});
  validator.validateResponse("listBrandProfiles", 200, {});
});

describe("ContractValidator", () => {
  describe("validateRequest", () => {
    it("a body the operation rejects", () => {
      expect(validator.validateRequest("createBrandProfile", { name: "Alpha" })).toMatch(
        /required property 'color'/,
      );
    });

    it("an operation with no JSON request body", () => {
      expect(validator.validateRequest("getHealth", { anything: true })).toEqual(undefined);
    });

    it("an unknown operation", () => {
      expect(() => validator.validateRequest("missingOperation", {})).toThrow(
        new Error("unknown OpenAPI operation: missingOperation"),
      );
    });
  });

  describe("validateResponse", () => {
    it.each([
      ["an undocumented status", "getHealth", 418, {}, "status 418 is not documented"],
      [
        "a missing documented body",
        "listBrandProfiles",
        200,
        undefined,
        "documented response body is missing",
      ],
    ])("%s", (_example, operationId, status, body, problem) => {
      expect(validator.validateResponse(operationId, status, body)).toEqual(problem);
    });

    it("a body the status rejects", () => {
      expect(validator.validateResponse("listBrandProfiles", 200, {})).toMatch(
        /required property 'profiles'/,
      );
    });
  });
});
