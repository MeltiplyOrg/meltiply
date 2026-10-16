// Response.json() is `unknown` under the pool's types but `any` in eslint's
// project, so the necessary body assertions look unnecessary to the rule
// (AUD-055); the assertions are required for tsc.
/* oxlint-disable @typescript-eslint/no-unnecessary-type-assertion */
import type { JwtIdentity } from "@meltiply/auth";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import type { ResolvedActor } from "../src/actor-resolution";
import { createApiApp } from "../src/app";
import { withSystemTransactionEffect } from "../src/database";
import type { ApiWorkerEnv } from "../src/env";

const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for PostgreSQL integration suites");
}
const describeIntegration = describe;

const env = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  DB_AUTHENTICATED: { connectionString } as Hyperdrive,
  DB_SYSTEM: {
    connectionString:
      "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable",
  } as Hyperdrive,
  ENVIRONMENT: "test",
  VERSION: "1.0.0-target.0",
} satisfies ApiWorkerEnv;

// Better Auth subjects plus the internal Workspace memberships the server
// resolved from org_members, mirroring the confirmed actor claims contract:
// subject = Better Auth user id, userId = internal users.id UUID,
// organizationId = resolved workspace UUID, organizationRole = member role.
const alpha: ResolvedActor = {
  authUserId: "auth_user_local_alpha",
  claims: {
    organizationId: "20000000-0000-4000-8000-000000000001",
    organizationRole: "admin",
    subject: "auth_user_local_alpha",
    userId: "10000000-0000-4000-8000-000000000001",
  },
  role: "admin",
  userId: "10000000-0000-4000-8000-000000000001",
  workspace: {
    id: "20000000-0000-4000-8000-000000000001",
    isPersonal: false,
    name: "Alpha Studio",
    plan: "creator",
    slug: "alpha-studio",
  },
};

const beta: ResolvedActor = {
  authUserId: "auth_user_local_beta",
  claims: {
    organizationId: "20000000-0000-4000-8000-000000000002",
    organizationRole: "admin",
    subject: "auth_user_local_beta",
    userId: "10000000-0000-4000-8000-000000000002",
  },
  role: "admin",
  userId: "10000000-0000-4000-8000-000000000002",
  workspace: {
    id: "20000000-0000-4000-8000-000000000002",
    isPersonal: false,
    name: "Beta Studio",
    plan: "free",
    slug: "beta-studio",
  },
};

const requestIds: string[] = [];
let sequence = 0;

/**
 * Builds the API app with the JWT verifier and actor resolver stubbed to the
 * given actor: `verifyJwtToken` returns the verified identity for the actor's
 * auth subject and `resolveActor` returns the actor unchanged, so protected
 * routes run without a real Better Auth round-trip.
 */
function appFor(actor: ResolvedActor) {
  const jwtIdentity: JwtIdentity = {
    email: `${actor.authUserId}@example.test`,
    name: actor.workspace.name,
    subject: actor.authUserId,
  };
  return createApiApp({
    betterAuth: {
      api: { getSession: async () => null },
      handler: async () => new Response("ok"),
    } as never,
    resolveActor: async () => actor,
    verifyJwtToken: async () => jwtIdentity,
  });
}

/**
 * Returns the fixed JWT bearer Authorization header every protected request
 * carries; the stubbed `verifyJwtToken` accepts the token value as-is.
 */
function authorization() {
  return { Authorization: "Bearer test-only.jwt" };
}

/**
 * Every /api/v1 request (including the flow routes themselves) records a run
 * through the middleware, so each test request carries its own tracked
 * X-Request-ID for deterministic lookups and cleanup.
 */
async function tracedRequest(
  instance: ReturnType<typeof createApiApp>,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ requestId: string; response: Response }> {
  const requestId = `flow-integration-${String(sequence++).padStart(4, "0")}`;
  requestIds.push(requestId);
  const response = await instance.request(
    path,
    {
      headers: {
        ...authorization(),
        ...headers,
        "X-Request-ID": requestId,
      },
    },
    env as never,
  );
  return { requestId, response };
}

async function deleteTracedRuns(): Promise<void> {
  await Effect.runPromise(
    withSystemTransactionEffect(env, (client) =>
      client.query(
        `DELETE FROM flow_runs
         WHERE request_id = ANY($1::text[])
            OR request_id LIKE 'flow-integration-%'`,
        [requestIds],
      ),
    ),
  );
  requestIds.length = 0;
}

describeIntegration("flow observability integration", () => {
  beforeAll(async () => {
    await deleteTracedRuns();
  });

  afterAll(async () => {
    await deleteTracedRuns();
  });

  it("records a sanitized run and steps for an authenticated request", async () => {
    const instance = appFor(alpha);
    const { requestId } = await tracedRequest(instance, "/api/v1/platforms/capabilities");

    const { response: runsResponse } = await tracedRequest(
      instance,
      "/api/v1/flows/runs?limit=200",
    );
    expect(runsResponse.status).toBe(200);
    const runsBody = (await runsResponse.json()) as {
      runs: Array<{
        id: string;
        entrypoint: string;
        request_id: string;
        status: string;
        metadata: Record<string, unknown>;
      }>;
    };
    const run = runsBody.runs.find((row) => row.request_id === requestId);
    expect(run).toBeDefined();
    expect(run?.entrypoint).toBe("/api/v1/platforms/capabilities");
    expect(run?.status).toBe("succeeded");
    expect(run?.metadata).toEqual({
      http_method: "GET",
      route: "/api/v1/platforms/capabilities",
    });

    const { response: stepsResponse } = await tracedRequest(
      instance,
      `/api/v1/flows/runs/${run?.id}/steps`,
    );
    expect(stepsResponse.status).toBe(200);
    const stepsBody = (await stepsResponse.json()) as {
      steps: Array<{
        node_key: string;
        operation: string;
        status: string;
        metadata: Record<string, unknown>;
      }>;
    };
    expect(stepsBody.steps.map((step) => step.node_key)).toEqual(
      expect.arrayContaining(["auth", "core"]),
    );
    const authStep = stepsBody.steps.find((step) => step.node_key === "auth");
    expect(authStep?.operation).toBe("verify_session");
    expect(authStep?.status).toBe("succeeded");
    const coreStep = stepsBody.steps.find((step) => step.node_key === "core");
    expect(coreStep?.operation).toBe("GET /api/v1/platforms/capabilities");
    expect(coreStep?.status).toBe("succeeded");
    // Sanitized ledger: only whitelisted metadata keys, never tenant payloads.
    for (const step of stepsBody.steps) {
      expect(Object.keys(step.metadata)).toEqual([]);
    }
  });

  it("scopes runs and steps to the caller's organization", async () => {
    const alphaApp = appFor(alpha);
    const betaApp = appFor(beta);
    const { requestId } = await tracedRequest(alphaApp, "/api/v1/platforms/capabilities");

    const { response: alphaRunsResponse } = await tracedRequest(
      alphaApp,
      "/api/v1/flows/runs?limit=200",
    );
    const alphaRuns = (await alphaRunsResponse.json()) as {
      runs: Array<{ id: string; request_id: string }>;
    };
    const alphaRun = alphaRuns.runs.find((row) => row.request_id === requestId);
    expect(alphaRun).toBeDefined();

    // Beta must not see alpha's run in the list, the detail, or its steps.
    const { response: betaRunsResponse } = await tracedRequest(
      betaApp,
      "/api/v1/flows/runs?limit=200",
    );
    const betaRuns = (await betaRunsResponse.json()) as {
      runs: Array<{ request_id: string }>;
    };
    expect(betaRuns.runs.find((row) => row.request_id === requestId)).toBeUndefined();

    const { response: betaDetail } = await tracedRequest(
      betaApp,
      `/api/v1/flows/runs/${alphaRun?.id}`,
    );
    expect(betaDetail.status).toBe(404);

    const { response: betaSteps } = await tracedRequest(
      betaApp,
      `/api/v1/flows/runs/${alphaRun?.id}/steps`,
    );
    expect(betaSteps.status).toBe(200);
    const betaStepsBody = (await betaSteps.json()) as { steps: unknown[] };
    expect(betaStepsBody.steps).toEqual([]);

    // Alpha's own run remains visible with its steps.
    const { response: alphaSteps } = await tracedRequest(
      alphaApp,
      `/api/v1/flows/runs/${alphaRun?.id}/steps`,
    );
    const alphaStepsBody = (await alphaSteps.json()) as { steps: unknown[] };
    expect(alphaStepsBody.steps.length).toBeGreaterThan(0);
  });

  it("does not merge flow runs across organizations on request-ID reuse", async () => {
    const alphaApp = appFor(alpha);
    const betaApp = appFor(beta);
    const { requestId } = await tracedRequest(alphaApp, "/api/v1/platforms/capabilities");

    const betaResponse = await betaApp.request(
      "/api/v1/health",
      {
        headers: {
          ...authorization(),
          "X-Request-ID": requestId,
        },
      },
      env as never,
    );
    expect(betaResponse.status).toBe(200);

    const { response: alphaRunsResponse } = await tracedRequest(
      alphaApp,
      "/api/v1/flows/runs?limit=200",
    );
    const alphaRuns = (await alphaRunsResponse.json()) as {
      runs: Array<{
        entrypoint: string;
        metadata: Record<string, unknown>;
        request_id: string;
      }>;
    };
    const alphaRun = alphaRuns.runs.find((row) => row.request_id === requestId);
    expect(alphaRun?.entrypoint).toBe("/api/v1/platforms/capabilities");
    expect(alphaRun?.metadata).toEqual({
      http_method: "GET",
      route: "/api/v1/platforms/capabilities",
    });

    const { response: betaRunsResponse } = await tracedRequest(
      betaApp,
      "/api/v1/flows/runs?limit=200",
    );
    const betaRuns = (await betaRunsResponse.json()) as {
      runs: Array<{ request_id: string }>;
    };
    expect(betaRuns.runs.find((row) => row.request_id === requestId)).toBeUndefined();
  });
});
