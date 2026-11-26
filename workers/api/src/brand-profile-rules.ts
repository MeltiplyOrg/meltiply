import type { components } from "@meltiply/contracts/schema";
import { isoDateTime, type DatabaseError } from "@meltiply/domain";

import { CoreApiError } from "./core-types";

export type BrandProfile = components["schemas"]["BrandProfile"];

export interface BrandProfileRow extends Record<string, unknown> {
  color: string;
  created_at: Date | string;
  deleted_at: Date | string | null;
  description: string | null;
  id: string;
  name: string;
  org_id: string;
  purge_at: Date | string | null;
  updated_at: Date | string;
}

export interface DisconnectableAccountRow extends Record<string, unknown> {
  access_token: string;
  brand_profile_id: string;
  id: string;
  platform: string;
}

export type BrandProfileRetention = Pick<BrandProfileRow, "deleted_at" | "purge_at">;

export interface CreateBrandProfileInput {
  color: string;
  description?: string | null;
  name: string;
}

export interface UpdateBrandProfileInput {
  color?: string;
  description?: string | null;
  name?: string;
}

export function mapBrandProfile(row: BrandProfileRow): BrandProfile {
  return {
    color: row.color as BrandProfile["color"],
    created_at: isoDateTime(row.created_at),
    deleted_at: row.deleted_at === null ? null : isoDateTime(row.deleted_at),
    description: row.description,
    id: row.id,
    name: row.name,
    org_id: row.org_id,
    purge_at: row.purge_at === null ? null : isoDateTime(row.purge_at),
    updated_at: isoDateTime(row.updated_at),
  };
}

export function createBrandProfilePayload(input: CreateBrandProfileInput): string {
  return JSON.stringify({
    color: input.color,
    description: input.description ?? null,
    name: input.name,
  });
}

export function updateBrandProfilePayload(
  profileId: string,
  input: UpdateBrandProfileInput,
): string {
  return JSON.stringify({
    color: input.color ?? null,
    description: input.description ?? null,
    has_description: input.description !== undefined,
    name: input.name ?? null,
    profile_id: profileId,
  });
}

export function workspaceAdminError(role: string | null): CoreApiError | null {
  return role === "admin"
    ? null
    : new CoreApiError(403, "workspace_admin_required", "The workspace admin role is required.");
}

export function isUniqueViolation(error: DatabaseError): boolean {
  const cause = error.cause;
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "23505";
}

export function restoreError(row: BrandProfileRetention, now: Date): CoreApiError | null {
  if (row.deleted_at === null) {
    return new CoreApiError(409, "invalid_state", "The brand profile is not deleted.");
  }
  if (row.purge_at !== null && new Date(row.purge_at).getTime() <= now.getTime()) {
    return new CoreApiError(
      409,
      "invalid_state",
      "The brand profile retention window has elapsed.",
    );
  }
  return null;
}

export function channelRevocationEvent(account: DisconnectableAccountRow) {
  return {
    dedupeKey: `channel-revocation:${account.id}`,
    payload: {
      access_token: account.access_token,
      brand_profile_id: account.brand_profile_id,
      platform: account.platform,
      platform_account_id: account.id,
      version: 1,
    },
  };
}
