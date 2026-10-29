import type { SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import { Effect } from "effect";

import {
  activeOrganizationIdEffect,
  type EffectTransactionClient,
  withTenantTransactionEffect,
} from "./database";
import type { ApiWorkerEnv } from "./env";
import { CoreApiError, type IdempotentResult } from "./core-types";
import {
  completeIdempotencyEffect,
  hashIdempotencyRequestEffect,
  reserveIdempotencyEffect,
} from "./idempotency";
import { mailSenderConfiguration } from "./mail";
import type { PostServiceError } from "./post-types";

type Schemas = components["schemas"];

/** Placeholders a signature body may resolve; anything else is rejected. */
const signaturePlaceholderPattern = /\{([^{}]+)\}/g;
const supportedSignaturePlaceholders: Readonly<Record<string, true>> = {
  brand_profile: true,
  channel: true,
  platform: true,
};

interface PreferenceRow extends Record<string, unknown> {
  notification_preferences: Schemas["NotificationPreferences"];
  signature_templates: Schemas["SignatureTemplate"][];
  timezone: string | null;
  updated_at: Date | string;
}

/** Input accepted by the replacement write; capability fields are server-owned. */
type PublishingPreferencesUpdate = Schemas["PublishingPreferencesUpdate"];

/**
 * Reports whether this installation can actually deliver mail. A binding that
 * exists but whose sender is invalid is not available, because the composer
 * must never offer a channel that cannot deliver.
 */
function emailDeliveryAvailable(env: ApiWorkerEnv): boolean {
  return typeof env.MAIL?.send === "function" && mailSenderConfiguration(env) !== undefined;
}

/**
 * Rejects a timezone identifier the database does not recognize. Validating
 * against PostgreSQL's `pg_timezone_names` matches the authority used by Queue
 * scheduling, so a preference that saves is always one the scheduler accepts.
 */
function validateTimezoneEffect(
  client: EffectTransactionClient,
  timezone: string | null,
): Effect.Effect<void, PostServiceError> {
  if (timezone === null) return Effect.void;
  return client
    .query<{ valid: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $1) AS valid",
      [timezone],
    )
    .pipe(
      Effect.flatMap((result) =>
        result.rows[0]?.valid
          ? Effect.void
          : Effect.fail(
              new CoreApiError(422, "validation_error", "Use a supported IANA timezone."),
            ),
      ),
    );
}

/**
 * Validates and normalizes the complete signature list.
 *
 * Positions are rewritten to the array order so reordering is expressed by the
 * submitted list rather than by trusting client arithmetic. IDs are supplied by
 * the client so renaming a template does not create a new identity. Exactly one
 * template must be the default whenever the list is non-empty.
 *
 * @param templates - Requested templates in display order.
 * @returns Normalized templates with contiguous zero-based positions.
 * @throws {CoreApiError} 422 when an id, name, body, placeholder, or default is invalid.
 */
function normalizeSignatureTemplates(
  templates: readonly Schemas["SignatureTemplate"][],
): Schemas["SignatureTemplate"][] {
  if (templates.length > 10) {
    throw new CoreApiError(422, "validation_error", "Use no more than 10 signature templates.");
  }
  const ids = new Set<string>();
  const defaults = templates.filter((template) => template.is_default).length;
  if (templates.length > 0 && defaults !== 1) {
    throw new CoreApiError(
      422,
      "validation_error",
      "Choose exactly one default signature template.",
    );
  }
  return templates.map((template, position) => {
    if (
      typeof template.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        template.id,
      ) ||
      ids.has(template.id)
    ) {
      throw new CoreApiError(
        422,
        "validation_error",
        "Signature template ids must be unique UUIDs.",
      );
    }
    ids.add(template.id);
    const name = template.name.trim();
    const body = template.body.trim();
    if (name.length === 0 || name.length > 80) {
      throw new CoreApiError(
        422,
        "validation_error",
        "Signature template names must be between 1 and 80 characters.",
      );
    }
    if (body.length === 0 || body.length > 1_000) {
      throw new CoreApiError(
        422,
        "validation_error",
        "Signature template bodies must be between 1 and 1000 characters.",
      );
    }
    for (const match of body.matchAll(signaturePlaceholderPattern)) {
      if (!Object.hasOwn(supportedSignaturePlaceholders, match[1]!)) {
        throw new CoreApiError(
          422,
          "validation_error",
          `Unsupported signature placeholder: {${match[1]}}.`,
        );
      }
    }
    return {
      body,
      id: template.id.toLowerCase(),
      is_default: template.is_default,
      name,
      position,
    };
  });
}

/**
 * Validates notification choices against the events and channels the product
 * actually supports. An unconfigured mail sender cannot be enabled, because
 * accepting that choice would promise delivery that cannot happen.
 */
function validateNotifications(
  notifications: Schemas["NotificationPreferences"],
  emailAvailable: boolean,
): Schemas["NotificationPreferences"] {
  if (
    typeof notifications.events?.publication_failed !== "boolean" ||
    typeof notifications.events?.channel_disconnected !== "boolean" ||
    typeof notifications.channels?.email !== "boolean"
  ) {
    throw new CoreApiError(422, "validation_error", "Notification choices are invalid.");
  }
  if (notifications.channels.email && !emailAvailable) {
    throw new CoreApiError(
      422,
      "notification_channel_unavailable",
      "Email delivery is not configured for this installation.",
    );
  }
  return {
    channels: { email: notifications.channels.email },
    events: {
      channel_disconnected: notifications.events.channel_disconnected,
      publication_failed: notifications.events.publication_failed,
    },
  };
}

function mapPreferences(
  row: PreferenceRow | undefined,
  emailAvailable: boolean,
): Schemas["PublishingPreferences"] {
  if (!row) {
    return {
      email_available: emailAvailable,
      notifications: {
        channels: { email: false },
        events: { channel_disconnected: false, publication_failed: false },
      },
      signature_templates: [],
      timezone: null,
      updated_at: new Date(0).toISOString(),
    };
  }
  return {
    email_available: emailAvailable,
    notifications: row.notification_preferences,
    signature_templates: row.signature_templates,
    timezone: row.timezone,
    updated_at:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

/** Reads and replaces the shared Workspace's publishing preferences. */
export interface PublishingPreferencesApiService {
  get(
    env: ApiWorkerEnv,
    session: SessionClaims,
  ): Effect.Effect<Schemas["PublishingPreferences"], PostServiceError>;
  replace(
    env: ApiWorkerEnv,
    session: SessionClaims,
    input: PublishingPreferencesUpdate,
    idempotencyKey: string,
  ): Effect.Effect<IdempotentResult<Schemas["PublishingPreferences"]>, PostServiceError>;
}

/** Creates the tenant-backed preference service; writes require the Admin role. */
export function createPublishingPreferencesApiService(): PublishingPreferencesApiService {
  return {
    /** Reads the row without creating one; an absent row reports documented defaults. */
    get(env, session) {
      return withTenantTransactionEffect(env, session, (client) =>
        client
          .query<PreferenceRow>(
            `SELECT timezone, signature_templates, notification_preferences, updated_at
               FROM publishing_preferences WHERE org_id = public.auth_active_org_id()`,
          )
          .pipe(
            Effect.map((result) => mapPreferences(result.rows[0], emailDeliveryAvailable(env))),
          ),
      );
    },

    /** Atomically replaces the complete preference document with idempotent replay. */
    replace(env, session, input, idempotencyKey) {
      return Effect.gen(function* () {
        const requestHash = yield* hashIdempotencyRequestEffect(JSON.stringify(input));
        return yield* withTenantTransactionEffect(env, session, (client) =>
          Effect.gen(function* () {
            const organizationId = yield* activeOrganizationIdEffect(client);
            const role = yield* client.query<{ role: string }>(
              "SELECT public.auth_active_org_role() AS role",
            );
            if (role.rows[0]?.role !== "admin") {
              return yield* Effect.fail(
                new CoreApiError(
                  403,
                  "workspace_admin_required",
                  "Only Workspace Admins can change publishing preferences.",
                ),
              );
            }
            const replay = yield* reserveIdempotencyEffect(
              client,
              organizationId,
              "publishing-preferences",
              idempotencyKey,
              requestHash,
            );
            if (replay) {
              return {
                replayed: true,
                value: replay.response_body as Schemas["PublishingPreferences"],
              };
            }
            yield* validateTimezoneEffect(client, input.timezone);
            const emailAvailable = emailDeliveryAvailable(env);
            const validated = yield* Effect.try({
              catch: (cause) =>
                cause instanceof CoreApiError
                  ? cause
                  : new CoreApiError(
                      422,
                      "validation_error",
                      "Publishing preferences are invalid.",
                    ),
              try: () => ({
                notifications: validateNotifications(input.notifications, emailAvailable),
                signatures: normalizeSignatureTemplates(input.signature_templates ?? []),
              }),
            });
            const notifications = validated.notifications;
            const signatures = validated.signatures;
            const result = yield* client.query<PreferenceRow>(
              `INSERT INTO publishing_preferences
                 (org_id, timezone, signature_templates, notification_preferences)
               VALUES ($1, $2, $3::jsonb, $4::jsonb)
               ON CONFLICT (org_id) DO UPDATE SET
                 timezone = EXCLUDED.timezone,
                 signature_templates = EXCLUDED.signature_templates,
                 notification_preferences = EXCLUDED.notification_preferences,
                 updated_at = now()
               RETURNING timezone, signature_templates, notification_preferences, updated_at`,
              [
                organizationId,
                input.timezone,
                JSON.stringify(signatures),
                JSON.stringify(notifications),
              ],
            );
            const value = mapPreferences(result.rows[0], emailAvailable);
            yield* completeIdempotencyEffect(
              client,
              organizationId,
              "publishing-preferences",
              idempotencyKey,
              200,
              value,
            );
            return { replayed: false, value };
          }),
        );
      });
    },
  };
}
