import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import worker from "./worker";

class FakeBinding {
  readonly requests: Request[] = [];

  constructor(private readonly respond: (request: Request) => Promise<Response>) {}

  fetch = (request: Request): Promise<Response> => {
    this.requests.push(request);
    return this.respond(request);
  };
}

function setup(
  options: {
    api?: FakeBinding;
    apiOrigin?: string;
    assets?: FakeBinding;
  } = {},
) {
  const assets = options.assets ?? new FakeBinding(async () => new Response("asset-ok"));
  const env = {
    ...(options.api ? { API: options.api } : {}),
    ...(options.apiOrigin ? { API_ORIGIN: options.apiOrigin } : {}),
    ASSETS: assets,
    ENVIRONMENT: "test",
    VERSION: "test-version",
  };
  const errors: unknown[] = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    errors.push(JSON.parse(String(line)));
  });
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  return { assets, env, errors };
}

function telemetryRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://frontend.test/__frontend-telemetry", {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      Origin: "https://frontend.test",
      ...headers,
    },
    method: "POST",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("frontend Worker", () => {
  describe("GET /health", () => {
    it("200: returns service health JSON", async () => {
      const { assets, env } = setup();

      const response = await worker.fetch(new Request("https://frontend.test/health"), env);

      expect(response.status).toEqual(200);
      expect(await response.json()).toEqual({ service: "meltiply-frontend", status: "ok" });
      expect(assets.requests).toEqual([]);
    });
  });

  describe("POST /__frontend-telemetry", () => {
    it("204: logs one structured sanitized event without raw exception detail", async () => {
      const { env, errors } = setup();

      const response = await worker.fetch(
        telemetryRequest({
          code: "provider/internal",
          configurationKey: "APP_URL",
          configurationSource: "vite_public_env",
          configurationState: "invalid",
          diagnosticCode: "api_base_url_invalid",
          field: "query-cache",
          kind: "frontend-error",
          message: "raw exception detail",
          retryable: true,
          stack: "Error: raw stack",
          status: 503,
          valueHash: "0123456789abcdef",
          valueType: "Error",
        }),
        env,
      );

      expect(response.status).toEqual(204);
      expect(errors).toEqual([
        {
          context: {
            configuration_key: "APP_URL",
            configuration_source: "vite_public_env",
            configuration_state: "invalid",
            diagnostic_code: "api_base_url_invalid",
            error_code: "provider_internal",
            event: "frontend_client_error",
            field: "query-cache",
            hash: "0123456789abcdef",
            outcome: "error",
            retry_class: "client_retry",
            status: 503,
            type: "Error",
          },
          environment: "test",
          level: "error",
          message: "frontend client error",
          request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          service: "frontend",
          timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          trace_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          version: "test-version",
        },
      ]);
      expect(JSON.stringify(errors)).not.toContain("raw exception detail");
      expect(JSON.stringify(errors)).not.toContain("raw stack");
    });

    it.each([
      [
        "400: unsafe configuration key",
        telemetryRequest({ configurationKey: "better_auth_secret_value", kind: "frontend-error" }),
        400,
      ],
      [
        "405: wrong method",
        new Request("https://frontend.test/__frontend-telemetry", { method: "GET" }),
        405,
      ],
      [
        "403: cross-origin request",
        telemetryRequest({ kind: "frontend-error" }, { Origin: "https://attacker.test" }),
        403,
      ],
      [
        "400: wrong content type",
        new Request("https://frontend.test/__frontend-telemetry", {
          body: "{}",
          headers: { "Content-Type": "text/plain", Origin: "https://frontend.test" },
          method: "POST",
        }),
        400,
      ],
      [
        "413: oversized body",
        telemetryRequest({ kind: "frontend-error", message: "x".repeat(5000) }),
        413,
      ],
      [
        "400: oversized stack",
        telemetryRequest(
          { kind: "frontend-error", stack: "x".repeat(2_000) },
          { Authorization: "Bearer session-jwt" },
        ),
        400,
      ],
    ])("%s", async (_example, request, status) => {
      const api = new FakeBinding(async () => new Response(null, { status: 202 }));
      const { env, errors } = setup({ api });

      const response = await worker.fetch(request, env);

      expect(response.status).toEqual(status);
      expect(errors).toEqual([]);
      expect(api.requests).toEqual([]);
    });

    it("204: relays an authenticated client exception to diagnostics", async () => {
      const api = new FakeBinding(async () => new Response(null, { status: 202 }));
      const { env, errors } = setup({ api });
      const pending: Promise<unknown>[] = [];

      const response = await worker.fetch(
        telemetryRequest(
          {
            field: "react-render",
            kind: "frontend-error",
            stack: "    at Composer (src/components/composer/composer.tsx:42:7)",
            valueType: "TypeError",
          },
          { Authorization: "Bearer session-jwt" },
        ),
        env,
        { waitUntil: (promise) => pending.push(promise) },
      );
      await Promise.all(pending);

      expect(response.status).toEqual(204);
      expect(errors).toHaveLength(1);
      expect(api.requests).toHaveLength(1);
      expect({
        authorization: api.requests[0]!.headers.get("Authorization"),
        body: JSON.parse(await api.requests[0]!.text()),
        pathname: new URL(api.requests[0]!.url).pathname,
      }).toEqual({
        authorization: "Bearer session-jwt",
        body: {
          category: "client_exception",
          error_name: "TypeError",
          error_stack: "    at Composer (src/components/composer/composer.tsx:42:7)",
          operation: "other",
        },
        pathname: "/api/v1/installation/reporting/diagnostics",
      });
    });

    it.each(["constructor", "__proto__"])(
      "204: maps inherited field %s to the fallback operation",
      async (field) => {
        const api = new FakeBinding(async () => new Response(null, { status: 202 }));
        const { env } = setup({ api });
        const pending: Promise<unknown>[] = [];

        await worker.fetch(
          telemetryRequest(
            { field, kind: "frontend-error", valueType: "TypeError" },
            { Authorization: "Bearer session-jwt" },
          ),
          env,
          { waitUntil: (promise) => pending.push(promise) },
        );
        await Promise.all(pending);

        expect(JSON.parse(await api.requests[0]!.text())).toEqual({
          category: "client_exception",
          error_name: "TypeError",
          operation: "other",
        });
      },
    );

    it.each([
      [
        "no bearer token",
        telemetryRequest({ field: "window-error", kind: "frontend-error", valueType: "Error" }),
      ],
      [
        "an api-error kind",
        telemetryRequest(
          { code: "internal_error", kind: "api-error", status: 500 },
          { Authorization: "Bearer session-jwt" },
        ),
      ],
      [
        "a client exception tagged api-error",
        telemetryRequest(
          { field: "api-error", kind: "frontend-error", valueType: "ApiError" },
          { Authorization: "Bearer session-jwt" },
        ),
      ],
    ])("204: relays nothing for %s", async (_example, request) => {
      const api = new FakeBinding(async () => new Response(null, { status: 202 }));
      const { env } = setup({ api });

      const response = await worker.fetch(request, env);

      expect(response.status).toEqual(204);
      expect(api.requests).toEqual([]);
    });

    it("204: tolerates a failing diagnostic relay", async () => {
      const api = new FakeBinding(async () => {
        throw new Error("api unreachable");
      });
      const { env, errors } = setup({ api });
      const pending: Promise<unknown>[] = [];

      const response = await worker.fetch(
        telemetryRequest(
          { field: "window-error", kind: "frontend-error", valueType: "Error" },
          { Authorization: "Bearer session-jwt" },
        ),
        env,
        { waitUntil: (promise) => pending.push(promise) },
      );
      await Promise.all(pending);

      expect(response.status).toEqual(204);
      expect(errors).toHaveLength(1);
    });
  });

  describe("API proxy", () => {
    it("200: forwards /api/v1 requests to the API binding with manual redirect", async () => {
      const api = new FakeBinding(async () => new Response("{}", { status: 200 }));
      const { env } = setup({ api });

      const response = await worker.fetch(
        new Request("https://frontend.test/api/v1/users/me", {
          headers: { Authorization: "Bearer test.jwt.token" },
        }),
        env,
      );

      expect(response.status).toEqual(200);
      expect(api.requests).toHaveLength(1);
      expect({
        authorization: api.requests[0]!.headers.get("Authorization"),
        redirect: api.requests[0]!.redirect,
        url: api.requests[0]!.url,
      }).toEqual({
        authorization: "Bearer test.jwt.token",
        redirect: "manual",
        url: "https://frontend.test/api/v1/users/me",
      });
    });

    it("200: strips Better Auth session cookies from /api/v1 requests while keeping other cookies", async () => {
      const api = new FakeBinding(async () => new Response("{}", { status: 200 }));
      const { env } = setup({ api });

      await worker.fetch(
        new Request("https://frontend.test/api/v1/users/me", {
          headers: {
            Cookie:
              "better-auth.session_token=secret; __Secure-better-auth.session_token=secure; cf_clearance=access; better-auth.session_token_extra=kept",
          },
        }),
        env,
      );

      expect(api.requests[0]!.headers.get("Cookie")).toEqual(
        "cf_clearance=access; better-auth.session_token_extra=kept",
      );
    });

    it("200: drops the Cookie header when only Better Auth session cookies are present on /api/v1", async () => {
      const api = new FakeBinding(async () => new Response("{}", { status: 200 }));
      const { env } = setup({ api });

      await worker.fetch(
        new Request("https://frontend.test/api/v1/users/me", {
          headers: { Cookie: "better-auth.session_token=secret" },
        }),
        env,
      );

      expect(api.requests[0]!.headers.get("Cookie")).toEqual(null);
    });

    it("200: forwards cookies unchanged for /api/auth onto API_ORIGIN, preferring it over API binding", async () => {
      const upstream: Request[] = [];
      vi.stubGlobal("fetch", async (request: Request) => {
        upstream.push(request);
        return new Response("{}", { status: 200 });
      });
      const api = new FakeBinding(async () => new Response("{}", { status: 200 }));
      const { env } = setup({ api, apiOrigin: "http://127.0.0.1:8787" });

      const response = await worker.fetch(
        new Request("https://frontend.test/api/auth/get-session?x=1", {
          headers: { Cookie: "better-auth.session_token=secret" },
        }),
        env,
      );

      expect(response.status).toEqual(200);
      expect(api.requests).toEqual([]);
      expect({
        cookie: upstream[0]!.headers.get("Cookie"),
        url: upstream[0]!.url,
      }).toEqual({
        cookie: "better-auth.session_token=secret",
        url: "http://127.0.0.1:8787/api/auth/get-session?x=1",
      });
    });

    it("502: logs a safe event when the API upstream fails", async () => {
      const api = new FakeBinding(async () => {
        throw new Error("binding exploded");
      });
      const { env, errors } = setup({ api });

      const response = await worker.fetch(new Request("https://frontend.test/api/v1/plan"), env);

      expect(response.status).toEqual(502);
      expect(await response.text()).toEqual("The API is unavailable.");
      expect(errors).toEqual([
        {
          context: {
            error_code: "api_proxy_failed",
            event: "frontend_api_proxy",
            outcome: "error",
            retry_class: "client_retry",
          },
          environment: "test",
          level: "error",
          message: "frontend api proxy",
          request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          service: "frontend",
          timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          trace_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          version: "test-version",
        },
      ]);
      expect(JSON.stringify(errors)).not.toContain("binding exploded");
    });

    it("200: routes non-API paths like /apiary to ASSETS", async () => {
      const api = new FakeBinding(async () => new Response("{}", { status: 200 }));
      const { assets, env } = setup({ api });

      const response = await worker.fetch(new Request("https://frontend.test/apiary"), env);

      expect(response.status).toEqual(200);
      expect(api.requests).toEqual([]);
      expect(assets.requests).toHaveLength(1);
    });
  });

  describe("asset fallback", () => {
    it("500: returns generic copy and logs one safe event when assets fail", async () => {
      const assets = new FakeBinding(async () => {
        throw new Error("private asset failure");
      });
      const { env, errors } = setup({ assets });

      const response = await worker.fetch(new Request("https://frontend.test/assets/app.js"), env);

      expect(response.status).toEqual(500);
      expect(await response.text()).toEqual("An error has occurred.");
      expect(errors).toEqual([
        {
          context: {
            error_code: "asset_fetch_failed",
            event: "frontend_asset_fetch",
            outcome: "error",
            retry_class: "none",
          },
          environment: "test",
          level: "error",
          message: "frontend asset fetch",
          request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          service: "frontend",
          timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          trace_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          version: "test-version",
        },
      ]);
      expect(JSON.stringify(errors)).not.toContain("private asset failure");
    });
  });
});
