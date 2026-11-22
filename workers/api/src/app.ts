import {
  type AccessClaims,
  type BetterAuthInstance,
  bearerToken,
  type JwtIdentity,
  type SessionClaims,
} from "@meltiply/auth";
import { CONTRACT_VERSION } from "@meltiply/contracts";
import type { components } from "@meltiply/contracts/schema";
import {
  createRequestId,
  createTraceId,
  errorDiagnostic,
  elapsedMilliseconds,
  exportOtlpSpan,
  log,
} from "@meltiply/observability";
import { Hono, type Context } from "hono";
import { matchedRoutes } from "hono/route";
import { bodyLimit } from "hono/body-limit";

import { resolveActor, type ResolvedActor } from "./actor-resolution";
import { enforceWorkspaceCapabilities } from "./authorization";
import { activeIdentity } from "./auth-policy";
import { betterAuthFor, checkAuthRateLimit, type AuthRateLimitResult } from "./better-auth";
import {
  providerMediaRoutePrefix,
  registerCoreRoutes,
  type CoreRouteDependencies,
} from "./core-routes";
import { CoreApiError } from "./core-types";
import { lazyAuthenticatedPoolFor, lazySystemPoolFor } from "./database-module";
import {
  bindingStatuses,
  type ApiWorkerEnv,
  type ApiWorkerEnvironment,
  type BindingStatus,
} from "./env";
import { accessVerifierFor, allowedOriginsFor, jwtVerifierFor } from "./verifier-cache";
import {
  flowDatabaseAvailable,
  flowExplorerEnabled,
  flowRecorderFor,
  registerFlowRoutes,
} from "./flow-observability";
import { registerInstallationRoutes } from "./installation-routes";
import { registerOnboardingRoutes } from "./onboarding";
import { registerReportingRoutes } from "./reporting-routes";
import type { ReportingDependencies } from "./reporting-layer";
import { registerOperatorRoutes, type OperatorRouteDependencies } from "./operator-routes";
import { scheduleEagerOutboxRelay } from "./outbox-relay";
import { Effect, type Layer } from "effect";

import { CurrentUserService, createCurrentUserServiceLive } from "./effect/services/current-user";
import { runWorkerEffect } from "./effect/runtime";
import { errorResponse, jsonResponse } from "./responses";

const invitationPathPattern = /^\/api\/v1\/workspace-invitations\/[^/]+$/;
const oauthCallbackPathPattern = /^\/api\/v1\/platforms\/[^/]+\/callback$/;

type UserProfile = components["schemas"]["UserProfile"];

export interface ApiDependencies extends CoreRouteDependencies, OperatorRouteDependencies {
  authRateLimiter?: (
    env: ApiWorkerEnv,
    action: string,
    request: Request,
  ) => Promise<AuthRateLimitResult>;
  betterAuth?: BetterAuthInstance | ((env: ApiWorkerEnv) => BetterAuthInstance);
  currentUserServiceLayer?: Layer.Layer<CurrentUserService, never, never>;
  reportingServiceLayer?: ReportingDependencies["reportingServiceLayer"];
  loadCurrentUser?: (env: ApiWorkerEnv, claims: SessionClaims) => Promise<UserProfile | null>;
  resolveActor?: (
    env: ApiWorkerEnv,
    identity: JwtIdentity,
    request: Request,
    requestId: string,
  ) => Promise<ResolvedActor>;
  verifyJwtToken?: (env: ApiWorkerEnv, token: string) => Promise<JwtIdentity>;
  verifyAccessToken?: (env: ApiWorkerEnv, token: string) => Promise<AccessClaims>;
  probeDatabase?: (env: ApiWorkerEnv, component: "DB_SYSTEM" | "DB_AUTHENTICATED") => Promise<void>;
}

const errorBodyProbeBytes = 8 * 1024;

function observabilityRoute(c: Parameters<typeof matchedRoutes>[0]): string {
  const routes = matchedRoutes(c);
  for (let index = routes.length - 1; index >= 0; index -= 1) {
    const route = routes[index]?.path;
    if (route && !route.endsWith("*")) return route;
  }
  return "/unmatched";
}

export async function responseErrorCode(response: Response): Promise<string | undefined> {
  if (
    response.status < 400 ||
    !response.headers.get("Content-Type")?.includes("application/json")
  ) {
    return undefined;
  }
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (
    Number.isSafeInteger(declaredLength) &&
    (declaredLength < 0 || declaredLength > errorBodyProbeBytes)
  ) {
    return undefined;
  }
  try {
    const stream = response.clone().body;
    if (!stream) return undefined;
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let buffered = 0;
    let oversized = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        buffered += value.byteLength;
        if (buffered > errorBodyProbeBytes) {
          oversized = true;
          break;
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (oversized) return undefined;
    const bytes = new Uint8Array(buffered);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== "object" || !("error" in body)) {
      return undefined;
    }
    const error = body.error;
    if (!error || typeof error !== "object" || !("code" in error)) {
      return undefined;
    }
    return typeof error.code === "string" ? error.code : undefined;
  } catch {
    return undefined;
  }
}

async function probeHyperdrive(
  env: ApiWorkerEnv,
  component: "DB_SYSTEM" | "DB_AUTHENTICATED",
): Promise<void> {
  const pool =
    component === "DB_SYSTEM" ? await lazySystemPoolFor(env) : await lazyAuthenticatedPoolFor(env);

  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    client.release();
  } catch (cause) {
    client.release(true);
    throw cause;
  }
}

function hasConnectionString(binding: Hyperdrive | undefined): boolean {
  return Boolean(typeof binding?.connectionString === "string" && binding.connectionString.trim());
}

function readinessCacheKey(env: ApiWorkerEnv): string {
  return [
    env.ENVIRONMENT,
    env.DB_SYSTEM?.connectionString ?? "",
    env.DB_AUTHENTICATED?.connectionString ?? "",
  ].join("\u0000");
}

const readinessCacheTtlMilliseconds = 30_000;

function requestAuthFields(c: Context<ApiWorkerEnvironment>) {
  const identity = c.get("identity");
  const actor = c.get("actor");
  return {
    client_channel: identity?.clientChannel ?? "unknown",
    auth_method: identity ? "session_jwt" : "unknown",
    ...(identity?.sessionId ? { credential_id: identity.sessionId } : {}),
    ...(actor ? { actor_id: actor.userId } : {}),
  };
}

function authRateLimitAction(path: string): string {
  if (path === "/api/auth/device/code") return "device-code";
  if (path === "/api/auth/device/token") return "device-token";
  if (path === "/api/auth/device") return "device-verify";
  if (path === "/api/auth/device/approve" || path === "/api/auth/device/deny") {
    return "device-approval";
  }
  if (path.startsWith("/api/auth/sign-in/")) return "sign-in";
  if (path.startsWith("/api/auth/two-factor/")) return "two-factor";
  if (path === "/api/auth/change-password") return "change-password";
  if (path.startsWith("/api/auth/sign-up/")) return "sign-up";
  if (path.startsWith("/api/auth/request-password-reset")) {
    return "request-password-reset";
  }
  if (path.startsWith("/api/auth/reset-password")) return "reset-password";
  if (path.startsWith("/api/auth/send-verification-email")) {
    return "send-verification-email";
  }
  return "generic";
}

function authRateLimitAvailable(env: ApiWorkerEnv): boolean {
  const binding = env.DB_SYSTEM as { connectionString?: string } | undefined;
  return Boolean(binding?.connectionString);
}

export function createApiApp(dependencies: ApiDependencies = {}) {
  const app = new Hono<ApiWorkerEnvironment>();
  let readinessCache: { components: BindingStatus[]; expiresAt: number; key: string } | undefined;
  const resolveBetterAuth = async (env: ApiWorkerEnv): Promise<BetterAuthInstance> => {
    const configured = dependencies.betterAuth;
    if (!configured) return betterAuthFor(env);
    return typeof configured === "function" ? configured(env) : configured;
  };
  const verifyJwtToken =
    dependencies.verifyJwtToken ??
    (async (env: ApiWorkerEnv, token: string) => {
      let identity: JwtIdentity;
      try {
        identity = await jwtVerifierFor(env)(token);
      } catch {
        throw new CoreApiError(401, "authentication_required", "Authentication is required.");
      }
      return activeIdentity(env, identity);
    });
  const resolveRequestActor = dependencies.resolveActor ?? resolveActor;
  const authRateLimiter = dependencies.authRateLimiter ?? checkAuthRateLimit;
  const verifyAccessToken =
    dependencies.verifyAccessToken ??
    ((env: ApiWorkerEnv, token: string) => accessVerifierFor(env)(token));
  app.use("*", async (c, next) => {
    const startedAt = performance.now();
    const requestId = createRequestId(c.req.header("X-Request-ID"));
    const traceId = createTraceId(c.req.header("traceparent"), requestId);
    c.set("requestId", requestId);
    c.set("traceId", traceId);
    await next();
    c.header("X-Request-ID", requestId);
    const route = observabilityRoute(c);
    const errorCode = await responseErrorCode(c.res);
    log(
      "info",
      {
        environment: c.env.ENVIRONMENT,
        request_id: requestId,
        route,
        service: "api",
        trace_id: traceId,
        version: c.env.VERSION,
      },
      {
        ...requestAuthFields(c),
        ...(errorCode ? { error_code: errorCode } : {}),
        event: "http_request",
        latency_ms: elapsedMilliseconds(startedAt),
        method: c.req.method,
        outcome: c.res.status,
        ...(route === "/unmatched" ? { path: c.req.path } : {}),
        retry_class: c.res.status === 429 || c.res.status >= 500 ? "client_retry" : "none",
      },
    );
    const spanExport = exportOtlpSpan(
      { ENVIRONMENT: c.env.ENVIRONMENT },
      {
        attributes: {
          "http.method": c.req.method,
          "http.route": route,
          "http.status_code": c.res.status,
          ...(errorCode ? { error_code: errorCode } : {}),
          request_id: requestId,
        },
        endTimeMs: Date.now(),
        name: `${c.req.method} ${route}`,
        service: "api",
        spanId: requestId,
        startTimeMs: Date.now() - Math.max(0, elapsedMilliseconds(startedAt)),
        status: c.res.status >= 500 ? "error" : "ok",
        traceId,
      },
    );
    try {
      c.executionCtx.waitUntil(spanExport);
    } catch {
      void spanExport;
    }
  });
  const corsMiddlewareFor = (allowCredentials: boolean) => {
    const exposedHeaders = allowCredentials
      ? "X-Request-ID, ETag, Retry-After, Idempotency-Replayed, Set-Auth-JWT, Set-Auth-Token"
      : "X-Request-ID, ETag, Retry-After, Idempotency-Replayed";
    return async (c: Context<ApiWorkerEnvironment>, next: () => Promise<void>) => {
      const origin = c.req.header("Origin");
      if (origin && !allowedOriginsFor(c.env).has(origin)) {
        return errorResponse(
          c.get("requestId"),
          403,
          "invalid_request",
          "The origin is not allowed.",
        );
      }

      const applyCorsHeaders = () => {
        if (!origin) return;
        c.header("Access-Control-Allow-Origin", origin);
        if (allowCredentials) {
          c.header("Access-Control-Allow-Credentials", "true");
        }
        c.header("Vary", "Origin");
        c.header("Access-Control-Expose-Headers", exposedHeaders);
      };

      if (c.req.method === "OPTIONS") {
        applyCorsHeaders();
        c.header(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type, X-Request-ID, X-Workspace-ID, X-Setup-Secret, X-Invitation-Token, Idempotency-Key, If-None-Match",
        );
        c.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        c.header("Access-Control-Max-Age", "600");
        return c.body(null, 204);
      }
      await next();
      applyCorsHeaders();
    };
  };
  app.use("/api/v1/*", corsMiddlewareFor(false));
  app.use("/api/auth/*", corsMiddlewareFor(true));
  app.use("/api/auth/*", bodyLimit({ maxSize: 16 * 1024 }));

  app.use("/operator/v1/*", async (c, next) => {
    const expectedHost = c.env.OPERATOR_HOSTNAME?.trim().toLowerCase();
    const requestHost = new URL(c.req.url).hostname.toLowerCase();
    const token = c.req.header("Cf-Access-Jwt-Assertion");
    if (!expectedHost || requestHost !== expectedHost || !token) {
      return errorResponse(
        c.get("requestId"),
        403,
        "operator_authentication_required",
        "Cloudflare Access operator authentication is required.",
      );
    }
    try {
      c.set("operator", await verifyAccessToken(c.env, token));
      await next();
    } catch {
      return errorResponse(
        c.get("requestId"),
        403,
        "operator_authentication_required",
        "Cloudflare Access operator authentication is required.",
      );
    }
  });

  app.all("/api/auth/*", async (c) => {
    if (authRateLimitAvailable(c.env)) {
      const action = authRateLimitAction(c.req.path);
      const result = await authRateLimiter(c.env, action, c.req.raw);
      if (result.status === "limited") {
        const retryAfter =
          result.retryAfterSeconds !== undefined
            ? { "Retry-After": String(result.retryAfterSeconds) }
            : undefined;
        if (action === "device-token") {
          // RFC 8628 section 3.5 requires a top-level slow_down error on device token polling.
          const headers: Record<string, string> = {
            "Cache-Control": "no-store",
            Pragma: "no-cache",
          };
          if (retryAfter) headers["Retry-After"] = retryAfter["Retry-After"];
          return Response.json(
            {
              error: "slow_down",
              error_description: "Polling too frequently. Wait before retrying.",
            },
            { headers, status: 400 },
          );
        }
        return errorResponse(
          c.get("requestId"),
          429,
          "rate_limited",
          "Too many authentication attempts. Retry later.",
          [],
          retryAfter,
        );
      }
    }
    const auth = await resolveBetterAuth(c.env);
    return auth.handler(c.req.raw);
  });

  app.use("/api/v1/workspace-invitations/*", async (c, next) => {
    if (
      c.req.method === "POST" &&
      c.req.path.endsWith("/accept") &&
      authRateLimitAvailable(c.env)
    ) {
      const result = await authRateLimiter(c.env, "invitation-accept", c.req.raw);
      if (result.status === "limited") {
        return errorResponse(
          c.get("requestId"),
          429,
          "rate_limited",
          "Too many invitation attempts. Retry later.",
          [],
          result.retryAfterSeconds !== undefined
            ? { "Retry-After": String(result.retryAfterSeconds) }
            : undefined,
        );
      }
    }
    await next();
  });

  app.use("/api/v1/*", async (c, next) => {
    const publicPath =
      c.req.path === "/api/v1/health" ||
      c.req.path === "/api/v1/ready" ||
      (c.req.method === "GET" && invitationPathPattern.test(c.req.path)) ||
      c.req.path.startsWith(providerMediaRoutePrefix) ||
      oauthCallbackPathPattern.test(c.req.path);
    if (publicPath || c.req.method === "OPTIONS") {
      await next();
      return;
    }
    const token = bearerToken(c.req.header("Authorization"));
    if (!token) {
      return errorResponse(
        c.get("requestId"),
        401,
        "authentication_required",
        "Authentication is required.",
      );
    }
    try {
      const identity = await verifyJwtToken(c.env, token);
      c.set("identity", identity);
      c.set("actor", await resolveRequestActor(c.env, identity, c.req.raw, c.get("requestId")));
    } catch (cause) {
      if (cause instanceof CoreApiError && cause.status < 500) {
        return errorResponse(c.get("requestId"), cause.status, cause.code, cause.message);
      }
      throw cause;
    }
    await next();
  });

  app.use("/api/v1/*", enforceWorkspaceCapabilities);

  app.get("/api/v1/health", (c) =>
    jsonResponse(
      {
        contract_version: CONTRACT_VERSION,
        environment: c.env.ENVIRONMENT,
        status: "ok",
        version: c.env.VERSION,
      },
      200,
      c.get("requestId"),
    ),
  );

  app.get("/api/v1/ready", async (c) => {
    const cacheKey = readinessCacheKey(c.env);
    const components = bindingStatuses(c.env);
    if (
      readinessCache &&
      readinessCache.key === cacheKey &&
      readinessCache.expiresAt > Date.now() &&
      components.every((component) => component.status === "ready")
    ) {
      return jsonResponse(
        { components: readinessCache.components, status: "ready" },
        200,
        c.get("requestId"),
      );
    }
    const probeDatabase = dependencies.probeDatabase ?? probeHyperdrive;
    await Promise.all(
      components.map(async (component) => {
        if (
          (component.name !== "DB_SYSTEM" && component.name !== "DB_AUTHENTICATED") ||
          component.status !== "ready"
        ) {
          return;
        }
        const binding = c.env[component.name];
        if (!hasConnectionString(binding)) return;
        try {
          await probeDatabase(c.env, component.name);
        } catch (cause) {
          component.status = "unavailable";
          log(
            "error",
            {
              environment: c.env.ENVIRONMENT,
              request_id: c.get("requestId"),
              route: "/api/v1/ready",
              service: "api",
              trace_id: c.get("traceId"),
              version: c.env.VERSION,
            },
            {
              component: component.name,
              error_code: "dependency_probe_failed",
              event: "dependency_probe_failed",
              ...errorDiagnostic(cause),
              outcome: "unavailable",
              retry_class: "platform_retry",
            },
          );
        }
      }),
    );
    const ready = components.every((component) => component.status === "ready");
    if (ready) {
      readinessCache = {
        components: components.map(({ name, status }) => ({ name, status })),
        expiresAt: Date.now() + readinessCacheTtlMilliseconds,
        key: cacheKey,
      };
    } else {
      readinessCache = undefined;
    }
    return jsonResponse(
      { components, status: ready ? "ready" : "unavailable" },
      ready ? 200 : 503,
      c.get("requestId"),
    );
  });

  let flowObserveChain: Promise<void> = Promise.resolve();
  app.use("/api/v1/*", async (c, next) => {
    if (
      c.req.path === "/api/v1/health" ||
      c.req.path === "/api/v1/ready" ||
      c.req.path.startsWith(providerMediaRoutePrefix)
    ) {
      await next();
      return;
    }
    if (!flowExplorerEnabled(c.env) || !flowDatabaseAvailable(c.env)) {
      await next();
      return;
    }
    const recorder = flowRecorderFor(c.env);
    const actor = c.get("actor");
    const orgId = actor?.workspace.id;
    const requestId = c.get("requestId");
    const traceId = c.get("traceId");
    try {
      await next();
    } finally {
      const status = c.res.status;
      const outcome =
        status >= 500
          ? {
              errorCode: "internal_error",
              retryable: true,
              status: "failed" as const,
            }
          : status >= 400
            ? {
                errorCode: "client_error",
                retryable: false,
                status: "failed" as const,
              }
            : { status: "succeeded" as const };
      const route = observabilityRoute(c);
      const observe = () =>
        (async () => {
          const runId = await recorder.startRun({
            entrypoint: route,
            metadata: {
              http_method: c.req.method,
              route,
            },
            orgId,
            requestId,
            traceId,
          });
          if (!runId) return;
          const authStepId = orgId
            ? await recorder.recordStep({
                nodeKey: "auth",
                operation: "verify_session",
                orgId,
                requestId,
                runId,
                service: "api",
                traceId,
              })
            : null;
          const coreStepId = await recorder.recordStep({
            nodeKey: "core",
            operation: `${c.req.method} ${route}`,
            orgId,
            requestId,
            runId,
            service: "api",
            traceId,
          });
          if (authStepId) await recorder.finishStep(authStepId, outcome);
          if (coreStepId) await recorder.finishStep(coreStepId, outcome);
          await recorder.finishRun(runId, outcome);
        })();
      flowObserveChain = flowObserveChain.then(observe, observe);
      if (c.env.ENVIRONMENT === "test") {
        await flowObserveChain;
      } else {
        try {
          c.executionCtx.waitUntil(flowObserveChain);
        } catch {
          void flowObserveChain;
        }
      }
    }
  });

  app.use("/api/v1/*", async (c, next) => {
    await next();
    scheduleEagerOutboxRelay(c);
  });
  app.use("/operator/v1/*", async (c, next) => {
    await next();
    scheduleEagerOutboxRelay(c);
  });
  app.get("/api/v1/users/me", async (c) => {
    const actor = c.get("actor");
    const layer =
      dependencies.currentUserServiceLayer ??
      createCurrentUserServiceLive(c.env, actor.claims, dependencies.loadCurrentUser);

    const program = Effect.gen(function* () {
      const service = yield* CurrentUserService;
      return yield* service.getCurrentUser();
    }).pipe(
      Effect.provide(layer),
      Effect.withSpan("users.me.get", {
        attributes: {
          "organization.id": actor.workspace.id,
          "user.id": actor.userId,
        },
      }),
    );

    return runWorkerEffect(c, program);
  });

  registerCoreRoutes(app, dependencies);
  registerInstallationRoutes(app);
  registerOnboardingRoutes(app);
  registerReportingRoutes(app, {
    reportingServiceLayer: dependencies.reportingServiceLayer,
  });
  registerOperatorRoutes(app, dependencies);
  registerFlowRoutes(app);

  app.notFound((c) =>
    errorResponse(c.get("requestId"), 404, "not_found", "The route was not found."),
  );

  app.onError((cause, c) => {
    log(
      "error",
      {
        environment: c.env?.ENVIRONMENT ?? "test",
        request_id: c.get("requestId"),
        route: observabilityRoute(c),
        service: "api",
        trace_id: c.get("traceId"),
        version: c.env?.VERSION ?? "test",
      },
      {
        ...requestAuthFields(c),
        error_code: "internal_error",
        event: "request_failed",
        outcome: "internal_error",
        retry_class: "client_retry",
        ...errorDiagnostic(cause),
      },
    );
    return errorResponse(
      c.get("requestId"),
      500,
      "internal_error",
      "An unexpected error occurred.",
    );
  });

  return app;
}
