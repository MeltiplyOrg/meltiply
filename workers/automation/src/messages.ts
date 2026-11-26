import { isUuid } from "@meltiply/domain";

export interface OutboxMessage {
  attempt?: number;
  aggregate_id: string;
  event_id: string;
  organization_id: string;
  payload: Record<string, unknown>;
  topic: string;
  type: "outbox.event";
  version: 1;
  request_id?: string | null;
}

export type NotificationKind = "publication_failed" | "channel_disconnected";

export interface NotificationPayload {
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

export interface ReplyWorkflowPayload {
  comment_id: string;
  event_id: string;
  organization_id: string;
  request_id?: string | null;
  type: "reply.workflow";
  version: 1;
}

export type ProviderSyncWorkload = "analytics" | "comments" | "token_refresh";

export interface ProviderSyncMessage {
  event_id: string;
  request_id: string;
  target_id: string;
  type: "provider.sync";
  version: 1;
  workload: ProviderSyncWorkload;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function sanitizeNotificationPayload(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(typeof value.delivery_key === "string" ? { delivery_key: value.delivery_key } : {}),
    ...(typeof value.kind === "string" ? { kind: value.kind } : {}),
    ...(typeof value.aggregate_id === "string" ? { aggregate_id: value.aggregate_id } : {}),
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
    ...(typeof value.platform === "string" ? { platform: value.platform } : {}),
    ...(typeof value.post_id === "string" ? { post_id: value.post_id } : {}),
    version: 1,
  };
}

export function parseNotificationPayload(
  value: Record<string, unknown>,
): NotificationPayload | null {
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
    ...sanitizeNotificationPayload(value),
    aggregate_id: aggregateId,
    delivery_key: deliveryKey,
    kind,
    platform,
    version: 1,
  };
}

export function isOutboxMessage(value: unknown): value is OutboxMessage {
  if (!record(value) || !record(value.payload)) return false;
  return (
    value.type === "outbox.event" &&
    value.version === 1 &&
    typeof value.event_id === "string" &&
    typeof value.organization_id === "string" &&
    typeof value.aggregate_id === "string" &&
    typeof value.topic === "string"
  );
}

export function isReplyWorkflowPayload(value: unknown): value is ReplyWorkflowPayload {
  if (!record(value)) return false;
  return (
    value.type === "reply.workflow" &&
    value.version === 1 &&
    typeof value.comment_id === "string" &&
    typeof value.event_id === "string" &&
    typeof value.organization_id === "string" &&
    (value.request_id === undefined ||
      value.request_id === null ||
      typeof value.request_id === "string")
  );
}

export function isProviderSyncMessage(value: unknown): value is ProviderSyncMessage {
  if (!record(value)) return false;
  return (
    value.type === "provider.sync" &&
    value.version === 1 &&
    typeof value.workload === "string" &&
    ["analytics", "comments", "token_refresh"].includes(value.workload) &&
    isUuid(value.event_id) &&
    typeof value.request_id === "string" &&
    value.request_id.length > 0 &&
    value.request_id.length <= 255 &&
    isUuid(value.target_id)
  );
}

export function providerSyncMessage(
  workload: ProviderSyncWorkload,
  targetId: string,
  eventId: string,
): ProviderSyncMessage {
  return {
    event_id: eventId,
    request_id: eventId,
    target_id: targetId,
    type: "provider.sync",
    version: 1,
    workload,
  };
}

export function replyWorkflowPayload(message: OutboxMessage): ReplyWorkflowPayload {
  return {
    comment_id: message.aggregate_id,
    event_id: message.event_id,
    organization_id: message.organization_id,
    request_id: message.request_id,
    type: "reply.workflow",
    version: 1,
  };
}

export function replyWorkflowMessage(payload: ReplyWorkflowPayload): OutboxMessage {
  return {
    aggregate_id: payload.comment_id,
    event_id: payload.event_id,
    organization_id: payload.organization_id,
    payload: { comment_id: payload.comment_id },
    request_id: payload.request_id,
    topic: "comment.reply.requested",
    type: "outbox.event",
    version: 1,
  };
}
