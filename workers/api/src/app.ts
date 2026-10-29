import {
  type AccessClaims,
  type BetterAuthInstance,
  bearerToken,
  type JwtIdentity,
  type SessionClaims,
} from "@meltiply/auth";
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
import { checkAuthRateLimit, type AuthRateLimitResult } from "./better-auth";
import {
  providerMediaRoutePrefix,
  registerCoreRoutes,
  type CoreRouteDependencies,
} from "./core-routes";
import { CoreApiError } from "./core-types";
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
import { registerOperatorRoutes, type OperatorRouteDependencies } from "./operator-routes";
import { scheduleEagerOutboxRelay } from "./outbox-relay";
import { Effect, type Layer } from "effect";

import { CurrentUserService, createCurrentUserServiceLive } from "./effect/services/current-user";
import { runWorkerEffect } from "./effect/runtime";
import { errorResponse, jsonResponse } from "./responses";

type UserProfile = components["schemas"]["UserProfile"];

export interface ApiDependencies extends CoreRouteDependencies, OperatorRouteDependencies {
  authRateLimiter?: (
    env: ApiWorkerEnv,
    action: string,
    request: Request,
  ) => Promise<AuthRateLimitResult>;
  betterAuth?: BetterAuthInstance | ((env: ApiWorkerEnv) => BetterAuthInstance);
  currentUserServiceLayer?: Layer.Layer<CurrentUserService, never, never>;
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

/**
 * Resolves the lowest non-wildcard matched route template path for logging and tracing metrics.
 *
 * Inspects Hono matched routes backwards, skipping catch-all asterisk suffixes.
 * Returns `"/unmatched"` if no concrete route pattern matches.
 *
 * @param c - Hono request context.
 * @returns Parameterized route template path (e.g. `"/api/v1/assets/:assetId"`).
 */
function observabilityRoute(c: Parameters<typeof matchedRoutes>[0]): string {
  const routes = matchedRoutes(c);
  for (let index = routes.length - 1; index >= 0; index -= 1) {
    const route = routes[index]?.path;
    if (route && !route.endsWith("*")) return route;
  }
  return "/unmatched";
}

/**
 * Safely extracts machine-readable error codes from JSON error responses without buffering large payloads.
 *
 * Probes responses with status >= 400 and Content-Type JSON, capping inspection to 8KB
 * to avoid excessive memory allocation on error paths.
 *
 * @param response - Candidate outgoing HTTP response object.
 * @returns Parsed `error.code` string, or `undefined` if absent, unparsable, or too large.
 */
async function responseErrorCode(response: Response): Promise<string | undefined> {
  if (
    response.status < 400 ||
    !response.headers.get("Content-Type")?.includes("application/json")
  ) {
    return undefined;
  }
  // Only probe bodies small enough to read without buffering the whole
  // response on the error path (AUD-041).
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (
    Number.isSafeInteger(declaredLength) &&
    (declaredLength < 0 || declaredLength > errorBodyProbeBytes)
  ) {
    return undefined;
  }
  try {
    const body: unknown = await response.clone().json();
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

/**
 * Executes a health check query against the specified Hyperdrive database pool.
 *
 * Connects to the pool, runs a lightweight `SELECT 1` query, and cleanly releases
 * the client. Forces connection destruction if query execution fails.
 *
 * @param env - Worker environment containing database configuration.
 * @param component - Target database pool identifier (`"DB_SYSTEM"` or `"DB_AUTHENTICATED"`).
 * @returns Resolves if connection and query succeed.
 * @throws Any database connection or execution error.
 */
async function probeHyperdrive(
  env: ApiWorkerEnv,
  component: "DB_SYSTEM" | "DB_AUTHENTICATED",
): Promise<void> {
  const database = await import("./database");
  const pool =
    component === "DB_SYSTEM" ? database.systemPoolFor(env) : database.authenticatedPoolFor(env);

  const client = await pool.connect();
  try {
    // client.query always resolves to a truthy QueryResult on success, so a
    // success path releases normally and only the catch force-destroys.
    await client.query("SELECT 1");
    client.release();
  } catch (cause) {
    client.release(true);
    throw cause;
  }
}

/**
 * Verifies whether a Hyperdrive binding contains a non-empty PostgreSQL connection string.
 *
 * Guards against empty mock objects passed in test environments.
 *
 * @param binding - Candidate Cloudflare Hyperdrive binding.
 * @returns `true` if a non-empty connection string exists; otherwise `false`.
 */
function hasConnectionString(binding: Hyperdrive | undefined): boolean {
  return Boolean(typeof binding?.connectionString === "string" && binding.connectionString.trim());
}

/**
 * Generates a null-delimited cache key fingerprint from the environment and database connection strings.
 *
 * Used to cache health check probe results across requests within a 30-second window.
 *
 * @param env - Worker environment bindings.
 * @returns Composite cache key string.
 */
function readinessCacheKey(env: ApiWorkerEnv): string {
  return [
    env.ENVIRONMENT,
    env.DB_SYSTEM?.connectionString ?? "",
    env.DB_AUTHENTICATED?.connectionString ?? "",
  ].join("\u0000");
}

const readinessCacheTtlMilliseconds = 30_000;

/**
 * Projects only authenticated credential provenance into request logs. Missing
 * or rejected credentials remain unknown, including public and auth-lifecycle
 * requests. Actor IDs use the internal member ID; credential IDs use the
 * non-secret session row ID, never bearer tokens, cookies, or request headers.
 */
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

/**
 * Maps a Better Auth route path to its rate-limit action key.
 *
 * Credential-bearing endpoints get dedicated budgets; every other auth endpoint
 * shares the generic per-IP budget.
 *
 * @param path - Request path under `/api/auth/`.
 * @returns Action key consumed by `checkAuthRateLimit`.
 */
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

/**
 * True when the system database backing the auth rate limiter is configured.
 * Test environments without a Hyperdrive connection string skip distributed
 * limiting rather than failing every auth request.
 *
 * @param env - Worker environment bindings.
 * @returns Whether the auth_rate_limits store is reachable.
 */
function authRateLimitAvailable(env: ApiWorkerEnv): boolean {
  const binding = env.DB_SYSTEM as { connectionString?: string } | undefined;
  return Boolean(binding?.connectionString);
}

/**
 * Creates and configures the central Hono API Worker application with middleware and routes.
 *
 * Assembles request ID/traceparent propagation, OTLP tracing, structured HTTP logging,
 * split CORS (credentialed for `/api/auth/*`, bearer-only for `/api/v1/*`), health
 * checks, Better Auth JWT bearer verification into the `actor` context, tenant RLS
 * scoping, flow observability, eager outbox relays, and mounts core, operator, and
 * flow sub-routers. Request and failure logs include server-resolved credential
 * provenance and non-secret actor/session identifiers after tenant authentication.
 *
 * @param dependencies - Optional dependency overrides for testing (auth resolution, service stubs).
 * @returns Configured Hono application instance ready to handle HTTP fetch events.
 */
export function createApiApp(dependencies: ApiDependencies = {}) {
  const app = new Hono<ApiWorkerEnvironment>();
  let readinessCache: { components: BindingStatus[]; expiresAt: number; key: string } | undefined;
  const resolveBetterAuth = async (env: ApiWorkerEnv): Promise<BetterAuthInstance> => {
    if (dependencies.betterAuth) {
      return typeof dependencies.betterAuth === "function"
        ? dependencies.betterAuth(env)
        : dependencies.betterAuth;
    }
    // Exception: dynamic import avoids loading pg in workerd unit test isolates
    const { betterAuthFor } = await import("./better-auth");
    return betterAuthFor(env);
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
      // Session lookup failures are infrastructure errors, not invalid credentials.
      return activeIdentity(env, identity);
    });
  const resolveRequestActor =
    dependencies.resolveActor ??
    (async (env: ApiWorkerEnv, identity: JwtIdentity, request: Request, requestId: string) =>
      resolveActor(env, identity, request, requestId));
  const authRateLimiter =
    dependencies.authRateLimiter ??
    ((env: ApiWorkerEnv, action: string, request: Request) =>
      checkAuthRateLimit(env, action, request));
  const verifyAccessToken =
    dependencies.verifyAccessToken ??
    ((env: ApiWorkerEnv, token: string) => accessVerifierFor(env)(token));
  const loadCurrentUser =
    dependencies.loadCurrentUser ??
    (async (env: ApiWorkerEnv, claims: SessionClaims) => {
      const currentUser = await import("./current-user");
      return currentUser.loadCurrentUser(env, claims);
    });
  app.use("*", async (c, next) => {
    const startedAt = performance.now();
    const requestId = createRequestId(c.req.header("X-Request-ID"));
    const traceId = createTraceId(c.req.header("traceparent"), requestId);
    c.set("requestId", requestId);
    c.set("traceId", traceId);
    await next();
    c.header("X-Request-ID", requestId);
    const errorCode = await responseErrorCode(c.res);
    log(
      "info",
      {
        environment: c.env.ENVIRONMENT,
        request_id: requestId,
        route: observabilityRoute(c),
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
        ...(observabilityRoute(c) === "/unmatched" ? { path: c.req.path } : {}),
        retry_class: c.res.status === 429 || c.res.status >= 500 ? "client_retry" : "none",
      },
    );
    // Real request span for local Tempo. waitUntil keeps the short OTLP hop
    // alive after the response without blocking the client.
    const spanExport = exportOtlpSpan(
      { ENVIRONMENT: c.env.ENVIRONMENT },
      {
        attributes: {
          "http.method": c.req.method,
          "http.route": observabilityRoute(c),
          "http.status_code": c.res.status,
          ...(errorCode ? { error_code: errorCode } : {}),
          request_id: requestId,
        },
        endTimeMs: Date.now(),
        name: `${c.req.method} ${observabilityRoute(c)}`,
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
  // Split CORS: `/api/v1` accepts only the in-memory bearer JWT, so it permits
  // the Authorization header but never credentials (public API requests run
  // with credentials omitted); `/api/auth` keeps credentialed CORS because the
  // Better Auth session cookie remains the transport for token minting and
  // lifecycle calls. Only the credentialed variant exposes `set-auth-jwt`, so
  // cross-origin browser code can read the JWT plugin's session responses.
  // Unapproved origins are rejected before any route work. Hono 4 does not
  // accept path arrays in `use`, so the middleware registers once per mount
  // point, and each instance fixes its exposed-header list up front.
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
        c.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
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

  // Operator surface: Cloudflare Access JWT on the dedicated operator hostname.
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

  // Better Auth surface: database-backed fixed-window abuse controls run before
  // the handler so credential endpoints cannot be brute-forced across isolates.
  // Environments without a system database (unit tests) skip limiting rather
  // than failing every auth request.
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
          // Preserve the RFC 8628 polling contract: token polling back-off is
          // communicated as the top-level slow_down error, exactly like the
          // plugin's own interval enforcement, with the distributed budget's
          // delay in Retry-After. The generic API error envelope would break
          // separately released CLI clients.
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

  // Invitation acceptance consumes a bearer-like token, so it shares the
  // database-backed fixed-window abuse control used by credential endpoints.
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

  // Tenant authentication: the Better Auth JWT bearer credential is verified
  // against the plugin-managed JWKS and the actor — internal user, workspace
  // membership, and role — is resolved server-side. Requests without a
  // well-formed `Authorization: Bearer` header are rejected before any
  // verification or database work; session cookies are never accepted on this
  // surface and there is no client-supplied workspace fallback.
  // Only explicit authentication failures become 401; session-store failures
  // propagate to onError without falsely invalidating the owner's credentials.
  app.use("/api/v1/*", async (c, next) => {
    const publicPath =
      c.req.path === "/api/v1/health" ||
      c.req.path === "/api/v1/ready" ||
      // The invitation acceptance page inspects a token before the visitor
      // has an account or session. Token possession is the credential.
      (c.req.method === "GET" && /^\/api\/v1\/workspace-invitations\/[^/]+$/.test(c.req.path)) ||
      // Provider-media URLs carry their own HMAC bearer credential; the route
      // verifies it before touching R2, so no user session is required.
      c.req.path.startsWith(providerMediaRoutePrefix) ||
      /^\/api\/v1\/platforms\/[^/]+\/callback$/.test(c.req.path);
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
    let identity: JwtIdentity;
    try {
      identity = await verifyJwtToken(c.env, token);
    } catch (cause) {
      if (
        !(
          cause instanceof CoreApiError &&
          cause.status === 401 &&
          cause.code === "authentication_required"
        )
      )
        throw cause;
      return errorResponse(
        c.get("requestId"),
        401,
        "authentication_required",
        "Authentication is required.",
      );
    }
    c.set("identity", identity);
    try {
      c.set("actor", await resolveRequestActor(c.env, identity, c.req.raw, c.get("requestId")));
    } catch (cause) {
      if (cause instanceof CoreApiError) {
        return errorResponse(c.get("requestId"), cause.status, cause.code, cause.message);
      }
      throw cause;
    }
    await next();
  });

  // Role-gate content and configuration mutations. Services and RLS remain the
  // authoritative checks; this produces the stable forbidden error early.
  app.use("/api/v1/*", enforceWorkspaceCapabilities);

  app.get("/api/v1/health", (c) =>
    jsonResponse(
      {
        environment: c.env.ENVIRONMENT,
        status: "ok",
        version: c.env.VERSION,
      },
      200,
      c.get("requestId"),
    ),
  );

  // Readiness evaluates the current invocation's env on every request:
  // `bindingStatuses` re-derives each component (including semantic checks like
  // a callable MAIL binding and a valid sender) so a degraded env can never be
  // masked by a stale success. The 30s cache only short-circuits the Hyperdrive
  // probes — it may serve a prior ready result solely when every recomputed
  // component is already ready for this invocation's configuration.
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

  // Non-production flow explorer: record one sanitized run per API request.
  // Ledger work is deferred and single-flighted so Hyperdrive pool pressure
  // cannot hang subsequent authenticated requests in local wrangler.
  let flowObserveChain: Promise<void> = Promise.resolve();
  app.use("/api/v1/*", async (c, next) => {
    if (
      c.req.path === "/api/v1/health" ||
      c.req.path === "/api/v1/ready" ||
      // Unauthenticated provider fetches have no actor or workspace; recording
      // them would add org-less noise to the flow ledger.
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
      const observe = () =>
        (async () => {
          const runId = await recorder.startRun({
            entrypoint: observabilityRoute(c),
            metadata: {
              http_method: c.req.method,
              route: observabilityRoute(c),
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
            operation: `${c.req.method} ${observabilityRoute(c)}`,
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
      // Integration tests assert finished ledger rows on the same request
      // turn. Await there. Local wrangler defers via waitUntil so Hyperdrive
      // pool pressure cannot hang authenticated responses.
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

  // Eager Outbox relay: once a mutating transaction has committed inside
  // next(), ask Automation to relay on this request's background continuation
  // so the common case does not wait for the hourly sweep. Registered ahead of
  // the core and operator routes, because Hono matches in registration order.
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
      createCurrentUserServiceLive(c.env, actor.claims, loadCurrentUser);

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
