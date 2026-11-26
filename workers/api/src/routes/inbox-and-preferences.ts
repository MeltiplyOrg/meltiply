import type { components } from "@meltiply/contracts/schema";
import { MAXIMUM_NOTIFICATION_RECIPIENTS } from "@meltiply/domain";
import { Effect } from "effect";
import type { Hono } from "hono";

import { CoreApiError } from "../api-errors";
import { fromPromise } from "../effect/route";
import { runRouteEffect } from "../effect/runtime";
import type { ApiWorkerEnvironment } from "../env";
import { scheduleInboxCommentSync } from "../inbox-service";
import { idempotencyHeaders, jsonResponse } from "../responses";
import {
  booleanParam,
  enumParam,
  idempotencyKey,
  integerParam,
  jsonBody,
  onlyKeys,
  platformParam,
  REPLY_STATUS_VALUES,
  stringField,
  uuidParam,
} from "../validation";
import { optionalBrandProfileParam, type CoreRouteServices } from "./shared";

function publishingPreferencesInput(
  body: Record<string, unknown>,
): components["schemas"]["PublishingPreferencesUpdate"] {
  onlyKeys(body, ["timezone", "signature_templates", "notifications"]);
  const timezone = body.timezone;
  if (timezone !== null && typeof timezone !== "string") {
    throw new CoreApiError(400, "validation_error", "timezone must be a string or null.");
  }
  if (typeof timezone === "string" && (timezone.length === 0 || timezone.length > 100)) {
    throw new CoreApiError(400, "validation_error", "timezone is invalid.");
  }
  const rawTemplates = body.signature_templates;
  if (!Array.isArray(rawTemplates) || rawTemplates.length > 10) {
    throw new CoreApiError(
      400,
      "validation_error",
      "signature_templates must be an array of at most 10 templates.",
    );
  }
  const signatureTemplates = rawTemplates.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new CoreApiError(400, "validation_error", "Each signature template must be an object.");
    }
    const template = value as Record<string, unknown>;
    onlyKeys(template, ["id", "name", "body", "is_default", "position"]);
    if (
      typeof template.id !== "string" ||
      typeof template.name !== "string" ||
      typeof template.body !== "string" ||
      typeof template.is_default !== "boolean"
    ) {
      throw new CoreApiError(400, "validation_error", "Signature template fields are invalid.");
    }
    return {
      body: template.body,
      id: template.id,
      is_default: template.is_default,
      name: template.name,
      position: typeof template.position === "number" ? template.position : 0,
    };
  });
  const rawNotifications = body.notifications;
  if (
    !rawNotifications ||
    typeof rawNotifications !== "object" ||
    Array.isArray(rawNotifications)
  ) {
    throw new CoreApiError(400, "validation_error", "notifications must be an object.");
  }
  const notifications = rawNotifications as Record<string, unknown>;
  onlyKeys(notifications, ["events", "channels"]);
  if (
    !notifications.events ||
    typeof notifications.events !== "object" ||
    Array.isArray(notifications.events) ||
    !notifications.channels ||
    typeof notifications.channels !== "object" ||
    Array.isArray(notifications.channels)
  ) {
    throw new CoreApiError(
      400,
      "validation_error",
      "Notification events and channels are required.",
    );
  }
  const events = notifications.events as Record<string, unknown>;
  const channels = notifications.channels as Record<string, unknown>;
  onlyKeys(events, ["publication_failed", "channel_disconnected"]);
  onlyKeys(channels, ["email"]);
  const email = channels.email;
  if (!email || typeof email !== "object" || Array.isArray(email)) {
    throw new CoreApiError(400, "validation_error", "Notification email must be an object.");
  }
  const emailChannel = email as Record<string, unknown>;
  onlyKeys(emailChannel, ["enabled", "recipients"]);
  if (
    typeof events.publication_failed !== "boolean" ||
    typeof events.channel_disconnected !== "boolean" ||
    typeof emailChannel.enabled !== "boolean" ||
    !Array.isArray(emailChannel.recipients) ||
    emailChannel.recipients.length > MAXIMUM_NOTIFICATION_RECIPIENTS ||
    emailChannel.recipients.some((recipient) => typeof recipient !== "string")
  ) {
    throw new CoreApiError(
      400,
      "validation_error",
      "Notification choices must include booleans and a recipient array.",
    );
  }
  return {
    notifications: {
      channels: {
        email: {
          enabled: emailChannel.enabled,
          recipients: emailChannel.recipients as string[],
        },
      },
      events: {
        channel_disconnected: events.channel_disconnected,
        publication_failed: events.publication_failed,
      },
    },
    signature_templates: signatureTemplates,
    timezone,
  };
}

export function registerInboxAndPreferencesRoutes(
  app: Hono<ApiWorkerEnvironment>,
  services: CoreRouteServices,
): void {
  app.get("/api/v1/inbox", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const platformValue = c.req.query("platform");
        const distributionIdValue = c.req.query("distribution_id");
        const replyStatus = yield* fromPromise(() =>
          enumParam(c.req.query("reply_status"), "reply_status", REPLY_STATUS_VALUES),
        );
        const distributionId = distributionIdValue
          ? yield* fromPromise(() => uuidParam(distributionIdValue, "distribution_id"))
          : undefined;
        const brandProfileId = yield* fromPromise(() => optionalBrandProfileParam(c));
        const platform = platformValue
          ? yield* fromPromise(() => platformParam(platformValue))
          : undefined;
        const limit = yield* fromPromise(() =>
          integerParam(c.req.query("limit"), "limit", 20, 1, 100),
        );
        const offset = yield* fromPromise(() =>
          integerParam(c.req.query("offset"), "offset", 0, 0, 1_000_000),
        );
        const unreplied = yield* fromPromise(() =>
          booleanParam(c.req.query("unreplied"), "unreplied"),
        );
        const core = yield* fromPromise(services.service);
        const inbox = yield* core.inbox(c.env, c.get("actor").claims, {
          ...(distributionId ? { distributionId } : {}),
          ...(brandProfileId ? { brandProfileId } : {}),
          limit,
          offset,
          ...(platform ? { platform } : {}),
          ...(replyStatus ? { replyStatus } : {}),
          unreplied,
        });
        scheduleInboxCommentSync(c, c.get("actor").workspace.id, distributionId);
        return jsonResponse(inbox, 200, c.get("requestId"));
      }),
    ),
  );

  app.post("/api/v1/inbox/:commentId/reply", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const commentId = yield* fromPromise(() =>
          uuidParam(c.req.param("commentId"), "comment_id"),
        );
        const body = yield* fromPromise(() => jsonBody(c));
        yield* fromPromise(() => onlyKeys(body, ["brand_profile_id", "text"]));
        const replyBrandProfileId = yield* fromPromise(() =>
          uuidParam(stringField(body, "brand_profile_id"), "brand_profile_id"),
        );
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text || text.length > 5_000) {
          return yield* Effect.fail(
            new CoreApiError(
              400,
              "validation_error",
              "Reply text must contain between 1 and 5,000 characters.",
            ),
          );
        }
        const key = yield* fromPromise(() => idempotencyKey(c));
        const core = yield* fromPromise(services.service);
        const result = yield* core.replyToComment(
          c.env,
          c.get("actor").claims,
          commentId,
          replyBrandProfileId,
          text,
          key,
          c.get("requestId"),
        );
        return jsonResponse(result.value, 202, c.get("requestId"), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.get("/api/v1/publishing-preferences", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const service = yield* fromPromise(services.preferences);
        const value = yield* service.get(c.env, c.get("actor").claims);
        return jsonResponse(value, 200, c.get("requestId"));
      }),
    ),
  );

  app.put("/api/v1/publishing-preferences", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const body = yield* fromPromise(() => jsonBody(c));
        const input = yield* fromPromise(() => publishingPreferencesInput(body));
        const key = yield* fromPromise(() => idempotencyKey(c));
        const service = yield* fromPromise(services.preferences);
        const result = yield* service.replace(c.env, c.get("actor").claims, input, key);
        return jsonResponse(result.value, 200, c.get("requestId"), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );
}
