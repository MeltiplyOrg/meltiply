import { isMailSenderAddress, escapeMailHtml } from "@meltiply/domain/mail-content";
import { Effect } from "effect";

import { withSystemTransactionEffect } from "./database";
import type { AutomationEnv } from "./env";
import { RetryableJobError, TerminalJobError, type AutomationJobError } from "./effect/index";
import { safeErrorMessage } from "./errors";
import type { OutboxMessage } from "./messages";

type NotificationKind = "publication_failed" | "channel_disconnected";

interface NotificationPayload {
  aggregate_id: string;
  brand_profile_id?: string;
  channel_name?: string | null;
  connection_status?: string;
  delivery_key: string;
  distribution_id?: string;
  kind: NotificationKind;
  platform: string;
  post_id?: string;
  version: 1;
}

interface DeliveryRow extends Record<string, unknown> {
  attempt_count: number;
  id: string;
  state: string;
}

interface StoredNotificationPreferences {
  channels: { email: boolean };
  events: { channel_disconnected: boolean; publication_failed: boolean };
}

interface PreferenceRow extends Record<string, unknown> {
  email: string | null;
  notification_preferences: StoredNotificationPreferences | null;
}

interface PublicationFailureRow extends Record<string, unknown> {
  brand_profile_name: string;
  channel_name: string | null;
  error_message: string | null;
  failure_code: string | null;
  platform: string;
  post_id: string;
  post_title: string;
  post_text: string;
}

/** Maximum delivery attempts before a notification is retained as dead. */
const maximumDeliveryAttempts = 5;

/** Classifies notification payloads without trusting arbitrary queue contents. */
function notificationPayload(value: Record<string, unknown>): NotificationPayload | null {
  const kind = value.kind;
  const deliveryKey = value.delivery_key;
  const aggregateId = value.aggregate_id;
  const platform = value.platform;
  if (
    value.version !== 1 ||
    (kind !== "publication_failed" && kind !== "channel_disconnected") ||
    typeof deliveryKey !== "string" ||
    deliveryKey.length === 0 ||
    deliveryKey.length > 300 ||
    typeof aggregateId !== "string" ||
    typeof platform !== "string"
  ) {
    return null;
  }
  return {
    aggregate_id: aggregateId,
    delivery_key: deliveryKey,
    kind,
    platform,
    version: 1,
    ...(typeof value.brand_profile_id === "string"
      ? { brand_profile_id: value.brand_profile_id }
      : {}),
    ...(typeof value.channel_name === "string" || value.channel_name === null
      ? { channel_name: value.channel_name }
      : {}),
    ...(typeof value.connection_status === "string"
      ? { connection_status: value.connection_status }
      : {}),
    ...(typeof value.distribution_id === "string"
      ? { distribution_id: value.distribution_id }
      : {}),
    ...(typeof value.post_id === "string" ? { post_id: value.post_id } : {}),
  };
}

/** Resolves the single Installation Owner's current delivery address. */
function ownerEmailEffect(env: AutomationEnv, organizationId: string) {
  return withSystemTransactionEffect(env, (client) =>
    client.query<PreferenceRow>(
      `SELECT owner.email, preferences.notification_preferences
         FROM organizations organization
         JOIN LATERAL (
           SELECT email FROM users
            WHERE installation_owner = true AND suspended_at IS NULL
            ORDER BY created_at, id LIMIT 1
         ) AS owner ON true
         LEFT JOIN publishing_preferences preferences ON preferences.org_id = organization.id
        WHERE organization.id = $1`,
      [organizationId],
    ),
  );
}

/** Loads the Post/Channel context for a terminal publication failure. */
function failureContextEffect(env: AutomationEnv, organizationId: string, distributionId: string) {
  return withSystemTransactionEffect(env, (client) =>
    client.query<PublicationFailureRow>(
      `SELECT distribution.platform, distribution.failure_code,
              distribution.error_message, distribution.post_id,
              post.title AS post_title, post.default_text AS post_text,
              profile.name AS brand_profile_name,
              account.display_name AS channel_name
         FROM distributions AS distribution
         JOIN posts AS post ON post.id = distribution.post_id
         JOIN brand_profiles AS profile ON profile.id = distribution.brand_profile_id
         LEFT JOIN platform_accounts AS account ON account.id = distribution.platform_account_id
        WHERE distribution.id = $1 AND distribution.org_id = $2`,
      [distributionId, organizationId],
    ),
  );
}

/** One rendered email body, ready for the Cloudflare Email Sending binding. */
interface NotificationEmail {
  html: string;
  subject: string;
  text: string;
}

/**
 * Renders the owner-facing message for one supported event. Every field is
 * bounded and HTML-escaped, and no token, header, or content beyond the Post's
 * own title/body and failure reason reaches the message.
 */
function renderEmail(
  env: AutomationEnv,
  kind: NotificationKind,
  context: {
    brandProfileName?: string;
    channelName?: string | null;
    connectionStatus?: string;
    errorMessage?: string | null;
    failureCode?: string | null;
    platform: string;
    postId?: string;
    postTitle?: string;
    postText?: string;
  },
): NotificationEmail {
  const appUrl = env.APP_URL?.replace(/\/+$/, "") ?? "";
  const profile = context.brandProfileName ? ` in ${context.brandProfileName}` : "";
  if (kind === "publication_failed") {
    const title = context.postTitle?.trim() || context.postText?.trim() || "Untitled Post";
    const link = context.postId
      ? `${appUrl}/posts?post=${encodeURIComponent(context.postId)}`
      : appUrl;
    const reason =
      context.errorMessage?.trim() || context.failureCode || "The Provider rejected it";
    const text = [
      `A publication failed${profile}.`,
      "",
      `Post: ${title}`,
      `Platform: ${context.platform}`,
      `Channel: ${context.channelName ?? "unknown"}`,
      `Reason: ${reason}`,
      "",
      link ? `Review the Post: ${link}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return {
      html: `<p>A publication failed${escapeMailHtml(profile)}.</p><ul><li><strong>Post:</strong> ${escapeMailHtml(title)}</li><li><strong>Platform:</strong> ${escapeMailHtml(context.platform)}</li><li><strong>Channel:</strong> ${escapeMailHtml(context.channelName ?? "unknown")}</li><li><strong>Reason:</strong> ${escapeMailHtml(reason)}</li></ul>${link ? `<p><a href="${escapeMailHtml(link)}">Review the Post</a></p>` : ""}`,
      subject: `Publication failed for ${title}`,
      text,
    };
  }
  const status = context.connectionStatus ?? "disconnected";
  const link = `${appUrl}/channels`;
  const text = [
    `A connected ${context.platform} channel${profile} needs attention (${status}).`,
    "",
    `Channel: ${context.channelName ?? "unknown"}`,
    "Reconnect it before scheduling more Posts.",
    link ? `Open Channels: ${link}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    html: `<p>A connected ${escapeMailHtml(context.platform)} channel${escapeMailHtml(profile)} needs attention (${escapeMailHtml(status)}).</p><ul><li><strong>Channel:</strong> ${escapeMailHtml(context.channelName ?? "unknown")}</li></ul><p>Reconnect it before scheduling more Posts.</p>${link ? `<p><a href="${escapeMailHtml(link)}">Open Channels</a></p>` : ""}`,
    subject: `${context.platform} channel needs reconnecting`,
    text,
  };
}

/** Submits one message through the Cloudflare Email Sending binding exactly once. */
async function submitMail(env: AutomationEnv, email: NotificationEmail, recipient: string) {
  const sender = env.MAIL_FROM_ADDRESS?.trim();
  if (
    typeof env.MAIL?.send !== "function" ||
    sender === undefined ||
    !isMailSenderAddress(sender)
  ) {
    throw new RetryableJobError({
      cause: "notification_mail_unavailable",
      message: "Notification email delivery is not configured.",
    });
  }
  const name = env.MAIL_FROM_NAME?.trim();
  const from = name ? { email: sender, name } : sender;
  const result = await env.MAIL.send({
    from,
    html: email.html,
    subject: email.subject,
    text: email.text,
    to: recipient,
  });
  if (!result || typeof result.messageId !== "string" || result.messageId.length === 0) {
    throw new RetryableJobError({
      cause: "notification_mail_ambiguous",
      message: "Notification email submission did not return an accepted message id.",
    });
  }
}

/**
 * Processes one durable notification outbox message.
 *
 * The outbox row was written in the same transaction as the failure or
 * disconnection, so a lost Queue message is retried by the relay. Delivery
 * evidence is keyed by the payload's delivery key: a redelivery observes the
 * terminal state and acks without sending again, while transient mail failures
 * leave `failed` with a bounded attempt count. Disabled preferences and an
 * unavailable mail channel are recorded as skipped, never sent.
 *
 * @param env - Automation bindings including the Email Sending binding.
 * @param message - Validated outbox message carrying a notification payload.
 * @returns Effect resolving "processed" after delivery, or "skipped" when the
 *   event is disabled, already terminal, or exhausted.
 */
export function processNotificationMessage(
  env: AutomationEnv,
  message: OutboxMessage,
): Effect.Effect<"processed" | "skipped", AutomationJobError> {
  return Effect.gen(function* () {
    const payload = notificationPayload(message.payload);
    if (!payload) {
      return yield* Effect.fail(
        new TerminalJobError({
          code: "notification_payload_invalid",
          message: "notification message payload is malformed",
        }),
      );
    }
    const preferences = yield* ownerEmailEffect(env, message.organization_id).pipe(
      Effect.mapError(
        () =>
          new RetryableJobError({
            cause: "notification_preferences_unavailable",
            message: "Notification preferences could not be read.",
          }),
      ),
    );
    const preference = preferences.rows[0];
    const email = preference?.email ?? null;
    const channels = preference?.notification_preferences?.channels;
    const events = preference?.notification_preferences?.events;
    const enabled =
      payload.kind === "publication_failed"
        ? events?.publication_failed === true
        : events?.channel_disconnected === true;

    const delivery = yield* withSystemTransactionEffect(env, (client) =>
      client.query<DeliveryRow>(
        `INSERT INTO notification_deliveries
           (org_id, dedupe_key, kind, aggregate_type, aggregate_id, state, attempt_count)
         VALUES ($1, $2, $3, $4, $5, 'pending', 0)
         ON CONFLICT (org_id, dedupe_key) DO UPDATE
           SET attempt_count = notification_deliveries.attempt_count + 1,
               updated_at = now()
         RETURNING id, state, attempt_count`,
        [
          message.organization_id,
          payload.delivery_key,
          payload.kind,
          payload.kind === "publication_failed" ? "distribution" : "platform_account",
          payload.aggregate_id,
        ],
      ),
    );
    const row = delivery.rows[0];
    if (!row || ["delivered", "skipped", "dead"].includes(row.state)) return "skipped" as const;

    if (!enabled || channels?.email !== true || email === null) {
      yield* withSystemTransactionEffect(env, (client) =>
        client.query(
          `UPDATE notification_deliveries
              SET state = 'skipped',
                  last_error = $2,
                  updated_at = now()
            WHERE id = $1`,
          [
            row.id,
            !enabled
              ? "The owner disabled this notification event."
              : channels?.email !== true
                ? "The email channel is disabled."
                : "The Installation Owner has no delivery address.",
          ],
        ),
      );
      return "skipped" as const;
    }

    if (row.attempt_count >= maximumDeliveryAttempts) {
      yield* withSystemTransactionEffect(env, (client) =>
        client.query(
          `UPDATE notification_deliveries
              SET state = 'dead', next_attempt_at = NULL, updated_at = now()
            WHERE id = $1`,
          [row.id],
        ),
      );
      return "skipped" as const;
    }

    const context =
      payload.kind === "publication_failed"
        ? yield* failureContextEffect(env, message.organization_id, payload.aggregate_id).pipe(
            Effect.mapError(
              () =>
                new RetryableJobError({
                  cause: "notification_context_unavailable",
                  message: "Publication context could not be read.",
                }),
            ),
          )
        : null;
    const failure = context?.rows[0];
    const emailBody = renderEmail(env, payload.kind, {
      brandProfileName: failure?.brand_profile_name,
      channelName: failure?.channel_name ?? payload.channel_name ?? null,
      connectionStatus: payload.connection_status,
      errorMessage: failure?.error_message,
      failureCode: failure?.failure_code,
      platform: failure?.platform ?? payload.platform,
      postId: failure?.post_id ?? payload.post_id,
      postText: failure?.post_text,
      postTitle: failure?.post_title,
    });

    yield* withSystemTransactionEffect(env, (client) =>
      client.query(
        `UPDATE notification_deliveries
            SET state = 'sending', next_attempt_at = now() + interval '5 minutes', updated_at = now()
          WHERE id = $1`,
        [row.id],
      ),
    );

    const sent = yield* Effect.tryPromise({
      catch: (cause) =>
        cause instanceof RetryableJobError
          ? cause
          : new RetryableJobError({
              cause: "notification_send_failed",
              message: safeErrorMessage(cause, "Notification email delivery failed."),
            }),
      try: () => submitMail(env, emailBody, email),
    }).pipe(Effect.exit);

    if (sent._tag === "Failure") {
      const cause = sent.cause;
      const messageText = safeErrorMessage(cause, "Notification email delivery failed.");
      yield* withSystemTransactionEffect(env, (client) =>
        client.query(
          `UPDATE notification_deliveries
              SET state = 'failed', last_error = $2, next_attempt_at = now(),
                  updated_at = now()
            WHERE id = $1`,
          [row.id, messageText],
        ),
      );
      return yield* Effect.fail(
        cause instanceof RetryableJobError
          ? cause
          : new RetryableJobError({
              cause: "notification_send_failed",
              message: messageText,
            }),
      );
    }

    yield* withSystemTransactionEffect(env, (client) =>
      client.query(
        `UPDATE notification_deliveries
            SET state = 'delivered', delivered_at = now(), last_error = NULL,
                next_attempt_at = NULL, updated_at = now()
          WHERE id = $1`,
        [row.id],
      ),
    );
    return "processed" as const;
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof RetryableJobError || cause instanceof TerminalJobError
        ? cause
        : new RetryableJobError({
            cause: "notification_processing_failed",
            message: safeErrorMessage(cause, "Notification delivery failed."),
          }),
    ),
  );
}
