-- Local development fixtures for the Cloudflare-target PostgreSQL stack.
-- Idempotent: every statement upserts on a stable key so `database.sh seed`,
-- `database.sh reset`, and cold-volume initialization can all re-run it.
--
-- Two layers, deliberately kept in disjoint id ranges:
--   * Canonical fixtures in the team workspaces (orgs …0001/…0002) are a
--     test contract — packages/database/test/rls.integration.test.ts and
--   * Personal-workspace fixtures (orgs …0005/…0006; ids in the c/d/e/f/aa/bb
--     ranges) are the day-to-day demo set: the API activates the personal
--     workspace by default, so signing in shows populated UI immediately.
-- Post-owned media adds two more ranges: Posts are 4800… (…0001 is pinned by
-- the API integration suite) and the per-object storage inventory is
-- 4100…/4200… for objects and their renditions.
--
-- Only Alpha is the installation owner and can sign in through Better Auth:
--   alpha@meltiply.local / MeltiplyLocal1!   (rich personal workspace)
-- Beta remains a database-only RLS isolation fixture, never a second login.
-- The account.password value is a scrypt hash (N=16384, r=16, p=1, dkLen=64,
-- "<salt-hex>:<key-hex>") of MeltiplyLocal1! in the exact format Better Auth's
-- verifyPassword expects; it is a local-only fixture, never a real credential.

BEGIN;

-- Better Auth subjects backing the seeded internal users. The API worker and
-- RLS integration tests authenticate as these session subjects. Alpha is the
-- Installation Owner; Beta is a Workspace Admin; Gamma and Delta exercise the
-- Editor and Viewer roles.
INSERT INTO "user" (id, name, email, "emailVerified")
VALUES
  ('auth_user_local_alpha', 'Alpha Creator', 'alpha@meltiply.local', TRUE),
  ('auth_user_local_beta', 'Beta Admin', 'beta@meltiply.local', TRUE),
  ('auth_user_local_gamma', 'Gamma Editor', 'gamma@meltiply.local', TRUE),
  ('auth_user_local_delta', 'Delta Viewer', 'delta@meltiply.local', TRUE)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    email = EXCLUDED.email,
    "emailVerified" = EXCLUDED."emailVerified",
    "updatedAt" = now();

-- Credential accounts so the seeded users can sign in through the real
-- /sign-in UI instead of bypassing auth. accountId mirrors Better Auth's
-- convention of storing the user id for credential providers.
INSERT INTO "account" (id, "accountId", "providerId", "userId", password)
VALUES
  (
    'auth_account_local_alpha',
    'auth_user_local_alpha',
    'credential',
    'auth_user_local_alpha',
    '0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d:51ebb76380734dbeaa0619246752b97221ef1ebff0304296c848df2b68974f91a7c07a7d5f2abd36638784a22f8161967d2b7d089c2b5e1b4fe65d72f9977914'
  ),
  (
    'auth_account_local_beta',
    'auth_user_local_beta',
    'credential',
    'auth_user_local_beta',
    '0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d:51ebb76380734dbeaa0619246752b97221ef1ebff0304296c848df2b68974f91a7c07a7d5f2abd36638784a22f8161967d2b7d089c2b5e1b4fe65d72f9977914'
  ),
  (
    'auth_account_local_gamma',
    'auth_user_local_gamma',
    'credential',
    'auth_user_local_gamma',
    '0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d:51ebb76380734dbeaa0619246752b97221ef1ebff0304296c848df2b68974f91a7c07a7d5f2abd36638784a22f8161967d2b7d089c2b5e1b4fe65d72f9977914'
  ),
  (
    'auth_account_local_delta',
    'auth_user_local_delta',
    'credential',
    'auth_user_local_delta',
    '0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d:51ebb76380734dbeaa0619246752b97221ef1ebff0304296c848df2b68974f91a7c07a7d5f2abd36638784a22f8161967d2b7d089c2b5e1b4fe65d72f9977914'
  )
ON CONFLICT (id) DO UPDATE
SET "accountId" = EXCLUDED."accountId",
    "providerId" = EXCLUDED."providerId",
    password = EXCLUDED.password,
    "updatedAt" = now();

INSERT INTO users (id, auth_user_id, email, display_name, installation_owner)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'auth_user_local_alpha', 'alpha@meltiply.local', 'Alpha Creator', TRUE),
  ('10000000-0000-4000-8000-000000000002', 'auth_user_local_beta', 'beta@meltiply.local', 'Beta Admin', FALSE),
  ('10000000-0000-4000-8000-000000000003', 'auth_user_local_gamma', 'gamma@meltiply.local', 'Gamma Editor', FALSE),
  ('10000000-0000-4000-8000-000000000004', 'auth_user_local_delta', 'delta@meltiply.local', 'Delta Viewer', FALSE)
ON CONFLICT (id) DO UPDATE
SET auth_user_id = EXCLUDED.auth_user_id,
    email = EXCLUDED.email,
    display_name = EXCLUDED.display_name,
    updated_at = now();

UPDATE users
SET installation_owner = FALSE
WHERE installation_owner
  AND id <> '10000000-0000-4000-8000-000000000001';
UPDATE users
SET installation_owner = TRUE
WHERE id = '10000000-0000-4000-8000-000000000001';

INSERT INTO organizations (
  id, name, slug, plan, billing_status,
  billing_customer_id, renews_at, cancel_at, billing_event_at
)
VALUES
  ('20000000-0000-4000-8000-000000000001', 'Alpha Studio', 'alpha-studio', 'creator', 'free', NULL, NULL, NULL, NULL),
  ('20000000-0000-4000-8000-000000000002', 'Beta Studio', 'beta-studio', 'free', 'free', NULL, NULL, NULL, NULL)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    slug = EXCLUDED.slug,
    plan = EXCLUDED.plan,
    billing_status = EXCLUDED.billing_status,
    billing_customer_id = EXCLUDED.billing_customer_id,
    renews_at = EXCLUDED.renews_at,
    cancel_at = EXCLUDED.cancel_at,
    billing_event_at = EXCLUDED.billing_event_at,
    updated_at = now();

-- Exactly one shared Workspace. The deterministic id …0005 remains the
-- day-to-day demo workspace and now holds every seeded role.
UPDATE organizations
SET is_shared = FALSE
WHERE is_shared
  AND id <> '20000000-0000-4000-8000-000000000005';

INSERT INTO organizations (id, name, slug, plan, billing_status, is_shared)
VALUES
  (
    '20000000-0000-4000-8000-000000000005',
    'Alpha Creator''s workspace',
    'workspace-10000000000040008000000000000001',
    'creator',
    'free',
    TRUE
  ),
  (
    '20000000-0000-4000-8000-000000000006',
    'Beta Studio Archive',
    'workspace-10000000000040008000000000000002',
    'free',
    'free',
    FALSE
  )
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    slug = EXCLUDED.slug,
    plan = EXCLUDED.plan,
    billing_status = EXCLUDED.billing_status,
    updated_at = now();

INSERT INTO usage_reconciliation_state (org_id)
SELECT id
FROM organizations
ON CONFLICT (org_id) DO NOTHING;

INSERT INTO org_members (id, org_id, user_id, role)
VALUES
  ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'admin'),
  ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'admin'),
  ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', 'admin'),
  ('30000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000002', 'admin'),
  ('30000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000003', 'editor'),
  ('30000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000004', 'viewer')
ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role;

UPDATE organizations SET is_shared = TRUE
WHERE id = '20000000-0000-4000-8000-000000000005';

-- Brand Profiles are the mandatory ownership boundary for assets, platform
-- accounts, and distributions. The team-workspace profiles (a000…0001/0002)
-- are pinned by the integration tests; the c000… profiles belong to the
-- personal workspaces. Alpha's personal workspace gets two profiles so
-- profile switching shows real differences; colors come from the fixed
-- accessible palette enforced by brand_profiles_color_check.
INSERT INTO brand_profiles (id, org_id, name, color)
VALUES
  ('a0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Alpha Brand', '#1d4ed8'),
  ('a0000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'Beta Brand', '#15803d'),
  ('c0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'Alpha Brand', '#1d4ed8'),
  ('c0000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 'Alpha Nights', '#6d28d9'),
  ('c0000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000006', 'Beta Brand', '#15803d')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    color = EXCLUDED.color,
    updated_at = now();

-- Platform accounts. The canonical account (5000…0001) is pinned by the
-- automation integration tests and stays in Alpha Studio. The e000… accounts
-- live in the personal workspaces and cover connected/expired states so
-- /channels shows more than a single happy-path row. access_token values are
-- marked fixtures and are never sent to a real provider.
INSERT INTO platform_accounts (
  id, org_id, brand_profile_id, platform, platform_user_id, display_name,
  access_token, scopes, metadata, connection_status, last_synced_at
)
VALUES
  (
    '50000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'youtube',
    'local-youtube-alpha',
    'Alpha Channel',
    'local-only-not-a-provider-credential',
    ARRAY['upload'],
    '{"fixture": true}'::jsonb,
    'connected',
    now() - interval '2 hours'
  ),
  (
    'e0000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'youtube',
    'local-youtube-personal-alpha',
    'Alpha Channel',
    'local-only-not-a-provider-credential',
    ARRAY['upload'],
    '{"fixture": true}'::jsonb,
    'connected',
    now() - interval '2 hours'
  ),
  (
    'e0000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'tiktok',
    'local-tiktok-personal-alpha',
    '@alphastudio',
    'local-only-not-a-provider-credential',
    ARRAY['upload', 'analytics'],
    '{"fixture": true}'::jsonb,
    'connected',
    now() - interval '26 hours'
  ),
  (
    'e0000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000002',
    'instagram',
    'local-instagram-personal-alpha',
    '@alpha.nights',
    'local-only-not-a-provider-credential',
    ARRAY['upload'],
    '{"fixture": true}'::jsonb,
    'expired',
    now() - interval '9 days'
  ),
  (
    'e0000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000006',
    'c0000000-0000-4000-8000-000000000003',
    'threads',
    'local-threads-personal-beta',
    '@betastudio',
    'local-only-not-a-provider-credential',
    ARRAY['upload'],
    '{"fixture": true}'::jsonb,
    'connected',
    now() - interval '3 days'
  )
ON CONFLICT (platform, platform_user_id) DO UPDATE
SET display_name = EXCLUDED.display_name,
    scopes = EXCLUDED.scopes,
    metadata = EXCLUDED.metadata,
    connection_status = EXCLUDED.connection_status,
    last_synced_at = EXCLUDED.last_synced_at,
    updated_at = now();

-- The canonical 4000…0001/0002 media pair belongs to team workspaces; d000…
-- fixtures cover personal-workspace media types and lifecycle states.
-- Captions belong to posts.default_text, never Assets. Each ready Asset has an
-- inventoried original and a ready rendition reference; failed media owns none.
--
-- `finalized_at` sits inside the current usage period for every row, so the
-- counters seeded in usage_records below are exactly what a usage
-- reconciliation recomputes. No seeded row carries an orphan deadline: the
-- hourly maintenance sweep must leave the demo fixtures alone.
INSERT INTO assets (
  id, org_id, brand_profile_id, uploaded_by, asset_type, title,
  duration_sec, file_size, mime_type, width, height, status, original_filename,
  failure_code, failure_message, failure_retryable, failure_at, finalized_at
)
VALUES
  (
    '40000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'image',
    'Alpha launch',
    NULL,
    4096,
    'image/png',
    1080,
    1080,
    'ready',
    'alpha-launch.png',
    NULL, NULL, NULL, NULL,
    now()
  ),
  (
    '40000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    'a0000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    'image',
    'Beta note',
    NULL,
    NULL,
    'image/png',
    NULL,
    NULL,
    'ready',
    'beta-note.png',
    NULL, NULL, NULL, NULL,
    now()
  ),
  (
    'd0000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'image',
    'Alpha launch',
    NULL,
    4096,
    'image/png',
    1080,
    1080,
    'ready',
    'alpha-launch.png',
    NULL, NULL, NULL, NULL,
    now()
  ),
  (
    'd0000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'video',
    'Launch teaser cut',
    42,
    8388608,
    'video/mp4',
    1920,
    1080,
    'ready',
    'launch-teaser.mp4',
    NULL, NULL, NULL, NULL,
    now()
  ),
  (
    'd0000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'image',
    'Behind the scenes',
    NULL,
    245760,
    'image/png',
    1080,
    1350,
    'ready',
    'behind-the-scenes.png',
    NULL, NULL, NULL, NULL,
    now()
  ),
  (
    'd0000000-0000-4000-8000-000000000005',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'video',
    'Corrupted upload sample',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    'failed',
    'corrupted-upload.mp4',
    'upload_aborted',
    'Part upload aborted before completion.',
    TRUE,
    now() - interval '1 day',
    now()
  ),
  (
    'd0000000-0000-4000-8000-000000000006',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'image',
    'Nights campaign key visual',
    NULL,
    196608,
    'image/png',
    1080,
    1080,
    'ready',
    'nights-key-visual.png',
    NULL, NULL, NULL, NULL,
    now()
  )
ON CONFLICT (id) DO UPDATE
SET asset_type = EXCLUDED.asset_type,
    title = EXCLUDED.title,
    duration_sec = EXCLUDED.duration_sec,
    file_size = EXCLUDED.file_size,
    mime_type = EXCLUDED.mime_type,
    width = EXCLUDED.width,
    height = EXCLUDED.height,
    status = EXCLUDED.status,
    original_filename = EXCLUDED.original_filename,
    failure_code = EXCLUDED.failure_code,
    failure_message = EXCLUDED.failure_message,
    failure_retryable = EXCLUDED.failure_retryable,
    failure_at = EXCLUDED.failure_at,
    finalized_at = EXCLUDED.finalized_at,
    updated_at = now();

-- Storage inventory. One ready `original` object per publishable Asset, keyed
-- <orgId>/<assetId>/original — the canonical protected layout readyObjectKey()
-- produces — so a signed preview, download, or Provider delivery can never name
-- an upload-writable path. No etag or sha256 is recorded: these fixtures have
-- no bytes in the bucket, and a pinned digest the processor could not
-- reproduce would fail a real verification for no reason.
--
-- 4000…0002 is the exception that carries no bytes at all: it is the
-- tenant-isolation row the RLS suite reads, not demo media, and a NULL
-- file_size with a zero-byte inventoried object keeps the pinned Beta usage
-- record (storage_bytes 0) authoritative after a reconciliation.
INSERT INTO asset_objects (
  id, org_id, asset_id, brand_profile_id, kind, r2_key, bytes, content_type,
  width, height, duration_sec, status
)
VALUES
  (
    '41000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'original',
    '20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000001/original',
    4096, 'image/png', 1080, 1080, NULL, 'ready'
  ),
  (
    '41000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-000000000002',
    'a0000000-0000-4000-8000-000000000002',
    'original',
    '20000000-0000-4000-8000-000000000002/40000000-0000-4000-8000-000000000002/original',
    0, 'image/png', NULL, NULL, NULL, 'ready'
  ),
  (
    '41000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000005',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'original',
    '20000000-0000-4000-8000-000000000005/d0000000-0000-4000-8000-000000000001/original',
    4096, 'image/png', 1080, 1080, NULL, 'ready'
  ),
  (
    '41000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000005',
    'd0000000-0000-4000-8000-000000000002',
    'c0000000-0000-4000-8000-000000000001',
    'original',
    '20000000-0000-4000-8000-000000000005/d0000000-0000-4000-8000-000000000002/original',
    8388608, 'video/mp4', 1920, 1080, 42, 'ready'
  ),
  (
    '41000000-0000-4000-8000-000000000005',
    '20000000-0000-4000-8000-000000000005',
    'd0000000-0000-4000-8000-000000000003',
    'c0000000-0000-4000-8000-000000000001',
    'original',
    '20000000-0000-4000-8000-000000000005/d0000000-0000-4000-8000-000000000003/original',
    245760, 'image/png', 1080, 1350, NULL, 'ready'
  ),
  (
    '41000000-0000-4000-8000-000000000006',
    '20000000-0000-4000-8000-000000000005',
    'd0000000-0000-4000-8000-000000000006',
    'c0000000-0000-4000-8000-000000000002',
    'original',
    '20000000-0000-4000-8000-000000000005/d0000000-0000-4000-8000-000000000006/original',
    196608, 'image/png', 1080, 1080, NULL, 'ready'
  )
ON CONFLICT (r2_key) DO UPDATE
SET bytes = EXCLUDED.bytes,
    content_type = EXCLUDED.content_type,
    width = EXCLUDED.width,
    height = EXCLUDED.height,
    duration_sec = EXCLUDED.duration_sec,
    status = EXCLUDED.status,
    updated_at = now();

-- One `original` rendition per approved object. This pairing is the only shape
-- preview, download, and publication accept: a ready object plus the ready
-- rendition that references it, on a ready image or video Asset.
INSERT INTO asset_renditions (
  id, org_id, asset_id, brand_profile_id, profile, object_id, status
)
VALUES
  (
    '42000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'original',
    '41000000-0000-4000-8000-000000000001',
    'ready'
  ),
  (
    '42000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-000000000002',
    'a0000000-0000-4000-8000-000000000002',
    'original',
    '41000000-0000-4000-8000-000000000002',
    'ready'
  ),
  (
    '42000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000005',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'original',
    '41000000-0000-4000-8000-000000000003',
    'ready'
  ),
  (
    '42000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000005',
    'd0000000-0000-4000-8000-000000000002',
    'c0000000-0000-4000-8000-000000000001',
    'original',
    '41000000-0000-4000-8000-000000000004',
    'ready'
  ),
  (
    '42000000-0000-4000-8000-000000000005',
    '20000000-0000-4000-8000-000000000005',
    'd0000000-0000-4000-8000-000000000003',
    'c0000000-0000-4000-8000-000000000001',
    'original',
    '41000000-0000-4000-8000-000000000005',
    'ready'
  ),
  (
    '42000000-0000-4000-8000-000000000006',
    '20000000-0000-4000-8000-000000000005',
    'd0000000-0000-4000-8000-000000000006',
    'c0000000-0000-4000-8000-000000000002',
    'original',
    '41000000-0000-4000-8000-000000000006',
    'ready'
  )
ON CONFLICT (asset_id, profile) DO UPDATE
SET object_id = EXCLUDED.object_id,
    status = EXCLUDED.status,
    updated_at = now();

-- Posts. A Distribution references a Post, never an Asset, so the seeded
-- publication history and its pending states hang off Post identities now.
-- 4800…0001 is the canonical Alpha Post the API integration suite pins, and
-- 4800…0002-0006 mirror the f000… distributions below one for one.
--
-- 4800…0005 is what the retired d000…0004 text Asset became: the caption is the
-- Post's default_text and it attaches no media, which is how a deliberate
-- text-only target is recorded.
INSERT INTO posts (
  id, org_id, brand_profile_id, title, default_text, status
)
VALUES
  (
    '48000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'Alpha launch',
    'The launch is live. Follow along for behind-the-scenes drops all week.',
    'active'
  ),
  (
    '48000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'Alpha launch',
    'The launch is live. Follow along for behind-the-scenes drops all week.',
    'active'
  ),
  (
    '48000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'Launch teaser cut',
    'First look at the launch teaser.',
    'active'
  ),
  (
    '48000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'Behind the scenes',
    'A still from this week''s shoot.',
    'active'
  ),
  (
    '48000000-0000-4000-8000-000000000005',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'Launch announcement copy',
    'Big news: our launch is live. Follow along for behind-the-scenes drops all week.',
    'active'
  ),
  (
    '48000000-0000-4000-8000-000000000006',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000002',
    'Nights campaign key visual',
    'Key visual for the Alpha Nights campaign.',
    'active'
  )
ON CONFLICT (id) DO UPDATE
SET title = EXCLUDED.title,
    default_text = EXCLUDED.default_text,
    status = EXCLUDED.status,
    updated_at = now();

-- Ordered Post attachments. Each seeded Post carries the single Asset its
-- Distribution used to reference directly; the text-only Post 4800…0005
-- attaches nothing at all.
INSERT INTO post_attachments (
  post_id, asset_id, org_id, brand_profile_id, position
)
VALUES
  ('48000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 0),
  ('48000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 0),
  ('48000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 0),
  ('48000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 0),
  ('48000000-0000-4000-8000-000000000006', 'd0000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000002', 0)
ON CONFLICT (post_id, asset_id) DO UPDATE
SET position = EXCLUDED.position;

-- Saved per-Channel target settings, one per seeded Distribution. A NULL
-- attachment_ids inherits the Post's own ordered selection; the empty array on
-- 4800…0005 is the deliberate text-only choice.
INSERT INTO post_targets (
  post_id, platform_account_id, org_id, brand_profile_id, title_override,
  attachment_ids
)
VALUES
  ('48000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Alpha launch', NULL),
  ('48000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Alpha launch', NULL),
  ('48000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Launch teaser cut', NULL),
  ('48000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Behind the scenes', NULL),
  ('48000000-0000-4000-8000-000000000005', 'e0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Launch announcement copy', '{}'),
  ('48000000-0000-4000-8000-000000000006', 'e0000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000002', 'Nights campaign key visual', NULL)
ON CONFLICT (post_id, platform_account_id) DO UPDATE
SET title_override = EXCLUDED.title_override,
    attachment_ids = EXCLUDED.attachment_ids,
    updated_at = now();

-- Distributions. A row now names the Post it publishes, never a single Asset:
-- the media it delivers is that Post's ordered attachment subset. The canonical
-- 6000…0001 row (pinned by the automation tests) stays in Alpha Studio. The
-- f000… rows exercise every /posts and /calendar state in the personal
-- workspace: published history with metrics, an upcoming scheduled slot, a
-- queued item, and a failed send that can be retried from the UI.
--
-- `attachment_ids` freezes the ordered selection each Channel was scheduled
-- with: NULL inherits the Post's own order, and the empty array on the queued
-- row is the deliberate text-only target carried over from the retired text
-- Asset.
INSERT INTO distributions (
  id, org_id, brand_profile_id, post_id, platform_account_id, platform, status,
  scheduled_at, published_at, platform_post_id, platform_url, title_override,
  attachment_ids, error_message, retry_count, attempt_count, last_attempt_at,
  failure_code, failure_retryable
)
VALUES
  (
    '60000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    '48000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    'youtube',
    'published',
    NULL,
    '2026-07-18T12:00:00Z',
    'local-post-alpha',
    'https://example.invalid/watch/local-post-alpha',
    'Alpha launch',
    NULL,
    NULL, 0, 1, '2026-07-18T12:00:00Z', NULL, NULL
  ),
  (
    'f0000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '48000000-0000-4000-8000-000000000002',
    'e0000000-0000-4000-8000-000000000001',
    'youtube',
    'published',
    NULL,
    now() - interval '6 days',
    'local-post-alpha-personal',
    'https://example.invalid/watch/local-post-alpha-personal',
    'Alpha launch',
    NULL,
    NULL, 0, 1, now() - interval '6 days', NULL, NULL
  ),
  (
    'f0000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '48000000-0000-4000-8000-000000000003',
    'e0000000-0000-4000-8000-000000000002',
    'tiktok',
    'published',
    NULL,
    now() - interval '2 days',
    'local-post-alpha-tiktok',
    'https://example.invalid/tiktok/local-post-alpha-tiktok',
    'Launch teaser cut',
    NULL,
    NULL, 0, 1, now() - interval '2 days', NULL, NULL
  ),
  (
    'f0000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '48000000-0000-4000-8000-000000000004',
    'e0000000-0000-4000-8000-000000000002',
    'tiktok',
    'scheduled',
    now() + interval '2 days',
    NULL, NULL, NULL,
    'Behind the scenes',
    NULL,
    NULL, 0, 0, NULL, NULL, NULL
  ),
  (
    'f0000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '48000000-0000-4000-8000-000000000005',
    'e0000000-0000-4000-8000-000000000001',
    'youtube',
    'queued',
    NULL, NULL, NULL, NULL,
    'Launch announcement copy',
    '{}',
    NULL, 0, 0, NULL, NULL, NULL
  ),
  (
    'f0000000-0000-4000-8000-000000000005',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000002',
    '48000000-0000-4000-8000-000000000006',
    'e0000000-0000-4000-8000-000000000003',
    'instagram',
    'failed',
    NULL, NULL, NULL, NULL,
    'Nights campaign key visual',
    NULL,
    'Provider rejected the publish request: rate limited.',
    1, 1, now() - interval '5 hours', 'provider_rate_limited', TRUE
  )
-- `post_id` and the frozen `attachment_ids` are re-asserted on reseed: a
-- database seeded before the Post-owned-media cutover holds distribution rows
-- that point somewhere else, and the fixture must win over that history.
ON CONFLICT (id) DO UPDATE
SET post_id = EXCLUDED.post_id,
    title_override = EXCLUDED.title_override,
    attachment_ids = EXCLUDED.attachment_ids,
    status = EXCLUDED.status,
    scheduled_at = EXCLUDED.scheduled_at,
    published_at = EXCLUDED.published_at,
    error_message = EXCLUDED.error_message,
    retry_count = EXCLUDED.retry_count,
    attempt_count = EXCLUDED.attempt_count,
    last_attempt_at = EXCLUDED.last_attempt_at,
    failure_code = EXCLUDED.failure_code,
    failure_retryable = EXCLUDED.failure_retryable,
    updated_at = now();

-- Analytics history across the last two weeks so /analytics charts render a
-- curve instead of a single point.
INSERT INTO analytics_snapshots (
  id, distribution_id, org_id, views, likes, comments, shares,
  watch_time_sec, reach, impressions, snapshot_at
)
VALUES
  ('70000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 1200, 84, 9, 12, 3600, 900, 1450, '2026-07-18T13:00:00Z'),
  ('aa000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 1200, 84, 9, 12, 3600, 900, 1450, now() - interval '6 days'),
  ('aa000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 2480, 171, 21, 30, 7800, 1900, 3100, now() - interval '4 days'),
  ('aa000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 3910, 260, 34, 51, 12400, 3050, 4700, now() - interval '2 days'),
  ('aa000000-0000-4000-8000-000000000004', 'f0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 4525, 298, 41, 60, 14900, 3520, 5400, now() - interval '12 hours'),
  ('aa000000-0000-4000-8000-000000000005', 'f0000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 820, 64, 7, 19, 1500, 700, 980, now() - interval '2 days'),
  ('aa000000-0000-4000-8000-000000000006', 'f0000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 1935, 148, 18, 44, 3900, 1600, 2200, now() - interval '8 hours')
ON CONFLICT (id) DO UPDATE
SET views = EXCLUDED.views,
    likes = EXCLUDED.likes,
    comments = EXCLUDED.comments,
    shares = EXCLUDED.shares,
    watch_time_sec = EXCLUDED.watch_time_sec,
    reach = EXCLUDED.reach,
    impressions = EXCLUDED.impressions,
    snapshot_at = EXCLUDED.snapshot_at;

-- Inbox fixtures: unanswered, replied, and failed-reply comments so /inbox
-- shows each reply workflow state. The canonical 8000…0001 row is pinned by
-- the automation tests and stays in Alpha Studio.
INSERT INTO comments (
  id, distribution_id, org_id, platform_comment_id, author_name, body,
  replied, reply_text, reply_status, reply_error, reply_attempted_at, commented_at
)
VALUES
  (
    '80000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'local-comment-alpha',
    'Local Viewer',
    'This local fixture is ready for reply tests.',
    false,
    NULL,
    'none',
    NULL, NULL,
    '2026-07-18T12:30:00Z'
  ),
  (
    'bb000000-0000-4000-8000-000000000001',
    'f0000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000005',
    'local-comment-personal-alpha',
    'Local Viewer',
    'This local fixture is ready for reply tests.',
    false,
    NULL,
    'none',
    NULL, NULL,
    now() - interval '5 days'
  ),
  (
    'bb000000-0000-4000-8000-000000000002',
    'f0000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000005',
    'local-comment-personal-alpha-2',
    'Early Adopter',
    'Congrats on the launch — when is the next feature drop?',
    false,
    NULL,
    'none',
    NULL, NULL,
    now() - interval '1 day'
  ),
  (
    'bb000000-0000-4000-8000-000000000003',
    'f0000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000005',
    'local-comment-personal-tiktok-1',
    'Curious Fan',
    'That teaser cut is clean. What did you edit it with?',
    true,
    'Thanks! Cut and graded in-house — full breakdown soon.',
    'succeeded',
    NULL, now() - interval '1 day',
    now() - interval '2 days'
  ),
  (
    'bb000000-0000-4000-8000-000000000004',
    'f0000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000005',
    'local-comment-personal-tiktok-2',
    'Skeptical Sam',
    'Is this available outside the US yet?',
    false,
    'Rolling out region by region — more soon.',
    'failed',
    'Provider rejected the reply: rate limited.',
    now() - interval '6 hours',
    now() - interval '1 day'
  )
ON CONFLICT (distribution_id, platform_comment_id) DO UPDATE
SET body = EXCLUDED.body,
    replied = EXCLUDED.replied,
    reply_text = EXCLUDED.reply_text,
    reply_status = EXCLUDED.reply_status,
    reply_error = EXCLUDED.reply_error,
    reply_attempted_at = EXCLUDED.reply_attempted_at,
    commented_at = EXCLUDED.commented_at,
    synced_at = now();

-- Current-month usage rows drive /billing meters; keyed by (org_id, period)
-- so reseeding in a new month adds a fresh period instead of conflicting on id.
-- uploads, distributions, and storage_bytes are exactly what a usage
-- reconciliation recomputes from the rows above — finalized Assets, stored
-- Distributions, and non-deleted `asset_objects` — so the hourly sweep never
-- rewrites the demo counters. api_calls is the one term only the request path
-- records.
INSERT INTO usage_records (
  org_id, period, uploads, distributions, api_calls, storage_bytes
)
VALUES
  ('20000000-0000-4000-8000-000000000001', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'), 1, 1, 12, 4096),
  ('20000000-0000-4000-8000-000000000002', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'), 1, 0, 3, 0),
  ('20000000-0000-4000-8000-000000000005', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'), 5, 5, 214, 8835072),
  ('20000000-0000-4000-8000-000000000006', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'), 0, 0, 3, 0),
  ('20000000-0000-4000-8000-000000000005', to_char((now() - interval '1 month') AT TIME ZONE 'UTC', 'YYYY-MM'), 3, 2, 96, 4194304)
ON CONFLICT (org_id, period) DO UPDATE
SET uploads = EXCLUDED.uploads,
    distributions = EXCLUDED.distributions,
    api_calls = EXCLUDED.api_calls,
    storage_bytes = EXCLUDED.storage_bytes,
    updated_at = now();

COMMIT;
