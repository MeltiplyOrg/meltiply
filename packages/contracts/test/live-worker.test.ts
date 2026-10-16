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
  {
    body: JSON.stringify({
      data: { product: { id: "11111111-1111-4111-8111-111111111111" } },
      type: "subscription.updated",
    }),
    headers: {
      "Content-Type": "application/json",
      "webhook-id": "msg_invalid_billing",
      "webhook-signature": "v1,invalid",
      "webhook-timestamp": "1",
    },
    method: "POST",
    operationId: "handleBillingWebhook",
    path: "/api/v1/billing/webhook",
    status: 401,
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
