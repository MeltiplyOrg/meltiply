import type { components } from "@meltiply/contracts/schema";
import { isoDateTime } from "@meltiply/domain";

import { CoreApiError } from "./core-types";
import type { QueueConfiguration } from "./validation";

type Schemas = components["schemas"];

export type PublishingQueue = Schemas["PublishingQueue"];
export type QueueMembership = Schemas["QueueMembership"];

export interface QueueRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  brand_profile_id: string;
  name: string;
  timezone: string;
  slots: PublishingQueue["slots"];
  created_at: Date | string;
  updated_at: Date | string;
}

export type QueueOwner = Pick<QueueRow, "brand_profile_id" | "org_id">;

export type QueueMutationInput = Pick<QueueConfiguration, "brand_profile_id"> &
  Partial<Omit<QueueConfiguration, "brand_profile_id">>;

export interface QueueMembershipRow extends Record<string, unknown> {
  assigned_at: Date | string;
  queue_id: string;
  queue_name: string;
}

export interface QueuedDistribution extends Record<string, unknown> {
  id: string;
  owned: boolean;
  status: Schemas["DistributionStatus"];
}

export function mapQueue(row: QueueRow): PublishingQueue {
  return {
    id: row.id,
    brand_profile_id: row.brand_profile_id,
    name: row.name,
    timezone: row.timezone,
    slots: row.slots,
    created_at: isoDateTime(row.created_at),
    updated_at: isoDateTime(row.updated_at),
  };
}

export function mapQueueMembership(row: QueueMembershipRow | undefined): QueueMembership | null {
  return row
    ? {
        queue_id: row.queue_id,
        queue_name: row.queue_name,
        assigned_at: isoDateTime(row.assigned_at),
      }
    : null;
}

export const queueNotFound = () =>
  new CoreApiError(404, "not_found", "The Queue was not found in this Brand Profile.");

export function isQueueInScope<Row extends QueueOwner>(
  row: Row | null | undefined,
  brandProfileId: string | undefined,
): row is Row {
  return (
    row !== null &&
    row !== undefined &&
    (brandProfileId === undefined || row.brand_profile_id === brandProfileId)
  );
}

export type ReservationDecision =
  | { kind: "reserve" }
  | { kind: "reuse"; assignedAt: Date }
  | { kind: "reject"; error: CoreApiError };

export function reservationDecision(
  membership: QueueMembership | null,
  queueId: string,
  now: Date,
): ReservationDecision {
  if (!membership) return { kind: "reserve" };
  const assignedAt = new Date(membership.assigned_at);
  if (membership.queue_id === queueId && assignedAt.getTime() > now.getTime()) {
    return { kind: "reuse", assignedAt };
  }
  return {
    kind: "reject",
    error: new CoreApiError(
      409,
      "queue_membership_exists",
      "Remove this Post from its Queue before changing plans or reusing an elapsed reservation.",
    ),
  };
}

export function queuePage(
  rows: readonly PublishingQueue[],
  limit: number,
): Schemas["QueueListResponse"] {
  const items = rows.slice(0, limit);
  return {
    items,
    next_cursor: rows.length > limit ? items[items.length - 1]!.id : null,
  };
}

export function queueChanges(
  current: Pick<QueueRow, "name" | "slots" | "timezone">,
  input: QueueMutationInput,
): Pick<QueueRow, "name" | "slots" | "timezone"> {
  return {
    name: input.name ?? current.name,
    timezone: input.timezone ?? current.timezone,
    slots: input.slots ?? current.slots,
  };
}

export function queueConfigurationRoleError(role: string | null): CoreApiError | null {
  return role === "admin"
    ? null
    : new CoreApiError(
        403,
        "workspace_admin_required",
        "Only Workspace Admins can configure Queues.",
      );
}

export function queueRemovalRoleError(role: string | null): CoreApiError | null {
  return role === "admin" || role === "editor"
    ? null
    : new CoreApiError(403, "forbidden_role", "Your Workspace role is read-only.");
}

export function queueRemovalError(
  outcomes: readonly QueuedDistribution[],
  isPending: (status: Schemas["DistributionStatus"]) => boolean,
): CoreApiError | null {
  return outcomes.some((row) => row.owned || !(isPending(row.status) || row.status === "cancelled"))
    ? new CoreApiError(
        409,
        "queue_post_in_flight",
        "Only unclaimed pending Posts can be removed. Provider-owned outcomes remain unchanged.",
      )
    : null;
}
