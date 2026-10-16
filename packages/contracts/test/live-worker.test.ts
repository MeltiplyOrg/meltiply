import { beforeAll, describe, expect, it } from "vite-plus/test";

import { ContractValidator } from "../test-support/validation";

const baseUrl = process.env.MELTIPLY_API_BASE_URL;
const describeLive = baseUrl ? describe : describe.skip;

interface LiveCase {
  body?: string;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  operationId: string;
  path: string;
  status: number;
}

const cases: LiveCase[] = [
  {
    operationId: "getHealth",
    path: "/api/v1/health",
    status: 200,
  },
  {
    operationId: "getReadiness",
    path: "/api/v1/ready",
    status: 200,
  },
  {
    operationId: "getCurrentUser",
    path: "/api/v1/users/me",
    status: 401,
  },
  {
    operationId: "listPlatformCapabilities",
    path: "/api/v1/platforms/capabilities",
    status: 401,
  },
  {
    operationId: "getAuthSession",
    path: "/api/auth/get-session",
    status: 200,
  },
];

describeLive("live local API Worker OpenAPI conformance", () => {
  let validator: ContractValidator;

  beforeAll(async () => {
    validator = await ContractValidator.create();
  });

  for (const testCase of cases) {
    it(`${testCase.operationId} returns its documented ${testCase.status}`, async () => {
      const response = await fetch(new URL(testCase.path, baseUrl), {
        body: testCase.body,
        headers: testCase.headers,
        method: testCase.method,
      });
      expect(response.status).toBe(testCase.status);
      expect(response.headers.get("X-Request-ID")).toBeTruthy();
      const responseBody = await response.json();
      expect(
        validator.validateResponse(testCase.operationId, response.status, responseBody),
      ).toBeUndefined();
    });
  }
});
