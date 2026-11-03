import { Effect, type Layer } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import {
  createPostHogTransport,
  createReportingServiceLive,
  isDiagnosticCategory,
  isDiscoverySource,
  isOperationCategory,
  isPlatform,
  reportingConfiguration,
  REPORTING_MAX_DELIVERY_BATCH,
  ReportingService,
  type ReportingCategoryStatus,
  type ReportingFeedbackState,
  type ReportingServiceShape,
  type ReportingPolicySnapshot,
  type ReportingTransactionRunner,
} from "@meltiply/reporting";
import type { Context, Hono } from "hono";

import type { ResolvedActor } from "./actor-resolution";
import { auditActorFrom, recordWorkspaceAuditEffect } from "./audit";
import { runBackgroundContinuation } from "./background-continuation";
import { CoreApiError } from "./core-types";
import { withSystemTransactionEffect } from "./database";
import { fromPromise } from "./effect/route";
import { runRouteEffect } from "./effect/runtime";
import type { ApiWorkerEnv, ApiWorkerEnvironment } from "./env";
import { hashIdempotencyRequestEffect } from "./idempotency";
import { idempotencyHeaders } from "./idempotent-response";
import { jsonResponse } from "./responses";
import { idempotencyKey, jsonBody, onlyKeys } from "./validation";
import { idempotentMutation } from "./workspace-lifecycle";

/**
 * Installation improvement-reporting HTTP surface.
 *
 * One policy document is readable by every active member so the Owner's choices
 * and the effective outbound state stay visible to the team. Only the current
 * Installation Owner mutates it: authority follows the `installation_owner` flag
 * on the user row, so a transferred installation is governed by its new Owner
 * without reissuing anything.
 *
 * Nothing here reports a delivery it has not confirmed. The feedback surface
 * separates a local choice (`not_shared`), a queued report (`pending`) and a
 * confirmed send (`delivered`), and `delivery_status` only becomes `delivered`
 * after the capture endpoint accepted the report.
 */

/** Injection seam for reporting routes, mirroring the Mail/CurrentUser layers. */
export interface ReportingRouteDependencies {
  /** Overrides the live reporting layer for tests or alternate transports. */
  reportingServiceLayer?:
    | Layer.Layer<ReportingService, never, never>
    | ((env: ApiWorkerEnv) => Layer.Layer<ReportingService, never, never>);
}

/** Wire shape of one category, matching the OpenAPI `ReportingCategoryStatus`. */
interface CategoryBody {
  decision_at: string | null;
  effective: boolean;
  interval_started_at: string | null;
  reason: ReportingCategoryStatus["reason"];
  requested: boolean;
}

/** Wire shape of the member-readable policy document. */
interface PolicyBody {
  categories: { diagnostics: CategoryBody; usage: CategoryBody };
  destination_configured: boolean;
  disclosure_version: number;
  installation_reporting_id: string | null;
  operator_forced_off: boolean;
  owner_can_change: boolean;
}

/** Wire shape of the one-time attribution state. */
interface FeedbackBody {
  delivery_status: ReportingFeedbackState["deliveryStatus"];
  discovery_source: ReportingFeedbackState["discoverySource"];
  shared: boolean;
  submitted_at: string | null;
}

/** Wire shape returned by diagnostic ingestion. */
interface DiagnosticBody {
  accepted: boolean;
  reason: "category_disabled" | "queued";
}

function requestId(c: Context<ApiWorkerEnvironment>): string {
  return c.get("requestId");
}

/** Projects one category into the wire shape. */
function categoryBody(status: ReportingCategoryStatus): CategoryBody {
  return {
    decision_at: status.decidedAt,
    effective: status.effective,
    interval_started_at: status.intervalStartedAt,
    reason: status.reason,
    requested: status.requested,
  };
}

/** Projects the policy snapshot into the wire shape. */
function policyBody(policy: ReportingPolicySnapshot, ownerCanChange: boolean): PolicyBody {
  return {
    categories: {
      diagnostics: categoryBody(policy.categories.diagnostics),
      usage: categoryBody(policy.categories.usage),
    },
    destination_configured: policy.destinationConfigured,
    disclosure_version: policy.disclosureVersion,
    installation_reporting_id: policy.installationReportingId,
    operator_forced_off: policy.operatorForcedOff,
    owner_can_change: ownerCanChange,
  };
}

/** Projects the attribution state into the wire shape. */
function feedbackBody(state: ReportingFeedbackState): FeedbackBody {
  return {
    delivery_status: state.deliveryStatus,
    discovery_source: state.discoverySource,
    shared: state.shared,
    submitted_at: state.submittedAt,
  };
}

/**
 * Resolves the reporting layer for one invocation.
 *
 * An injected layer wins, matching the Mail and CurrentUser seams: callers that
 * own a transaction (the Owner mutations) still supply the client so the decision
 * and its Audit entry commit together. Otherwise the layer is derived per request
 * from the current bindings, so a changed operator override or destination applies
 * without an isolate restart.
 *
 * @param env - Current Worker bindings.
 * @param dependencies - Optional injected layer or layer factory.
 * @param client - Existing transaction client to reuse, when present.
 * @returns Layer providing `ReportingService` with `R = never`.
 */
function reportingLayer(
  env: ApiWorkerEnv,
  dependencies: ReportingRouteDependencies = {},
  client?: EffectTransactionClient,
): Layer.Layer<ReportingService, never, never> {
  const injected = dependencies.reportingServiceLayer;
  if (injected !== undefined && client === undefined) {
    return typeof injected === "function" ? injected(env) : injected;
  }
  const configuration = reportingConfiguration(env);
  const transaction: ReportingTransactionRunner = client
    ? (operation) => operation(client)
    : (operation) => withSystemTransactionEffect(env, (systemClient) => operation(systemClient));
  return createReportingServiceLive({
    appVersion: env.VERSION,
    configuration,
    transaction,
    transport: configuration.destination
      ? createPostHogTransport({ destination: configuration.destination })
      : null,
  });
}

/** Runs one reporting service program against the current bindings. */
function withReporting<A, E>(
  env: ApiWorkerEnv,
  dependencies: ReportingRouteDependencies,
  program: (service: ReportingServiceShape) => Effect.Effect<A, E>,
  client?: EffectTransactionClient,
): Effect.Effect<A, E> {
  return Effect.flatMap(ReportingService, program).pipe(
    Effect.provide(reportingLayer(env, dependencies, client)),
  );
}

/** Asserts the caller is the current Installation Owner. */
function requireInstallationOwner(actor: ResolvedActor): Effect.Effect<void, CoreApiError> {
  return actor.isInstallationOwner
    ? Effect.void
    : Effect.fail(
        new CoreApiError(
          403,
          "installation_owner_required",
          "The installation owner role is required.",
        ),
      );
}

/** Reads a strictly boolean request field. */
function booleanField(body: Record<string, unknown>, name: string): boolean {
  const value = body[name];
  if (typeof value !== "boolean") {
    throw new CoreApiError(400, "validation_error", `${name} must be a boolean.`);
  }
  return value;
}

/**
 * Registers reporting preference, feedback and diagnostic ingestion routes.
 *
 * @param app - Hono application instance.
 * @param dependencies - Optional injected reporting service layer.
 */
export function registerReportingRoutes(
  app: Hono<ApiWorkerEnvironment>,
  dependencies: ReportingRouteDependencies = {},
): void {
  app.get("/api/v1/installation/reporting", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        const policy = yield* withReporting(c.env, dependencies, (service) => service.policy());
        return jsonResponse(policyBody(policy, actor.isInstallationOwner), 200, requestId(c));
      }),
    ),
  );

  app.put("/api/v1/installation/reporting", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        yield* requireInstallationOwner(actor);
        const body = yield* fromPromise(() => jsonBody(c, true));
        yield* fromPromise(() => onlyKeys(body, ["diagnostics", "usage"]));
        const usage = yield* fromPromise(() => booleanField(body, "usage"));
        const diagnostics = yield* fromPromise(() => booleanField(body, "diagnostics"));
        const key = yield* fromPromise(() => idempotencyKey(c));
        const requestHash = yield* hashIdempotencyRequestEffect(
          JSON.stringify({ diagnostics, usage }),
        );
        const result = yield* idempotentMutation(
          c.env,
          actor.workspace.id,
          "installation.reporting.update",
          key,
          requestHash,
          (client) =>
            Effect.gen(function* () {
              // The preference write and its Audit entry share one transaction,
              // so the trail can never disagree with the stored consent.
              const updated = yield* withReporting(
                c.env,
                dependencies,
                (service) => service.setPreferences({ diagnostics, usage }),
                client,
              );
              if (updated.changed) {
                yield* recordWorkspaceAuditEffect(client, {
                  action: "reporting.preferences_updated",
                  actor: auditActorFrom({
                    display_name: actor.displayName,
                    email: actor.email,
                    id: actor.userId,
                  }),
                  // The decision and its effective consequence are audited; the
                  // pseudonymous installation identifier never enters the trail.
                  after: {
                    diagnostics: updated.policy.categories.diagnostics.requested,
                    diagnostics_effective: updated.policy.categories.diagnostics.effective,
                    usage: updated.policy.categories.usage.requested,
                    usage_effective: updated.policy.categories.usage.effective,
                  },
                  orgId: actor.workspace.id,
                  requestId: requestId(c),
                  targetId: "reporting",
                  targetType: "installation",
                });
              }
              return { body: policyBody(updated.policy, true), replayed: false, status: 200 };
            }),
        );
        return jsonResponse(result.body, result.status, requestId(c), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.get("/api/v1/installation/reporting/feedback", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        yield* requireInstallationOwner(actor);
        const state = yield* withReporting(c.env, dependencies, (service) =>
          service.feedbackState(),
        );
        return jsonResponse(feedbackBody(state), 200, requestId(c));
      }),
    ),
  );

  app.post("/api/v1/installation/reporting/feedback", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        yield* requireInstallationOwner(actor);
        const body = yield* fromPromise(() => jsonBody(c, true));
        yield* fromPromise(() => onlyKeys(body, ["discovery_source"]));
        const source = yield* fromPromise(() => {
          const value = body.discovery_source;
          if (!isDiscoverySource(value)) {
            throw new CoreApiError(
              400,
              "validation_error",
              "discovery_source must be one of the documented values.",
            );
          }
          return value;
        });
        const key = yield* fromPromise(() => idempotencyKey(c));
        const requestHash = yield* hashIdempotencyRequestEffect(
          JSON.stringify({ discovery_source: source }),
        );
        const result = yield* idempotentMutation(
          c.env,
          actor.workspace.id,
          "installation.reporting.feedback",
          key,
          requestHash,
          (client) =>
            Effect.gen(function* () {
              const state = yield* withReporting(
                c.env,
                dependencies,
                (service) => service.submitFeedback(source),
                client,
              );
              // A submission that actually shares an answer is an administrative
              // action; declining records the local choice without an event and
              // without a trail entry.
              if (state.shared) {
                yield* recordWorkspaceAuditEffect(client, {
                  action: "reporting.feedback_submitted",
                  actor: auditActorFrom({
                    display_name: actor.displayName,
                    email: actor.email,
                    id: actor.userId,
                  }),
                  after: {
                    delivery_status: state.deliveryStatus,
                    discovery_source: state.discoverySource,
                  },
                  orgId: actor.workspace.id,
                  requestId: requestId(c),
                  targetId: "reporting",
                  targetType: "installation",
                });
              }
              return { body: feedbackBody(state), replayed: false, status: 200 };
            }),
        );
        return jsonResponse(result.body, result.status, requestId(c), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.post("/api/v1/installation/reporting/diagnostics", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        c.get("actor");
        const body = yield* fromPromise(() => jsonBody(c, true));
        yield* fromPromise(() =>
          onlyKeys(body, ["category", "error_name", "error_stack", "operation", "platform"]),
        );
        const input = yield* fromPromise(() => {
          const category = body.category;
          const operation = body.operation;
          const platform = body.platform;
          if (!isDiagnosticCategory(category)) {
            throw new CoreApiError(
              400,
              "validation_error",
              "category must be one of the documented diagnostic categories.",
            );
          }
          if (!isOperationCategory(operation)) {
            throw new CoreApiError(
              400,
              "validation_error",
              "operation must be one of the documented operation categories.",
            );
          }
          if (platform !== undefined && !isPlatform(platform)) {
            throw new CoreApiError(
              400,
              "validation_error",
              "platform must be a supported Platform.",
            );
          }
          return {
            category,
            error: {
              name: typeof body.error_name === "string" ? body.error_name : "Error",
              stack: typeof body.error_stack === "string" ? body.error_stack : undefined,
            },
            // A forwarded browser failure is already handled by the time the
            // receiving server sees it; the decision that matters here is
            // whether persisted diagnostics consent is effective.
            handled: true,
            occurredAt: new Date().toISOString(),
            operation,
            platform,
          };
        });
        const queued = yield* withReporting(c.env, dependencies, (service) =>
          service.enqueueDiagnostic(input),
        );
        scheduleReportingDelivery(c, dependencies);
        return jsonResponse(
          {
            accepted: queued === "queued",
            reason: queued === "queued" ? "queued" : "category_disabled",
          } satisfies DiagnosticBody,
          202,
          requestId(c),
        );
      }),
    ),
  );
}

/**
 * Drains the bounded pending queue on the request's background continuation.
 *
 * Diagnostic ingestion must not delay the response describing the failure, and
 * the delivery attempt has to outlive the handler returning. The continuation is
 * the Worker lifecycle hook for that: a transport failure inside it is logged
 * locally and never changes the HTTP outcome or the caller's error propagation.
 *
 * @param c - Hono request context providing the execution context.
 */
function scheduleReportingDelivery(
  c: Context<ApiWorkerEnvironment>,
  dependencies: ReportingRouteDependencies,
): void {
  if (!reportingConfiguration(c.env).destination) return;
  runBackgroundContinuation(c, {
    errorCode: "reporting_delivery_failed",
    event: "reporting_delivery",
    // The continuation is a Promise-facing boundary, so the Effect program is
    // executed here exactly once, mirroring the flow recorder's adapter.
    perform: () =>
      Effect.runPromise(
        withReporting(c.env, dependencies, (service) =>
          service.deliverPending({ limit: REPORTING_MAX_DELIVERY_BATCH }),
        ),
      ),
  });
}
