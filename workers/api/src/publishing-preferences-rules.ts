import type { components } from "@meltiply/contracts/schema";
import { isMailSenderAddress, mailSenderConfiguration } from "@meltiply/domain/mail-content";

import { RFC4122_UUID_PATTERN } from "@meltiply/domain";
import { CoreApiError } from "./api-errors";
import type { ApiWorkerEnv } from "./env";

type Schemas = components["schemas"];

const signaturePlaceholderPattern = /\{([^{}]+)\}/g;
const supportedSignaturePlaceholders: Readonly<Record<string, true>> = {
  brand_profile: true,
  channel: true,
  platform: true,
};

export interface PreferenceRow extends Record<string, unknown> {
  notification_preferences: Schemas["NotificationPreferences"];
  signature_templates: Schemas["SignatureTemplate"][];
  timezone: string | null;
  updated_at: Date | string;
}

export function emailDeliveryAvailable(env: ApiWorkerEnv): boolean {
  return typeof env.MAIL?.send === "function" && mailSenderConfiguration(env) !== undefined;
}

export function normalizeSignatureTemplates(
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
    const id = typeof template.id === "string" ? template.id.toLowerCase() : "";
    if (!RFC4122_UUID_PATTERN.test(id) || ids.has(id)) {
      throw new CoreApiError(
        422,
        "validation_error",
        "Signature template ids must be unique UUIDs.",
      );
    }
    ids.add(id);
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
      id,
      is_default: template.is_default,
      name,
      position,
    };
  });
}

const maximumNotificationRecipients = 20;

export function normalizeNotificationRecipients(recipients: readonly string[]): string[] {
  if (recipients.length > maximumNotificationRecipients) {
    throw new CoreApiError(
      422,
      "validation_error",
      `Use no more than ${maximumNotificationRecipients} email recipients.`,
    );
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const candidate of recipients) {
    const email = candidate.trim().toLowerCase();
    if (!isMailSenderAddress(email, true)) {
      throw new CoreApiError(422, "validation_error", "Use valid email recipients.");
    }
    if (!seen.has(email)) {
      seen.add(email);
      normalized.push(email);
    }
  }
  return normalized;
}

export function validateNotifications(
  notifications: Schemas["NotificationPreferences"],
  emailAvailable: boolean,
): Schemas["NotificationPreferences"] {
  const email = notifications.channels?.email;
  if (
    typeof notifications.events?.publication_failed !== "boolean" ||
    typeof notifications.events?.channel_disconnected !== "boolean" ||
    typeof email?.enabled !== "boolean" ||
    !Array.isArray(email.recipients)
  ) {
    throw new CoreApiError(422, "validation_error", "Notification choices are invalid.");
  }
  const recipients = normalizeNotificationRecipients(email.recipients);
  if (email.enabled && !emailAvailable) {
    throw new CoreApiError(
      422,
      "notification_channel_unavailable",
      "Email delivery is not configured for this installation.",
    );
  }
  if (email.enabled && recipients.length === 0) {
    throw new CoreApiError(
      422,
      "validation_error",
      "Add at least one email recipient before enabling email.",
    );
  }
  return {
    channels: { email: { enabled: email.enabled, recipients } },
    events: {
      channel_disconnected: notifications.events.channel_disconnected,
      publication_failed: notifications.events.publication_failed,
    },
  };
}

export function mapPreferences(
  row: PreferenceRow | undefined,
  emailAvailable: boolean,
): Schemas["PublishingPreferences"] {
  if (!row) {
    return {
      email_available: emailAvailable,
      notifications: {
        channels: { email: { enabled: false, recipients: [] } },
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

export function validatedPreferences(
  input: Schemas["PublishingPreferencesUpdate"],
  emailAvailable: boolean,
): {
  notifications: Schemas["NotificationPreferences"];
  signatures: Schemas["SignatureTemplate"][];
} {
  return {
    notifications: validateNotifications(input.notifications, emailAvailable),
    signatures: normalizeSignatureTemplates(input.signature_templates ?? []),
  };
}

export function preferencesError(cause: unknown): CoreApiError {
  return cause instanceof CoreApiError
    ? cause
    : new CoreApiError(422, "validation_error", "Publishing preferences are invalid.");
}
