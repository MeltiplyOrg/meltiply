import { randomUUID } from "node:crypto";

import { database, type Tenant } from "./tenant-harness";

export async function seedProfile(tenant: Tenant, deleted = false): Promise<string> {
  const result = await database().query<{ id: string }>(
    `INSERT INTO brand_profiles (org_id, name, color, deleted_at, purge_at)
     VALUES ($1, $2, '#b91c1c', $3::timestamptz, $3::timestamptz + interval '30 days')
     RETURNING id`,
    [tenant.organizationId, randomUUID(), deleted ? new Date().toISOString() : null],
  );
  return result.rows[0]!.id;
}

export async function seedPost(tenant: Tenant, brandProfileId: string): Promise<string> {
  const result = await database().query<{ id: string }>(
    `INSERT INTO posts (org_id, brand_profile_id, title, default_text, status)
     VALUES ($1, $2, 'Round trip', 'Caption', 'active') RETURNING id`,
    [tenant.organizationId, brandProfileId],
  );
  return result.rows[0]!.id;
}

export async function seedMembership(
  tenant: Tenant,
  brandProfileId: string,
  queueId: string,
  postId: string,
  assignedAt = "2030-01-07T09:00:00.000Z",
): Promise<void> {
  await database().query(
    `INSERT INTO publishing_queue_memberships
       (org_id, brand_profile_id, queue_id, post_id, queue_name, assigned_at)
     VALUES ($1, $2, $3, $4, 'Weekly', $5)`,
    [tenant.organizationId, brandProfileId, queueId, postId, assignedAt],
  );
}

export async function seedDistribution(
  tenant: Tenant,
  brandProfileId: string,
  postId: string,
  status: string,
  claim = "",
): Promise<string> {
  const result = await database().query<{ id: string }>(
    `INSERT INTO distributions (org_id, brand_profile_id, post_id, platform, status, attachment_ids)
     VALUES ($1, $2, $3, 'threads', $4, ARRAY[]::uuid[]) RETURNING id`,
    [tenant.organizationId, brandProfileId, postId, status],
  );
  const { id } = result.rows[0]!;
  if (claim) await database().query(`UPDATE distributions SET ${claim} WHERE id = $1`, [id]);
  return id;
}

export async function seedPublishCommand(
  tenant: Tenant,
  distributionId: string,
  state: string,
): Promise<void> {
  await database().query(
    `INSERT INTO outbox_events (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload, state)
     VALUES ($1, 'distribution.publish.requested', 'distribution', $2, $3, '{}'::jsonb, $4)`,
    [tenant.organizationId, distributionId, randomUUID(), state],
  );
}
