import { CONTRACT_VERSION } from "@meltiply/contracts";
import { createExecutionContext } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ApiWorkerEnv, AutomationRelayStub, OAuthStateStub } from "../src/env";
import { createApiApp, responseErrorCode } from "../src/app";
import worker from "../src/index";
import { logRecords } from "./log-records";

afterEach(() => {
  vi.restoreAllMocks();
});

vi.mock("../src/database", () => ({
  authenticatedPoolFor: vi.fn(),
  systemPoolFor: vi.fn(),
}));

const stagingEnv = {
  ALLOWED_ORIGINS: "https://staging.example.com",
  APP_URL: "https://staging.example.com",
  ASSETS: {} as R2Bucket,
  AUTH_SETUP_SECRET: "staging-bootstrap-placeholder-not-a-real-secret",
  AUTOMATION: {} as AutomationRelayStub,
  BETTER_AUTH_SECRET: "staging-auth-secret-32-chars-minimum",
  DB_AUTHENTICATED: {} as Hyperdrive,
  DB_SYSTEM: {} as Hyperdrive,
  ENVIRONMENT: "staging",
  MAIL: { send: vi.fn(async () => ({ messageId: "test-message" })) },
  MAIL_FROM_ADDRESS: "no-reply@staging.example.com",
  MAIL_FROM_NAME: "Meltiply Staging",
  OAUTH_STATE: {} as DurableObjectNamespace<OAuthStateStub>,
  R2_ACCESS_KEY_ID: "r2-access-key",
  R2_ACCOUNT_ID: "r2-account",
  R2_BUCKET_NAME: "assets",
  R2_SECRET_ACCESS_KEY: "r2-secret",
  TOKEN_ENCRYPTION_KEY: "token-key",
  VERSION: "test",
} satisfies ApiWorkerEnv;

describe("API Worker runtime entrypoint", () => {
  it("serves contract-conformant liveness without checking dependencies", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await exports.default.fetch(
      new Request("http://example.test/api/v1/health", {
        headers: {
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          "X-Request-ID": "request-health-1",
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-ID")).toBe("request-health-1");
    await expect(response.json()).resolves.toEqual({
      contract_version: CONTRACT_VERSION,
      environment: "local",
      status: "ok",
      version: "1.0.0-target.0",
    });
    expect(logRecords(info)).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          event: "http_request",
          latency_ms: expect.any(Number),
          outcome: 200,
          retry_class: "none",
          route: "/api/v1/health",
        }),
        environment: "local",
        request_id: "request-health-1",
        service: "api",
        trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      }),
    );
  });

  it.each(["staging", "production"] as const)(
    "logs invalid %s configuration and returns only a generic response",
    async (ENVIRONMENT) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const response = await worker.fetch(
        new Request("https://api.example.test/api/v1/health", {
          headers: { "X-Request-ID": "request-config-1" },
        }) as Parameters<NonNullable<typeof worker.fetch>>[0],
        {
          ...stagingEnv,
          BETTER_AUTH_SECRET: undefined,
          ENVIRONMENT,
        },
        createExecutionContext(),
      );

      expect(response.status).toBe(500);
      await expect(response.text()).resolves.toBe("An error has occurred.");
      expect(logRecords(error)).toContainEqual(
        expect.objectContaining({
          context: expect.objectContaining({
            error_code: "configuration_invalid",
            event: "worker_configuration_failed",
            unavailable_bindings: ["BETTER_AUTH_SECRET"],
          }),
          error: expect.objectContaining({
            fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
            name: "Error",
          }),
          request_id: "request-config-1",
        }),
      );
    },
  );

  it("fails readiness when required bindings are absent", async () => {
    const response = await exports.default.fetch("http://example.test/api/v1/ready");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      components: expect.arrayContaining([{ name: "DB_SYSTEM", status: "unavailable" }]),
      status: "unavailable",
    });
  });

  it("rejects unapproved browser origins", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await exports.default.fetch("http://example.test/api/v1/health", {
      headers: {
        Origin: "https://attacker.example",
        "X-Request-ID": "request-origin-1",
      },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(logRecords(info)).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          error_code: "invalid_request",
          event: "http_request",
          outcome: 403,
          retry_class: "none",
        }),
        request_id: "request-origin-1",
        trace_id: "request-origin-1",
      }),
    );
  });

  it("reads at most the 8 KiB probe cap when Content-Length is absent", async () => {
    const oversized = Response.json(
      {
        error: { code: "internal_error", message: "x".repeat(16 * 1024) },
      },
      { status: 500 },
    );
    expect(oversized.headers.get("Content-Length")).toBeNull();
    await expect(responseErrorCode(oversized)).resolves.toBeUndefined();

    const small = Response.json({ error: { code: "internal_error" } }, { status: 500 });
    await expect(responseErrorCode(small)).resolves.toBe("internal_error");
  });

  it("reads a small error code without parsing bodies past the probe limit", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const app = createApiApp();
    const jsonError = (code: string, padding: number) =>
      new Response(JSON.stringify({ error: { code, padding: "x".repeat(padding) } }), {
        headers: { "Content-Type": "application/json" },
        status: 400,
      });
    app.get("/small-error", () => jsonError("small_error", 0));
    app.get("/oversized-error", () => jsonError("oversized_error", 9 * 1024));

    const env = {
      APP_URL: "https://app.example.test",
      ENVIRONMENT: "test",
      VERSION: "test",
    } satisfies ApiWorkerEnv;
    await app.request("/small-error", {}, env);
    const oversized = await app.request("/oversized-error", {}, env);

    await expect(oversized.json()).resolves.toMatchObject({ error: { code: "oversized_error" } });
    const requests = logRecords(info)
      .map((record) => record.context as Record<string, unknown>)
      .filter((context) => context.event === "http_request");
    expect(requests.map((context) => context.error_code)).toEqual(["small_error", undefined]);
  });
});
