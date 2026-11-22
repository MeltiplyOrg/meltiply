import { Effect } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import {
  isDiagnosticCategory,
  isDiscoverySource,
  isOperationCategory,
  isPlatform,
  isProviderFailureClass,
  reportingConfiguration,
  REPORTING_MAX_DELIVERY_BATCH,
  ReportingService,
  type ReportingCategoryStatus,
  type ReportingFeedbackState,
  type ReportingServiceShape,
  type ReportingPolicySnapshot,
} from "@meltiply/reporting";
import type { Context, Hono } from "hono";

import type { ResolvedActor } from "./actor-resolution";
import { auditActorFrom, recordWorkspaceAuditEffect } from "./audit";
import { runBackgroundContinuation } from "./background-continuation";
import { CoreApiError } from "./core-types";
import { fromPromise } from "./effect/route";
import { runRouteEffect } from "./effect/runtime";
import type { ApiWorkerEnv, ApiWorkerEnvironment } from "./env";
import { hashIdempotencyRequestEffect } from "./idempotency";
import { idempotencyHeaders } from "./idempotent-response";
import { jsonResponse } from "./responses";
import { reportingLayer, type ReportingDependencies } from "./reporting-layer";
import { idempotencyKey, jsonBody, onlyKeys } from "./validation";
import { idempotentInstallationMutation } from "./installation-mutation";

interface CategoryBody {
  decision_at: string | null;
  effective: boolean;
  interval_started_at: string | null;
  reason: ReportingCategoryStatus["reason"];
  requested: boolean;
}

interface PolicyBody {
  categories: { diagnostics: CategoryBody; usage: CategoryBody };
  destination_configured: boolean;
  disclosure_version: number;
  installation_reporting_id: string | null;
  operator_forced_off: boolean;
  owner_can_change: boolean;
}

interface FeedbackBody {
  delivery_status: ReportingFeedbackState["deliveryStatus"];
  discovery_source: ReportingFeedbackState["discoverySource"];
  shared: boolean;
  submitted_at: string | null;
}

interface DiagnosticBody {
  accepted: boolean;
  reason: "category_disabled" | "queued";
}

function requestId(c: Context<ApiWorkerEnvironment>): string {
  return c.get("requestId");
}

function categoryBody(status: ReportingCategoryStatus): CategoryBody {
  return {
    decision_at: status.decidedAt,
    effective: status.effective,
    interval_started_at: status.intervalStartedAt,
    reason: status.reason,
    requested: status.requested,
  };
}

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

function feedbackBody(state: ReportingFeedbackState): FeedbackBody {
  return {
    delivery_status: state.deliveryStatus,
    discovery_source: state.discoverySource,
    shared: state.shared,
    submitted_at: state.submittedAt,
  };
}

function withReporting<A, E>(
  env: ApiWorkerEnv,
  dependencies: ReportingDependencies,
  program: (service: ReportingServiceShape) => Effect.Effect<A, E>,
  client?: EffectTransactionClient,
): Effect.Effect<A, E> {
  return Effect.flatMap(ReportingService, program).pipe(
    Effect.provide(reportingLayer(env, dependencies, client)),
  );
}

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

function booleanField(body: Record<string, unknown>, name: string): boolean {
  const value = body[name];
  if (typeof value !== "boolean") {
    throw new CoreApiError(400, "validation_error", `${name} must be a boolean.`);
  }
  return value;
}

export function registerReportingRoutes(
  app: Hono<ApiWorkerEnvironment>,
  dependencies: ReportingDependencies = {},
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
        const result = yield* idempotentInstallationMutation(
          c.env,
          actor.workspace.id,
          "installation.reporting.update",
          key,
          requestHash,
          (client) =>
            Effect.gen(function* () {
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
        const result = yield* idempotentInstallationMutation(
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
          onlyKeys(body, [
            "category",
            "error_name",
            "error_stack",
            "operation",
            "platform",
            "provider_failure_class",
          ]),
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
          const rawFailureClass = body.provider_failure_class;
          if (rawFailureClass !== undefined && !isProviderFailureClass(rawFailureClass)) {
            throw new CoreApiError(
              400,
              "validation_error",
              "provider_failure_class must be one of the documented Provider classes.",
            );
          }
          return {
            category,
            ...(rawFailureClass === undefined ? {} : { failureClass: rawFailureClass }),
            error: {
              name: typeof body.error_name === "string" ? body.error_name : "Error",
              stack: typeof body.error_stack === "string" ? body.error_stack : undefined,
            },
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

function scheduleReportingDelivery(
  c: Context<ApiWorkerEnvironment>,
  dependencies: ReportingDependencies,
): void {
  if (!reportingConfiguration(c.env).destination) return;
  runBackgroundContinuation(c, {
    errorCode: "reporting_delivery_failed",
    event: "reporting_delivery",
    perform: () =>
      Effect.runPromise(
        withReporting(c.env, dependencies, (service) =>
          service.deliverPending({ limit: REPORTING_MAX_DELIVERY_BATCH }),
        ),
      ),
  });
}
