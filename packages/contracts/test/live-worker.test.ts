import { beforeAll, describe, expect, it } from "vite-plus/test";

import { ContractValidator } from "../test-support/validation";

const baseUrl = process.env.MELTIPLY_API_BASE_URL;
const describeLive = baseUrl ? describe : describe.skip;

interface LiveCase {
  operationId: string;
  path: string;
  status: number;
}

/**
 * Unauthenticated probes of the local Worker. The cases are the only operations
 * whose documented behaviour is observable without a credential; every other
 * operation is exercised by the authenticated suites.
 */
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
      const response = await fetch(new URL(testCase.path, baseUrl), { method: "GET" });
      expect(response.status).toBe(testCase.status);

      // `validateResponse` also rejects a status the operation does not document,
      // so a worker that starts answering 404 or 500 cannot pass unnoticed.
      //
      // X-Request-ID is asserted for every status because the Worker's app-level
      // middleware stamps it on all responses (workers/api/src/app.ts), even
      // where the contract only repeats the header on some of them. Headers the
      // contract makes conditional (for example `set-auth-jwt`, sent only for an
      // active session) are deliberately not asserted by these anonymous probes.
      expect(response.headers.get("X-Request-ID")).toBeTruthy();

      // Reading text keeps a non-JSON body from surfacing as a parse error
      // instead of the conformance failure it is; an empty body reaches the
      // validator as `undefined` so a missing documented body is reported.
      const text = await response.text();
      const body = text.length > 0 ? JSON.parse(text) : undefined;
      expect(
        validator.validateResponse(testCase.operationId, response.status, body),
        `${testCase.operationId} ${testCase.status} body`,
      ).toBeUndefined();
    });
  }
});
