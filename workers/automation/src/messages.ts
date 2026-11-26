const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function uuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
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
    ["analytics", "comments", "token_refresh"].includes(String(value.workload)) &&
    uuid(value.event_id) &&
    typeof value.request_id === "string" &&
    value.request_id.length > 0 &&
    value.request_id.length <= 255 &&
    uuid(value.target_id)
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
