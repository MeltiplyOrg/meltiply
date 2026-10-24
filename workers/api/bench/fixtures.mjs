// Deterministic dataset for the backend benchmark. Every row lives inside one
// fixed benchmark Workspace, so cleanup is a single organization delete plus the
// per-scenario rows created by mutations. SQL is parameterized; fixture helpers
// run on the privileged admin connection and are never timed.
import { randomUUID } from "node:crypto";

export const ids = {
  asset: (index) => `a1000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  brandProfile: "b4000000-0000-4000-8000-000000000001",
  comment: (index) => `c9000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  distribution: (index) => `d1000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  member: "b3000000-0000-4000-8000-000000000001",
  org: "b2000000-0000-4000-8000-000000000001",
  post: (index) => `c0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  schedulePost: (index) => `c2000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  snapshot: (index) => `e1000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  threadAccount: (index) => `b6000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  uploadAsset: "a2000000-0000-4000-8000-000000000001",
  uploadSession: "f0000000-0000-4000-8000-000000000001",
  usage: "b9000000-0000-4000-8000-000000000001",
  user: "b1000000-0000-4000-8000-000000000001",
  youtubeAccount: (index) => `b5000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
};

export const dataset = {
  assets: 300,
  comments: 100,
  distributionLimit: 100,
  pageSize: 100,
  posts: 300,
  scheduleChannels: process.env.BENCHMARK_PROFILE === "read-cache" ? 1 : 20,
  schedulePosts: 42,
};

const authUserId = "auth_user_benchmark";
const benchmarkEmail = "benchmark@meltiply.local";

/** Removes every row the benchmark owns; the organization cascade covers most tables. */
export async function cleanup(client) {
  await client.query(`DELETE FROM "user" WHERE id = $1`, [authUserId]);
  await client.query("DELETE FROM organizations WHERE id = $1", [ids.org]);
  await client.query("DELETE FROM users WHERE id = $1", [ids.user]);
  // Idempotency keys and outbox events for soft-deleted fixture Posts have no
  // FK to Posts; remove the prefixes that mutations create.
  await client.query("DELETE FROM idempotency_keys WHERE org_id = $1", [ids.org]);
  await client.query("DELETE FROM outbox_events WHERE org_id = $1", [ids.org]);
}

/** Seeds the fixed Workspace, Brand Profile, Channels, and read-heavy dataset. */
export async function seed(client) {
  await cleanup(client);
  await client.query(
    `INSERT INTO "user" (id, name, email, "emailVerified")
     VALUES ($1, 'Benchmark User', $2, TRUE)`,
    [authUserId, benchmarkEmail],
  );
  await client.query(
    `INSERT INTO users (id, auth_user_id, email, display_name)
     VALUES ($1, $2, $3, 'Benchmark User')`,
    [ids.user, authUserId, benchmarkEmail],
  );
  await client.query(
    `INSERT INTO organizations (id, name, slug, plan, billing_status)
     VALUES ($1, 'Benchmark Studio', 'benchmark-studio', 'agency', 'active')`,
    [ids.org],
  );
  await client.query(
    `INSERT INTO org_members (id, org_id, user_id, role)
     VALUES ($1, $2, $3, 'admin')`,
    [ids.member, ids.org, ids.user],
  );
  await client.query(
    `INSERT INTO brand_profiles (id, org_id, name, color)
     VALUES ($1, $2, 'Benchmark Brand', '#1d4ed8')`,
    [ids.brandProfile, ids.org],
  );
  await client.query(
    `INSERT INTO platform_accounts
       (id, org_id, brand_profile_id, platform, platform_user_id,
        display_name, access_token, scopes, metadata)
     SELECT
       ('b5000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
       $1::uuid, $2::uuid, 'youtube', 'benchmark-youtube-' || item,
       'Benchmark YouTube ' || item, 'benchmark-token-youtube-' || item,
       ARRAY['upload'], '{"fixture": true}'::jsonb
     FROM generate_series(1, $3::integer) AS item`,
    [ids.org, ids.brandProfile, dataset.scheduleChannels],
  );
  await client.query(
    `INSERT INTO platform_accounts
       (id, org_id, brand_profile_id, platform, platform_user_id,
        display_name, access_token, scopes, metadata)
     SELECT
       ('b6000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
       $1::uuid, $2::uuid, 'threads', 'benchmark-threads-' || item,
       'Benchmark Threads ' || item, 'benchmark-token-threads-' || item,
       ARRAY['upload'], '{"fixture": true}'::jsonb
     FROM generate_series(1, $3::integer) AS item`,
    [ids.org, ids.brandProfile, dataset.scheduleChannels],
  );
  await client.query(
    `INSERT INTO assets
       (id, org_id, brand_profile_id, uploaded_by, asset_type, title, status,
        file_size, mime_type, original_filename, created_at)
     VALUES ($1, $2, $3, $4, 'image', 'Benchmark upload session asset',
             'pending_upload', 1024, 'image/png', 'benchmark-upload.png', now())`,
    [ids.uploadAsset, ids.org, ids.brandProfile, ids.user],
  );
  await client.query(
    `INSERT INTO asset_upload_sessions
       (id, org_id, asset_id, uploaded_by, strategy, status, content_type,
        file_size, object_key, expires_at)
     VALUES ($1, $2, $3, $4, 'single', 'created', 'image/png', 1024,
             'benchmark/upload-session-object', now() + INTERVAL '1 day')`,
    [ids.uploadSession, ids.org, ids.uploadAsset, ids.user],
  );
  await client.query(
    `INSERT INTO usage_records (id, org_id, period, uploads, distributions, api_calls, storage_bytes)
     VALUES ($1, $2, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'), 0, 0, 0, 0)`,
    [ids.usage, ids.org],
  );
  await client.query(
    `INSERT INTO assets
       (id, org_id, brand_profile_id, uploaded_by, asset_type, title, status,
        file_size, mime_type, width, height, created_at, finalized_at)
     SELECT
       ('a1000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
       $1::uuid, $2::uuid, $3::uuid, 'image', 'Benchmark asset ' || item, 'ready',
       1024, 'image/png', 1080, 1080,
       TIMESTAMP '2026-01-01 00:00:00+00' + item * INTERVAL '1 minute',
       TIMESTAMP '2026-01-01 00:00:00+00' + item * INTERVAL '1 minute'
     FROM generate_series(1, $4::integer) AS item`,
    [ids.org, ids.brandProfile, ids.user, dataset.assets],
  );
  await client.query(
    `INSERT INTO posts
       (id, org_id, brand_profile_id, title, default_text, status, created_at, updated_at)
     SELECT
       ('c0000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
       $1::uuid, $2::uuid, 'Benchmark post ' || item, 'Benchmark body ' || item,
       'active',
       TIMESTAMP '2026-07-18 11:00:00+00' + item * INTERVAL '1 second',
       TIMESTAMP '2026-07-18 11:00:00+00' + item * INTERVAL '1 second'
     FROM generate_series(1, $3::integer) AS item`,
    [ids.org, ids.brandProfile, dataset.posts],
  );
  await client.query(
    `INSERT INTO post_attachments (post_id, asset_id, org_id, brand_profile_id, position)
     SELECT
       ('c0000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
       ('a1000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
       $1::uuid, $2::uuid, 0
     FROM generate_series(1, $3::integer) AS item`,
    [ids.org, ids.brandProfile, dataset.assets],
  );
  await client.query(
    `INSERT INTO distributions
       (id, org_id, brand_profile_id, post_id, platform_account_id, platform,
        status, published_at, platform_post_id, platform_url, title_override, created_at)
     SELECT
       ('d1000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
       $1::uuid, $2::uuid,
       ('c0000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
       CASE WHEN item % 2 = 0
         THEN ('b5000000-0000-4000-8000-' || lpad(((item % $4::integer) + 1)::text, 12, '0'))::uuid
         ELSE ('b6000000-0000-4000-8000-' || lpad(((item % $4::integer) + 1)::text, 12, '0'))::uuid
       END,
       CASE WHEN item % 2 = 0 THEN 'youtube' ELSE 'threads' END,
       'published',
       TIMESTAMP '2026-07-01 00:00:00+00' + item * INTERVAL '1 hour',
       'benchmark-published-' || item,
       'https://example.invalid/benchmark/' || item,
       'Benchmark publication ' || item,
       TIMESTAMP '2026-07-01 00:00:00+00' + item * INTERVAL '1 hour'
     FROM generate_series(1, $3::integer) AS item`,
    [ids.org, ids.brandProfile, dataset.posts, dataset.scheduleChannels],
  );
  await client.query(
    `INSERT INTO analytics_snapshots
       (id, distribution_id, org_id, views, likes, comments, shares,
        watch_time_sec, reach, impressions, snapshot_at)
     SELECT
       ('e1000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
       ('d1000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
       $1::uuid, item, item, item, item, item, item, item,
       TIMESTAMP '2026-07-02 00:00:00+00' + item * INTERVAL '1 hour'
     FROM generate_series(1, $2::integer) AS item`,
    [ids.org, dataset.assets],
  );
  await client.query(
    `INSERT INTO comments
       (id, distribution_id, org_id, platform_comment_id, author_name, body,
        replied, reply_status, commented_at)
     SELECT
       ('c9000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
       ('d1000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
       $1::uuid, 'benchmark-comment-' || item, 'Benchmark Viewer',
       'Benchmark comment ' || item, false, 'none',
       TIMESTAMP '2026-07-18 12:30:00+00' + item * INTERVAL '1 second'
     FROM generate_series(1, $2::integer) AS item`,
    [ids.org, dataset.comments],
  );
  await client.query(
    `INSERT INTO posts
       (id, org_id, brand_profile_id, title, default_text, status)
     SELECT
       ('c2000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
       $1::uuid, $2::uuid, 'Benchmark schedule post ' || item,
       'Benchmark schedule body ' || item, 'draft'
     FROM generate_series(1, $3::integer) AS item`,
    [ids.org, ids.brandProfile, dataset.schedulePosts],
  );
  await client.query(
    `INSERT INTO post_targets
       (post_id, platform_account_id, org_id, brand_profile_id, title_override)
     SELECT
       ('c2000000-0000-4000-8000-' || lpad(post_item::text, 12, '0'))::uuid,
       ('b6000000-0000-4000-8000-' || lpad(account_item::text, 12, '0'))::uuid,
       $1::uuid, $2::uuid, 'Benchmark target'
     FROM generate_series(1, $3::integer) AS post_item
     CROSS JOIN generate_series(1, $4::integer) AS account_item`,
    [ids.org, ids.brandProfile, dataset.schedulePosts, dataset.scheduleChannels],
  );
  // Freshly inserted fixtures have no column statistics until autovacuum
  // reaches them. Refresh them deterministically before measurement so the
  // planner sees the same row counts in every repetition.
  await client.query(
    `ANALYZE assets, posts, post_attachments, post_targets, distributions,
             analytics_snapshots, comments, platform_accounts`,
  );
}

/** Restores the monthly usage headroom mutation scenarios consume. */
export async function resetUsage(client) {
  await client.query(
    `UPDATE usage_records
        SET uploads = 0, distributions = 0, api_calls = 0
      WHERE org_id = $1 AND period = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')`,
    [ids.org],
  );
}

/** Removes rows a previous mutation sample created, before the next one is timed. */
export async function cleanupMutatedRows(client) {
  await client.query(`DELETE FROM posts WHERE org_id = $1 AND title LIKE 'benchmark-create-%'`, [
    ids.org,
  ]);
  await client.query(`DELETE FROM assets WHERE org_id = $1 AND title LIKE 'benchmark-upload-%'`, [
    ids.org,
  ]);
  await client.query(
    `DELETE FROM asset_upload_sessions WHERE org_id = $1 AND asset_id NOT IN (SELECT id FROM assets)`,
    [ids.org],
  );
  await client.query(`DELETE FROM idempotency_keys WHERE org_id = $1`, [ids.org]);
  await resetUsage(client);
}

/**
 * Creates one deletable batch: each Post owns one Asset attachment, two
 * scheduled Distributions with pending outbox commands, and one published
 * Distribution that deletion must leave untouched.
 *
 * @param client - Privileged fixture connection.
 * @param tag - Unique batch/sample marker embedded in titles and dedupe keys.
 * @param size - Number of Posts to create.
 * @returns The created Post ids.
 */
export async function seedDeleteBatch(client, tag, size) {
  const postIds = [];
  const rows = [];
  for (let index = 0; index < size; index += 1) {
    const postId = randomUUID();
    const assetId = randomUUID();
    postIds.push(postId);
    rows.push({
      assetId,
      postId,
      suffix: `${tag}-${index}`,
    });
  }

  for (const row of rows) {
    await client.query(
      `INSERT INTO assets
         (id, org_id, brand_profile_id, uploaded_by, asset_type, title, status,
          file_size, mime_type, width, height, created_at, finalized_at)
       VALUES ($1, $2, $3, $4, 'image', $5, 'ready', 1024, 'image/png', 1080, 1080, now(), now())`,
      [row.assetId, ids.org, ids.brandProfile, ids.user, `benchmark-delete-asset-${row.suffix}`],
    );
    await client.query(
      `INSERT INTO posts
         (id, org_id, brand_profile_id, title, default_text, status)
       VALUES ($1, $2, $3, $4, 'Benchmark delete body', 'active')`,
      [row.postId, ids.org, ids.brandProfile, `benchmark-delete-${row.suffix}`],
    );
    await client.query(
      `INSERT INTO post_attachments (post_id, asset_id, org_id, brand_profile_id, position)
       VALUES ($1, $2, $3, $4, 0)`,
      [row.postId, row.assetId, ids.org, ids.brandProfile],
    );
    await client.query(
      `INSERT INTO post_targets (post_id, platform_account_id, org_id, brand_profile_id)
       VALUES ($1, $2, $3, $4), ($1, $5, $3, $4)`,
      [row.postId, ids.youtubeAccount(1), ids.org, ids.brandProfile, ids.youtubeAccount(2)],
    );
    const scheduled = [randomUUID(), randomUUID()];
    for (const [index, distributionId] of scheduled.entries()) {
      await client.query(
        `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform_account_id, platform,
            status, scheduled_at, created_at)
         VALUES ($1, $2, $3, $4, $5, 'youtube', 'scheduled', now() + INTERVAL '1 day', now())`,
        [distributionId, ids.org, ids.brandProfile, row.postId, ids.youtubeAccount(index + 1)],
      );
      await client.query(
        `INSERT INTO outbox_events
           (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload, state)
         VALUES ($1, 'distribution.publish.requested', 'distribution', $2, $3, '{}'::jsonb, 'pending')`,
        [ids.org, distributionId, `benchmark-delete-${distributionId}`],
      );
    }
    await client.query(
      `INSERT INTO distributions
         (id, org_id, brand_profile_id, post_id, platform_account_id, platform,
          status, published_at, platform_post_id, platform_url, created_at)
       VALUES ($1, $2, $3, $4, $5, 'youtube', 'published', now() - INTERVAL '1 day',
               $6, $7, now() - INTERVAL '2 days')`,
      [
        randomUUID(),
        ids.org,
        ids.brandProfile,
        row.postId,
        ids.youtubeAccount(3),
        `benchmark-keep-${row.suffix}`,
        `https://example.invalid/benchmark-keep/${row.suffix}`,
      ],
    );
  }
  return postIds;
}

/** Hard-deletes a batch after measurement; soft-deleted Posts would otherwise accumulate. */
export async function cleanupDeleteBatches(client) {
  await client.query(`DELETE FROM posts WHERE org_id = $1 AND title LIKE 'benchmark-delete-%'`, [
    ids.org,
  ]);
  await client.query(
    `DELETE FROM assets WHERE org_id = $1 AND title LIKE 'benchmark-delete-asset-%'`,
    [ids.org],
  );
  await client.query(`DELETE FROM idempotency_keys WHERE org_id = $1`, [ids.org]);
  await client.query(`DELETE FROM outbox_events WHERE org_id = $1`, [ids.org]);
}
