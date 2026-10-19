-- Local development fixtures for the Cloudflare-target PostgreSQL stack.
-- Idempotent: every statement upserts on a stable key so `database.sh seed`,
-- `database.sh reset`, and cold-volume initialization can all re-run it.
--
-- Two layers, deliberately kept in disjoint id ranges:
--   * Canonical fixtures in the team workspaces (orgs …0001/…0002) are a
--     test contract — packages/database/test/rls.integration.test.ts and
--   * Personal-workspace fixtures (orgs …0005/…0006; ids in the c/d/e/f/aa/bb
--     ranges) are the day-to-day demo set: the API activates the personal
--     workspace by default, so signing in shows populated UI immediately. The
--     demo set at the end of this file widens Alpha's personal workspace to
--     every Posts outcome, the remaining connection states and Providers, a
--     third Brand Profile, and the media lifecycle variants — its ids stay in
--     fresh `49…`/`4b…` (Posts), `4c…`/`ac…` (objects and renditions),
--     `d7…`/`d8…` (media), `e3…`/`e4…` (accounts), `f8…` (distributions),
--     `a3…` (provider attempts), `ab…` (metrics), and `c4…` (profile) prefixes
--     that no fixture and no integration suite allocates.
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
-- RLS integration tests authenticate as these session subjects.
INSERT INTO "user" (id, name, email, "emailVerified")
VALUES
  ('auth_user_local_alpha', 'Alpha Creator', 'alpha@meltiply.local', TRUE),
  ('auth_user_local_beta', 'Beta Creator', 'beta@meltiply.local', TRUE)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    email = EXCLUDED.email,
    "emailVerified" = EXCLUDED."emailVerified",
    "updatedAt" = now();
UPDATE "user" SET "installationOwner" = (id = 'auth_user_local_alpha')
WHERE id IN ('auth_user_local_alpha', 'auth_user_local_beta');

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
  )
ON CONFLICT (id) DO UPDATE
SET "accountId" = EXCLUDED."accountId",
    "providerId" = EXCLUDED."providerId",
    password = EXCLUDED.password,
    "updatedAt" = now();

INSERT INTO users (id, auth_user_id, email, display_name)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'auth_user_local_alpha', 'alpha@meltiply.local', 'Alpha Creator'),
  ('10000000-0000-4000-8000-000000000002', 'auth_user_local_beta', 'beta@meltiply.local', 'Beta Creator')
ON CONFLICT (id) DO UPDATE
SET auth_user_id = EXCLUDED.auth_user_id,
    email = EXCLUDED.email,
    display_name = EXCLUDED.display_name,
    updated_at = now();

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

-- The API auto-provisions a personal workspace (random id) on first sign-in.
-- Reseeding must address it by a stable id, so retire any random-id personal
-- workspace for the seeded users and replace it with the deterministic row.
-- Children cascade; this is fixture-only data on an ephemeral local database.
DELETE FROM organizations
WHERE personal_user_id IN (
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002'
  )
  AND id NOT IN (
    '20000000-0000-4000-8000-000000000005',
    '20000000-0000-4000-8000-000000000006'
  );

INSERT INTO organizations (id, personal_user_id, name, slug, plan, billing_status)
VALUES
  (
    '20000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000001',
    'Alpha Creator''s workspace',
    'personal-10000000000040008000000000000001',
    'creator',
    'free'
  ),
  (
    '20000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000002',
    'Beta Creator''s workspace',
    'personal-10000000000040008000000000000002',
    'free',
    'free'
  )
ON CONFLICT (id) DO UPDATE
SET personal_user_id = EXCLUDED.personal_user_id,
    name = EXCLUDED.name,
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
  ('30000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000002', 'admin')
ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role;

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
  -- The demo workspace's numbers cover the canonical rows above plus the demo
  -- set appended below this block: 7 finalized Assets and 20 stored
  -- Distributions inside the current period — deliberately under the community
  -- ceilings, so the demo workspace can still upload and publish — and
  -- 18,317,312 resident inventory bytes, which is exactly what a reconciliation
  -- recomputes for the current period.
  ('20000000-0000-4000-8000-000000000005', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'), 7, 20, 214, 18317312),
  ('20000000-0000-4000-8000-000000000006', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'), 0, 0, 3, 0),
  ('20000000-0000-4000-8000-000000000005', to_char((now() - interval '1 month') AT TIME ZONE 'UTC', 'YYYY-MM'), 3, 2, 96, 4194304)
ON CONFLICT (org_id, period) DO UPDATE
SET uploads = EXCLUDED.uploads,
    distributions = EXCLUDED.distributions,
    api_calls = EXCLUDED.api_calls,
    storage_bytes = EXCLUDED.storage_bytes,
    updated_at = now();

-- ===========================================================================
-- Personal-workspace demo set: every Posts, Channels, and media variant.
--
-- Alpha's personal workspace (…0005) is the signed-in demo workspace, so its
-- fixtures are the sample data the UI is exercised against. The `4900…`/`4b00…`
-- Posts cover every outcome `/posts` can group by — draft, scheduled, queued,
-- processing, awaiting provider, published, failed, cancel requested, cancelled,
-- needs reconciliation — plus the shapes around them: a Post with no
-- Distribution, a saved Channel target with no outcome, five Channels on one
-- Post, a published + failed pair, a non-retryable failure, text-only and
-- media-only compositions, ordered multi-attachment Posts, a caption that is
-- only a long unbroken token, an empty caption, and attachments that are
-- processing or failed. The `e300…`/`e400…` accounts cover all five connection
-- states across all five Providers, and `c400…0001` adds a third Brand Profile so
-- profile grouping and the profile scope have more than two rows to show.
--
-- Ids are disjoint from the canonical team fixtures (orgs …0001/…0002), from
-- every id the integration suites allocate, and from the retired ranges.
-- ===========================================================================

-- A third Brand Profile in the demo workspace: profile grouping, the profile
-- scope, and the Channels directory need more than the two profiles that
-- predate it. `#0f766e` is one of the fixed accessible palette values
-- `brand_profiles_color_check` accepts.
INSERT INTO brand_profiles (id, org_id, name, color)
VALUES
  ('c4000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'Alpha Labs', '#0f766e')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    color = EXCLUDED.color,
    updated_at = now();

-- Every remaining Provider and connection state on the demo profiles, so
-- /channels and the composer's destination chips show connected, expiring,
-- expired, revoked, and reconnect-required accounts. `e300…0002` deliberately
-- carries no display name: the directory must fall back to the platform user id
-- rather than rendering an empty name cell.
--
-- LinkedIn is not a supported Provider — the roster, the API contract, and the
-- frontend label map carry the five platforms above — so retire the accounts an
-- earlier seed created with that slug. `platform` is part of the upsert key
-- below, so a retired row would collide on its primary key instead of
-- converging. Its Post targets cascade away and its Distributions are re-pointed
-- by the upserts later in this transaction; both ids are re-inserted on
-- supported platforms.
DELETE FROM platform_accounts
WHERE platform = 'linkedin'
  AND id IN (
    'e3000000-0000-4000-8000-000000000002',
    'e4000000-0000-4000-8000-000000000002'
  );

INSERT INTO platform_accounts (
  id, org_id, brand_profile_id, platform, platform_user_id, display_name,
  access_token, scopes, metadata, connection_status, last_synced_at, revoked_at
)
VALUES
  (
    'e3000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'facebook',
    'local-facebook-alpha',
    'Alpha Page',
    'local-only-not-a-provider-credential',
    ARRAY['upload', 'analytics'],
    '{"fixture": true}'::jsonb,
    'connected',
    now() - interval '2 hours',
    NULL
  ),
  (
    'e3000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'instagram',
    'local-instagram-alpha',
    NULL,
    'local-only-not-a-provider-credential',
    ARRAY['upload'],
    '{"fixture": true}'::jsonb,
    'connected',
    now() - interval '1 day',
    NULL
  ),
  (
    'e3000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'threads',
    'local-threads-alpha',
    '@alpha.threads',
    'local-only-not-a-provider-credential',
    ARRAY['upload'],
    '{"fixture": true}'::jsonb,
    'expiring',
    now() - interval '3 hours',
    NULL
  ),
  (
    'e3000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'tiktok',
    'local-tiktok-alpha-clips',
    '@alpha.clips',
    'local-only-not-a-provider-credential',
    ARRAY['upload'],
    '{"fixture": true}'::jsonb,
    'revoked',
    now() - interval '20 days',
    now() - interval '20 days'
  ),
  (
    'e3000000-0000-4000-8000-000000000005',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000002',
    'youtube',
    'local-youtube-nights',
    'Alpha Nights',
    'local-only-not-a-provider-credential',
    ARRAY['upload'],
    '{"fixture": true}'::jsonb,
    'reconnect_required',
    now() - interval '4 days',
    NULL
  ),
  (
    'e3000000-0000-4000-8000-000000000006',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000002',
    'tiktok',
    'local-tiktok-nights',
    '@alpha.nights.tv',
    'local-only-not-a-provider-credential',
    ARRAY['upload', 'analytics'],
    '{"fixture": true}'::jsonb,
    'connected',
    now() - interval '6 hours',
    NULL
  ),
  (
    'e4000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000005',
    'c4000000-0000-4000-8000-000000000001',
    'instagram',
    'local-instagram-labs',
    '@alphalabs',
    'local-only-not-a-provider-credential',
    ARRAY['upload'],
    '{"fixture": true}'::jsonb,
    'connected',
    now() - interval '5 hours',
    NULL
  ),
  (
    'e4000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000005',
    'c4000000-0000-4000-8000-000000000001',
    'facebook',
    'local-facebook-labs',
    'Alpha Labs',
    'local-only-not-a-provider-credential',
    ARRAY['upload'],
    '{"fixture": true}'::jsonb,
    'expired',
    now() - interval '11 days',
    NULL
  )
ON CONFLICT (platform, platform_user_id) DO UPDATE
SET display_name = EXCLUDED.display_name,
    scopes = EXCLUDED.scopes,
    metadata = EXCLUDED.metadata,
    connection_status = EXCLUDED.connection_status,
    last_synced_at = EXCLUDED.last_synced_at,
    revoked_at = EXCLUDED.revoked_at,
    updated_at = now();

-- Media variants the demo Posts attach: two images and a video per shape, an
-- image with unknown dimensions, a ready asset with no measured size, a failed
-- upload, and an asset still processing. Ready assets own one original object
-- and one ready rendition below; the failed and processing rows own neither.
INSERT INTO assets (
  id, org_id, brand_profile_id, uploaded_by, asset_type, title,
  duration_sec, file_size, mime_type, width, height, status, original_filename,
  failure_code, failure_message, failure_retryable, failure_at, finalized_at
)
VALUES
  (
    'd7000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'image',
    'Studio still 01',
    NULL, 262144, 'image/png', 1080, 1350, 'ready', 'studio-still-01.png',
    NULL, NULL, NULL, NULL, now()
  ),
  (
    'd7000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'image',
    'Studio still 02',
    NULL, 331776, 'image/png', 1080, 1080, 'ready', 'studio-still-02.png',
    NULL, NULL, NULL, NULL, now()
  ),
  (
    'd7000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'video',
    'Launch recap',
    42, 8388608, 'video/mp4', 1920, 1080, 'ready', 'launch-recap.mp4',
    NULL, NULL, NULL, NULL, now()
  ),
  (
    'd7000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'image',
    'Product macro',
    NULL, NULL, 'image/png', NULL, NULL, 'ready', 'product-macro.png',
    NULL, NULL, NULL, NULL, now()
  ),
  (
    'd7000000-0000-4000-8000-000000000005',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'video',
    'Truncated clip',
    NULL, NULL, NULL, NULL, NULL, 'failed', 'truncated-clip.mp4',
    'upload_aborted',
    'Part upload aborted before completion.',
    TRUE,
    now() - interval '3 hours',
    NULL
  ),
  (
    'd7000000-0000-4000-8000-000000000006',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'image',
    'Reels cover',
    NULL, 131072, 'image/png', 1080, 1920, 'processing', 'reels-cover.png',
    NULL, NULL, NULL, NULL, NULL
  ),
  (
    'd7000000-0000-4000-8000-000000000007',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'image',
    'Nights teaser',
    NULL, 196608, 'image/png', 1080, 1080, 'ready', 'nights-teaser.png',
    NULL, NULL, NULL, NULL, now()
  ),
  (
    'd8000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000005',
    'c4000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'image',
    'Labs diagram',
    NULL, 98304, 'image/png', 1600, 900, 'ready', 'labs-diagram.png',
    NULL, NULL, NULL, NULL, now()
  ),
  (
    'd8000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000005',
    'c4000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'image',
    'Labs key art',
    NULL, 204800, 'image/png', 1080, 1350, 'ready', 'labs-key-art.png',
    NULL, NULL, NULL, NULL, now()
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

-- Originals for the ready demo media, keyed with the canonical protected
-- `<orgId>/<assetId>/original` layout a signed preview or delivery resolves.
INSERT INTO asset_objects (
  id, org_id, asset_id, brand_profile_id, kind, r2_key, bytes, content_type,
  width, height, duration_sec, status
)
VALUES
  ('4c000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'd7000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'original', '20000000-0000-4000-8000-000000000005/d7000000-0000-4000-8000-000000000001/original', 262144, 'image/png', 1080, 1350, NULL, 'ready'),
  ('4c000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 'd7000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001', 'original', '20000000-0000-4000-8000-000000000005/d7000000-0000-4000-8000-000000000002/original', 331776, 'image/png', 1080, 1080, NULL, 'ready'),
  ('4c000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000005', 'd7000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000001', 'original', '20000000-0000-4000-8000-000000000005/d7000000-0000-4000-8000-000000000003/original', 8388608, 'video/mp4', 1920, 1080, 42, 'ready'),
  ('4c000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000005', 'd7000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000001', 'original', '20000000-0000-4000-8000-000000000005/d7000000-0000-4000-8000-000000000004/original', 0, 'image/png', NULL, NULL, NULL, 'ready'),
  ('4c000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000005', 'd7000000-0000-4000-8000-000000000007', 'c0000000-0000-4000-8000-000000000002', 'original', '20000000-0000-4000-8000-000000000005/d7000000-0000-4000-8000-000000000007/original', 196608, 'image/png', 1080, 1080, NULL, 'ready'),
  ('4c000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000005', 'd8000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'original', '20000000-0000-4000-8000-000000000005/d8000000-0000-4000-8000-000000000001/original', 98304, 'image/png', 1600, 900, NULL, 'ready'),
  ('4c000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000005', 'd8000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-000000000001', 'original', '20000000-0000-4000-8000-000000000005/d8000000-0000-4000-8000-000000000002/original', 204800, 'image/png', 1080, 1350, NULL, 'ready')
ON CONFLICT (r2_key) DO UPDATE
SET bytes = EXCLUDED.bytes,
    content_type = EXCLUDED.content_type,
    width = EXCLUDED.width,
    height = EXCLUDED.height,
    duration_sec = EXCLUDED.duration_sec,
    status = EXCLUDED.status,
    updated_at = now();

INSERT INTO asset_renditions (
  id, org_id, asset_id, brand_profile_id, profile, object_id, status
)
VALUES
  ('ac000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'd7000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'original', '4c000000-0000-4000-8000-000000000001', 'ready'),
  ('ac000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 'd7000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001', 'original', '4c000000-0000-4000-8000-000000000002', 'ready'),
  ('ac000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000005', 'd7000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000001', 'original', '4c000000-0000-4000-8000-000000000003', 'ready'),
  ('ac000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000005', 'd7000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000001', 'original', '4c000000-0000-4000-8000-000000000004', 'ready'),
  ('ac000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000005', 'd7000000-0000-4000-8000-000000000007', 'c0000000-0000-4000-8000-000000000002', 'original', '4c000000-0000-4000-8000-000000000005', 'ready'),
  ('ac000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000005', 'd8000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'original', '4c000000-0000-4000-8000-000000000006', 'ready'),
  ('ac000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000005', 'd8000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-000000000001', 'original', '4c000000-0000-4000-8000-000000000007', 'ready')
ON CONFLICT (asset_id, profile) DO UPDATE
SET object_id = EXCLUDED.object_id,
    status = EXCLUDED.status,
    updated_at = now();

-- The demo Posts. `created_at` is explicit and varied so list ordering and the
-- "Newest/Oldest" sort have something real to order; `status` is the lifecycle
-- marker only, because every collection row's displayed status is aggregated
-- from its Distributions.
INSERT INTO posts (id, org_id, brand_profile_id, title, default_text, status, created_at)
VALUES
  (
    '49000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'Launch day recap',
    E'Launch day is here 🚀\n\nWe shipped the new editor this morning.\n\n#launch #creator',
    'active',
    now() - interval '21 days'
  ),
  (
    '49000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'Recap, two ways',
    'Full recap plus the short cut.',
    'active',
    now() - interval '14 days'
  ),
  (
    '49000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000002',
    'Nights teaser',
    E'Nights teaser drops tonight.\n\nTurn the sound on 🔊',
    'active',
    now() - interval '9 days'
  ),
  (
    '49000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'Everything, everywhere',
    'One post, five destinations — the full cross-post check.',
    'active',
    now() - interval '8 days'
  ),
  (
    '49000000-0000-4000-8000-000000000005',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '',
    '',
    'active',
    now() - interval '7 days'
  ),
  (
    '49000000-0000-4000-8000-000000000006',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'Release notes',
    'Pneumonoultramicroscopicsilicovolcanoconiosis #shipit #launch #creator #publishing #scheduling #analytics #growth #community #behindthescenes',
    'active',
    now() - interval '5 days'
  ),
  (
    '49000000-0000-4000-8000-000000000007',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000002',
    'Tonight on the feed',
    'Going live at 9pm — set a reminder 🔔',
    'active',
    now() - interval '3 days'
  ),
  (
    '49000000-0000-4000-8000-000000000008',
    '20000000-0000-4000-8000-000000000005',
    'c4000000-0000-4000-8000-000000000001',
    'Labs roadmap',
    'Q4 roadmap: analytics, drafts, and scheduling improvements.',
    'active',
    now() - interval '2 days'
  ),
  (
    '49000000-0000-4000-8000-000000000009',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'Copy-only announcement',
    'No media on this one — copy only.',
    'active',
    now() - interval '1 day'
  ),
  (
    '49000000-0000-4000-8000-000000000010',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'Rendering the cut',
    'Rendering the 4K cut now…',
    'active',
    now() - interval '20 hours'
  ),
  (
    '49000000-0000-4000-8000-000000000011',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'Waiting on the provider',
    'Uploaded — the provider is still transcoding.',
    'active',
    now() - interval '18 hours'
  ),
  (
    '49000000-0000-4000-8000-000000000012',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'Pull this one back',
    'Cancel requested before it goes out.',
    'active',
    now() - interval '12 hours'
  ),
  (
    '49000000-0000-4000-8000-000000000013',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'Superseded teaser',
    'Superseded by the launch recap.',
    'active',
    now() - interval '11 days'
  ),
  (
    '49000000-0000-4000-8000-000000000014',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000002',
    'Provider mismatch',
    'The provider accepted half of this post.',
    'active',
    now() - interval '6 days'
  ),
  (
    '4b000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'Storyboard notes',
    'Hook: the problem. Middle: the work. End: the invite.',
    'draft',
    now() - interval '4 hours'
  ),
  (
    '4b000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'Carousel draft',
    'Slide one copy — three images, no destination picked yet.',
    'draft',
    now() - interval '3 hours'
  ),
  (
    '4b000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '',
    '',
    'draft',
    now() - interval '2 hours'
  ),
  (
    '4b000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'Saved, not targeted',
    'Saved composition with no destination yet.',
    'active',
    now() - interval '90 minutes'
  ),
  (
    '4b000000-0000-4000-8000-000000000005',
    '20000000-0000-4000-8000-000000000005',
    'c4000000-0000-4000-8000-000000000001',
    'Labs target, no outcome',
    'A saved Channel target that was never scheduled.',
    'active',
    now() - interval '80 minutes'
  ),
  (
    '4b000000-0000-4000-8000-000000000006',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000002',
    'Permanent provider failure',
    'This one is not retryable.',
    'active',
    now() - interval '70 minutes'
  ),
  (
    '4b000000-0000-4000-8000-000000000007',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'Two channels, one revoked',
    'Published before the second account was disconnected.',
    'active',
    now() - interval '60 minutes'
  ),
  (
    '4b000000-0000-4000-8000-000000000008',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'Draft with broken media',
    'The attached clip failed to upload.',
    'draft',
    now() - interval '30 minutes'
  )
ON CONFLICT (id) DO UPDATE
SET title = EXCLUDED.title,
    default_text = EXCLUDED.default_text,
    status = EXCLUDED.status,
    created_at = EXCLUDED.created_at,
    updated_at = now();

-- Ordered attachments: one media-only Post, one three-attachment Post, one
-- two-attachment Post, one post whose media the frozen publication detached,
-- and Posts carrying a processing or failed Asset.
INSERT INTO post_attachments (post_id, asset_id, org_id, brand_profile_id, position)
VALUES
  ('49000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 0),
  ('49000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 1),
  ('49000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 2),
  ('49000000-0000-4000-8000-000000000002', 'd7000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 0),
  ('49000000-0000-4000-8000-000000000002', 'd7000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 1),
  ('49000000-0000-4000-8000-000000000003', 'd7000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000002', 0),
  ('49000000-0000-4000-8000-000000000004', 'd7000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 0),
  ('49000000-0000-4000-8000-000000000006', 'd7000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 0),
  ('49000000-0000-4000-8000-000000000007', 'd7000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000002', 0),
  ('49000000-0000-4000-8000-000000000008', 'd8000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'c4000000-0000-4000-8000-000000000001', 0),
  ('49000000-0000-4000-8000-000000000010', 'd7000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 0),
  ('49000000-0000-4000-8000-000000000011', 'd7000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 0),
  ('49000000-0000-4000-8000-000000000013', 'd7000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 0),
  ('49000000-0000-4000-8000-000000000014', 'd7000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000002', 0),
  ('4b000000-0000-4000-8000-000000000002', 'd7000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 0),
  ('4b000000-0000-4000-8000-000000000002', 'd7000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 1),
  ('4b000000-0000-4000-8000-000000000003', 'd7000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 0),
  ('4b000000-0000-4000-8000-000000000004', 'd7000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 0),
  ('4b000000-0000-4000-8000-000000000005', 'd8000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 'c4000000-0000-4000-8000-000000000001', 0),
  ('4b000000-0000-4000-8000-000000000006', 'd7000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000002', 0),
  ('4b000000-0000-4000-8000-000000000007', 'd7000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 0),
  ('4b000000-0000-4000-8000-000000000008', 'd7000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 0)
ON CONFLICT (post_id, asset_id) DO UPDATE
SET position = EXCLUDED.position;

-- Saved per-Channel targets. `description_override` carries a real custom
-- caption, `attachment_ids` carries a Channel-specific media subset and the
-- deliberate text-only empty array, and one target points at an expired and one
-- at a revoked account so the composer's unavailable-destination states are
-- reachable from demo data.
INSERT INTO post_targets (
  post_id, platform_account_id, org_id, brand_profile_id, title_override,
  description_override, attachment_ids
)
VALUES
  ('49000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Launch day recap', NULL, NULL),
  ('49000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', NULL, 'Same recap, cut for TikTok.', ARRAY['d7000000-0000-4000-8000-000000000003']::uuid[]),
  ('49000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Recap, two ways', NULL, NULL),
  ('49000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Recap, two ways', NULL, NULL),
  ('49000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000002', 'Nights teaser', NULL, NULL),
  ('49000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Everything, everywhere', NULL, NULL),
  ('49000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Everything, everywhere', NULL, NULL),
  ('49000000-0000-4000-8000-000000000004', 'e3000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Everything, everywhere', NULL, NULL),
  ('49000000-0000-4000-8000-000000000004', 'e3000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Everything, everywhere', NULL, NULL),
  ('49000000-0000-4000-8000-000000000004', 'e3000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Everything, everywhere', NULL, NULL),
  ('49000000-0000-4000-8000-000000000005', 'e0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', NULL, NULL, NULL),
  ('49000000-0000-4000-8000-000000000006', 'e3000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Release notes', NULL, NULL),
  ('49000000-0000-4000-8000-000000000007', 'e0000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000002', 'Tonight on the feed', NULL, NULL),
  ('49000000-0000-4000-8000-000000000008', 'e4000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'c4000000-0000-4000-8000-000000000001', 'Labs roadmap', NULL, NULL),
  ('49000000-0000-4000-8000-000000000008', 'e4000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 'c4000000-0000-4000-8000-000000000001', 'Labs roadmap', NULL, NULL),
  ('49000000-0000-4000-8000-000000000009', 'e3000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Copy-only announcement', NULL, '{}'::uuid[]),
  ('49000000-0000-4000-8000-000000000010', 'e0000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Rendering the cut', NULL, NULL),
  ('49000000-0000-4000-8000-000000000011', 'e0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Waiting on the provider', NULL, NULL),
  ('49000000-0000-4000-8000-000000000012', 'e3000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Pull this one back', NULL, NULL),
  ('49000000-0000-4000-8000-000000000013', 'e0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Superseded teaser', NULL, NULL),
  ('49000000-0000-4000-8000-000000000014', 'e3000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000002', 'Provider mismatch', NULL, NULL),
  ('4b000000-0000-4000-8000-000000000005', 'e4000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 'c4000000-0000-4000-8000-000000000001', 'Labs target, no outcome', NULL, NULL),
  ('4b000000-0000-4000-8000-000000000006', 'e3000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000002', 'Permanent provider failure', NULL, NULL),
  ('4b000000-0000-4000-8000-000000000007', 'e0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Two channels, one revoked', NULL, NULL),
  ('4b000000-0000-4000-8000-000000000007', 'e3000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Two channels, one revoked', NULL, ARRAY['d7000000-0000-4000-8000-000000000002']::uuid[])
ON CONFLICT (post_id, platform_account_id) DO UPDATE
SET title_override = EXCLUDED.title_override,
    description_override = EXCLUDED.description_override,
    attachment_ids = EXCLUDED.attachment_ids,
    updated_at = now();

-- One Distribution per outcome the collection can group by, with the timing
-- each one needs: published history in the past (including earlier today),
-- pending work scheduled in the future, and terminal failures with their own
-- retryability. `created_at` stays inside the current usage period so a
-- reconciliation recomputes exactly what the counters below record.
INSERT INTO distributions (
  id, org_id, brand_profile_id, post_id, platform_account_id, platform, status,
  scheduled_at, published_at, platform_post_id, platform_url, title_override,
  attachment_ids, error_message, retry_count, attempt_count, last_attempt_at,
  failure_code, failure_retryable, created_at
)
VALUES
  (
    'f8000000-0000-4000-8000-000000000101',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '49000000-0000-4000-8000-000000000001',
    'e0000000-0000-4000-8000-000000000001',
    'youtube',
    'published',
    NULL,
    now() - interval '20 days',
    'local-post-launch-recap',
    'https://example.invalid/watch/local-post-launch-recap',
    'Launch day recap',
    NULL,
    NULL, 0, 1, now() - interval '20 days', NULL, NULL,
    now()
  ),
  (
    'f8000000-0000-4000-8000-000000000102',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '49000000-0000-4000-8000-000000000001',
    'e0000000-0000-4000-8000-000000000002',
    'tiktok',
    'published',
    NULL,
    now() - interval '19 days',
    'local-post-launch-recap-tiktok',
    'https://example.invalid/tiktok/local-post-launch-recap-tiktok',
    'Same recap, cut for TikTok.',
    ARRAY['d7000000-0000-4000-8000-000000000003']::uuid[],
    NULL, 0, 1, now() - interval '19 days', NULL, NULL,
    now()
  ),
  (
    'f8000000-0000-4000-8000-000000000103',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '49000000-0000-4000-8000-000000000002',
    'e0000000-0000-4000-8000-000000000001',
    'youtube',
    'published',
    NULL,
    now() - interval '14 days',
    'local-post-recap-two-ways',
    'https://example.invalid/watch/local-post-recap-two-ways',
    'Recap, two ways',
    NULL,
    NULL, 0, 1, now() - interval '14 days', NULL, NULL,
    now()
  ),
  (
    'f8000000-0000-4000-8000-000000000104',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '49000000-0000-4000-8000-000000000002',
    'e3000000-0000-4000-8000-000000000001',
    'facebook',
    'failed',
    NULL,
    NULL, NULL, NULL,
    'Recap, two ways',
    NULL,
    'Provider rejected the publish request: rate limited.',
    1, 2, now() - interval '13 days', 'provider_rate_limited', TRUE,
    now()
  ),
  (
    'f8000000-0000-4000-8000-000000000105',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000002',
    '49000000-0000-4000-8000-000000000003',
    'e0000000-0000-4000-8000-000000000003',
    'instagram',
    'published',
    NULL,
    now() - interval '9 days',
    'local-post-nights-teaser',
    'https://example.invalid/instagram/local-post-nights-teaser',
    'Nights teaser',
    NULL,
    NULL, 0, 1, now() - interval '9 days', NULL, NULL,
    now()
  ),
  (
    'f8000000-0000-4000-8000-000000000106',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '49000000-0000-4000-8000-000000000004',
    'e0000000-0000-4000-8000-000000000001',
    'youtube',
    'published',
    NULL,
    now() - interval '8 days',
    'local-post-everywhere',
    'https://example.invalid/watch/local-post-everywhere',
    'Everything, everywhere',
    NULL,
    NULL, 0, 1, now() - interval '8 days', NULL, NULL,
    now()
  ),
  (
    'f8000000-0000-4000-8000-000000000107',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '49000000-0000-4000-8000-000000000004',
    'e0000000-0000-4000-8000-000000000002',
    'tiktok',
    'published',
    NULL,
    now() - interval '8 days',
    'local-post-everywhere-tiktok',
    'https://example.invalid/tiktok/local-post-everywhere-tiktok',
    'Everything, everywhere',
    NULL,
    NULL, 0, 1, now() - interval '8 days', NULL, NULL,
    now()
  ),
  (
    'f8000000-0000-4000-8000-000000000108',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '49000000-0000-4000-8000-000000000004',
    'e3000000-0000-4000-8000-000000000001',
    'facebook',
    'published',
    NULL,
    now() - interval '8 days',
    'local-post-everywhere-facebook',
    'https://example.invalid/facebook/local-post-everywhere-facebook',
    'Everything, everywhere',
    NULL,
    NULL, 0, 1, now() - interval '8 days', NULL, NULL,
    now()
  ),
  (
    'f8000000-0000-4000-8000-000000000109',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '49000000-0000-4000-8000-000000000004',
    'e3000000-0000-4000-8000-000000000002',
    'instagram',
    'published',
    NULL,
    now() - interval '8 days',
    'local-post-everywhere-instagram',
    'https://example.invalid/instagram/local-post-everywhere-instagram',
    'Everything, everywhere',
    NULL,
    NULL, 0, 1, now() - interval '8 days', NULL, NULL,
    now()
  ),
  (
    'f8000000-0000-4000-8000-000000000110',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '49000000-0000-4000-8000-000000000004',
    'e3000000-0000-4000-8000-000000000003',
    'threads',
    'cancelled',
    NULL,
    NULL, NULL, NULL,
    'Everything, everywhere',
    NULL,
    'Cancelled before delivery.',
    0, 0, NULL, NULL, NULL,
    now()
  ),
  (
    'f8000000-0000-4000-8000-000000000111',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '49000000-0000-4000-8000-000000000005',
    'e0000000-0000-4000-8000-000000000001',
    'youtube',
    'published',
    NULL,
    now() - interval '7 days',
    'local-post-media-only',
    'https://example.invalid/watch/local-post-media-only',
    NULL,
    NULL,
    NULL, 0, 1, now() - interval '7 days', NULL, NULL,
    now()
  ),
  (
    'f8000000-0000-4000-8000-000000000112',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '49000000-0000-4000-8000-000000000006',
    'e3000000-0000-4000-8000-000000000003',
    'threads',
    'scheduled',
    now() + interval '1 day',
    NULL, NULL, NULL,
    'Release notes',
    NULL,
    NULL, 0, 0, NULL, NULL, NULL,
    now()
  ),
  (
    'f8000000-0000-4000-8000-000000000113',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000002',
    '49000000-0000-4000-8000-000000000007',
    'e0000000-0000-4000-8000-000000000003',
    'instagram',
    'scheduled',
    now() + interval '3 hours',
    NULL, NULL, NULL,
    'Tonight on the feed',
    NULL,
    NULL, 0, 0, NULL, NULL, NULL,
    now()
  ),
  (
    'f8000000-0000-4000-8000-000000000114',
    '20000000-0000-4000-8000-000000000005',
    'c4000000-0000-4000-8000-000000000001',
    '49000000-0000-4000-8000-000000000008',
    'e4000000-0000-4000-8000-000000000001',
    'instagram',
    'scheduled',
    now() + interval '12 days',
    NULL, NULL, NULL,
    'Labs roadmap',
    NULL,
    NULL, 0, 0, NULL, NULL, NULL,
    now()
  ),
  (
    'f8000000-0000-4000-8000-000000000115',
    '20000000-0000-4000-8000-000000000005',
    'c4000000-0000-4000-8000-000000000001',
    '49000000-0000-4000-8000-000000000008',
    'e4000000-0000-4000-8000-000000000002',
    'facebook',
    'scheduled',
    now() + interval '28 days',
    NULL, NULL, NULL,
    'Labs roadmap',
    NULL,
    NULL, 0, 0, NULL, NULL, NULL,
    now()
  ),
  (
    'f8000000-0000-4000-8000-000000000116',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '49000000-0000-4000-8000-000000000009',
    'e3000000-0000-4000-8000-000000000001',
    'facebook',
    'queued',
    NULL,
    NULL, NULL, NULL,
    'Copy-only announcement',
    '{}'::uuid[],
    NULL, 0, 0, NULL, NULL, NULL,
    now() - interval '1 day'
  ),
  (
    'f8000000-0000-4000-8000-000000000117',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '49000000-0000-4000-8000-000000000010',
    'e0000000-0000-4000-8000-000000000002',
    'tiktok',
    'processing',
    NULL,
    NULL, NULL, NULL,
    'Rendering the cut',
    NULL,
    NULL, 0, 1, now() - interval '1 hour', NULL, NULL,
    now() - interval '20 hours'
  ),
  (
    'f8000000-0000-4000-8000-000000000118',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '49000000-0000-4000-8000-000000000011',
    'e0000000-0000-4000-8000-000000000001',
    'youtube',
    'awaiting_provider',
    NULL,
    NULL, NULL, NULL,
    'Waiting on the provider',
    NULL,
    NULL, 0, 2, now() - interval '30 minutes', NULL, NULL,
    now() - interval '18 hours'
  ),
  (
    'f8000000-0000-4000-8000-000000000119',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '49000000-0000-4000-8000-000000000012',
    'e3000000-0000-4000-8000-000000000002',
    'instagram',
    'cancel_requested',
    now() + interval '2 days',
    NULL, NULL, NULL,
    'Pull this one back',
    NULL,
    NULL, 0, 1, now() - interval '12 hours', NULL, NULL,
    now() - interval '12 hours'
  ),
  (
    'f8000000-0000-4000-8000-000000000120',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '49000000-0000-4000-8000-000000000013',
    'e0000000-0000-4000-8000-000000000001',
    'youtube',
    'cancelled',
    NULL,
    NULL, NULL, NULL,
    'Superseded teaser',
    NULL,
    'Cancelled before delivery.',
    0, 0, NULL, NULL, NULL,
    now()
  ),
  (
    'f8000000-0000-4000-8000-000000000121',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000002',
    '49000000-0000-4000-8000-000000000014',
    'e3000000-0000-4000-8000-000000000005',
    'youtube',
    'needs_reconciliation',
    NULL,
    NULL, NULL, NULL,
    'Provider mismatch',
    NULL,
    'The provider response did not confirm whether this post was published.',
    0, 3, now() - interval '5 days', 'publish_unverified', FALSE,
    now()
  ),
  (
    'f8000000-0000-4000-8000-000000000122',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '4b000000-0000-4000-8000-000000000007',
    'e0000000-0000-4000-8000-000000000001',
    'youtube',
    'published',
    NULL,
    now() - interval '1 hour',
    'local-post-two-channels',
    'https://example.invalid/watch/local-post-two-channels',
    'Two channels, one revoked',
    NULL,
    NULL, 0, 1, now() - interval '1 hour', NULL, NULL,
    now() - interval '1 hour'
  ),
  (
    'f8000000-0000-4000-8000-000000000123',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '4b000000-0000-4000-8000-000000000007',
    'e3000000-0000-4000-8000-000000000004',
    'tiktok',
    'published',
    NULL,
    now() - interval '1 hour',
    'local-post-two-channels-tiktok',
    'https://example.invalid/tiktok/local-post-two-channels-tiktok',
    'Two channels, one revoked',
    ARRAY['d7000000-0000-4000-8000-000000000002']::uuid[],
    NULL, 0, 1, now() - interval '1 hour', NULL, NULL,
    now() - interval '1 hour'
  ),
  (
    'f8000000-0000-4000-8000-000000000124',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000002',
    '4b000000-0000-4000-8000-000000000006',
    'e3000000-0000-4000-8000-000000000006',
    'tiktok',
    'failed',
    NULL,
    NULL, NULL, NULL,
    'Permanent provider failure',
    NULL,
    'Provider rejected the media format permanently.',
    1, 1, now() - interval '40 minutes', 'media_rejected', FALSE,
    now() - interval '50 minutes'
  )
ON CONFLICT (id) DO UPDATE
SET post_id = EXCLUDED.post_id,
    platform_account_id = EXCLUDED.platform_account_id,
    platform = EXCLUDED.platform,
    title_override = EXCLUDED.title_override,
    attachment_ids = EXCLUDED.attachment_ids,
    status = EXCLUDED.status,
    scheduled_at = EXCLUDED.scheduled_at,
    published_at = EXCLUDED.published_at,
    platform_post_id = EXCLUDED.platform_post_id,
    platform_url = EXCLUDED.platform_url,
    error_message = EXCLUDED.error_message,
    retry_count = EXCLUDED.retry_count,
    attempt_count = EXCLUDED.attempt_count,
    last_attempt_at = EXCLUDED.last_attempt_at,
    failure_code = EXCLUDED.failure_code,
    failure_retryable = EXCLUDED.failure_retryable,
    created_at = EXCLUDED.created_at,
    updated_at = now();

-- Claimed publish attempts. Three succeed and freeze the composition the
-- Channel published, which is what a row previews after later Post edits:
-- `…0001` froze two attachments, `…0002` one, and `…0003` a media-only
-- composition whose frozen Asset is no longer attached to its Post — the
-- detached slot the inspector and previews must keep showing as published
-- media rather than silently replacing with the Post's own order. `…0004`
-- failed verification and drives the needs-reconciliation fixture.
INSERT INTO provider_operations (
  id, org_id, distribution_id, operation, idempotency_key, status,
  provider_operation_id, provider_post_id, provider_url, error_class, last_error,
  attempt_count, created_at, updated_at, completed_at, publication_snapshot
)
VALUES
  (
    'a3000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000005',
    'f8000000-0000-4000-8000-000000000101',
    'publish',
    'seed-publish-f800-101',
    'succeeded',
    'local-op-launch-recap',
    'local-post-launch-recap',
    'https://example.invalid/watch/local-post-launch-recap',
    NULL, NULL,
    1, now() - interval '20 days', now() - interval '20 days', now() - interval '20 days',
    '{
       "version": 1,
       "post_id": "49000000-0000-4000-8000-000000000001",
       "content": {
         "title": "Launch day recap",
         "text": "Launch day is here 🚀\n\nWe shipped the new editor this morning.\n\n#launch #creator",
         "hashtags": ["#launch", "#creator"]
       },
       "media": [
         {"asset_id": "d7000000-0000-4000-8000-000000000001", "asset_type": "image", "content_type": "image/png", "duration_sec": null, "file_size": 262144, "height": 1350, "position": 0, "width": 1080},
         {"asset_id": "d7000000-0000-4000-8000-000000000002", "asset_type": "image", "content_type": "image/png", "duration_sec": null, "file_size": 331776, "height": 1080, "position": 1, "width": 1080}
       ]
     }'::jsonb
  ),
  (
    'a3000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000005',
    'f8000000-0000-4000-8000-000000000103',
    'publish',
    'seed-publish-f800-103',
    'succeeded',
    'local-op-recap-two-ways',
    'local-post-recap-two-ways',
    'https://example.invalid/watch/local-post-recap-two-ways',
    NULL, NULL,
    1, now() - interval '14 days', now() - interval '14 days', now() - interval '14 days',
    '{
       "version": 1,
       "post_id": "49000000-0000-4000-8000-000000000002",
       "content": {
         "title": "Recap, two ways",
         "text": "Full recap plus the short cut.",
         "hashtags": []
       },
       "media": [
         {"asset_id": "d7000000-0000-4000-8000-000000000003", "asset_type": "video", "content_type": "video/mp4", "duration_sec": 42, "file_size": 8388608, "height": 1080, "position": 0, "width": 1920}
       ]
     }'::jsonb
  ),
  (
    'a3000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000005',
    'f8000000-0000-4000-8000-000000000111',
    'publish',
    'seed-publish-f800-111',
    'succeeded',
    'local-op-media-only',
    'local-post-media-only',
    'https://example.invalid/watch/local-post-media-only',
    NULL, NULL,
    1, now() - interval '7 days', now() - interval '7 days', now() - interval '7 days',
    '{
       "version": 1,
       "post_id": "49000000-0000-4000-8000-000000000005",
       "content": {"title": "", "text": "", "hashtags": []},
       "media": [
         {"asset_id": "d7000000-0000-4000-8000-000000000004", "asset_type": "image", "content_type": "image/png", "duration_sec": null, "file_size": 0, "height": null, "position": 0, "width": null}
       ]
     }'::jsonb
  ),
  (
    'a3000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000005',
    'f8000000-0000-4000-8000-000000000121',
    'publish',
    'seed-publish-f800-121',
    'needs_reconciliation',
    'local-op-provider-mismatch',
    NULL,
    NULL,
    'provider_timeout',
    'The provider response did not confirm whether this post was published.',
    3, now() - interval '6 days', now() - interval '5 days', NULL,
    NULL
  )
ON CONFLICT (distribution_id, operation, idempotency_key) DO UPDATE
SET status = EXCLUDED.status,
    provider_operation_id = EXCLUDED.provider_operation_id,
    provider_post_id = EXCLUDED.provider_post_id,
    provider_url = EXCLUDED.provider_url,
    error_class = EXCLUDED.error_class,
    last_error = EXCLUDED.last_error,
    attempt_count = EXCLUDED.attempt_count,
    completed_at = EXCLUDED.completed_at,
    updated_at = now();

-- The media inventory each frozen publication holds, including the detached
-- slot above, so cleanup can tell held media from reclaimable bytes.
INSERT INTO provider_operation_media (
  operation_id, org_id, distribution_id, asset_id, brand_profile_id,
  rendition_id, object_id, object_key, position
)
VALUES
  (
    'a3000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000005',
    'f8000000-0000-4000-8000-000000000101',
    'd7000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'ac000000-0000-4000-8000-000000000001',
    '4c000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000005/d7000000-0000-4000-8000-000000000001/original',
    0
  ),
  (
    'a3000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000005',
    'f8000000-0000-4000-8000-000000000101',
    'd7000000-0000-4000-8000-000000000002',
    'c0000000-0000-4000-8000-000000000001',
    'ac000000-0000-4000-8000-000000000002',
    '4c000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000005/d7000000-0000-4000-8000-000000000002/original',
    1
  ),
  (
    'a3000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000005',
    'f8000000-0000-4000-8000-000000000103',
    'd7000000-0000-4000-8000-000000000003',
    'c0000000-0000-4000-8000-000000000001',
    'ac000000-0000-4000-8000-000000000003',
    '4c000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000005/d7000000-0000-4000-8000-000000000003/original',
    0
  ),
  (
    'a3000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000005',
    'f8000000-0000-4000-8000-000000000111',
    'd7000000-0000-4000-8000-000000000004',
    'c0000000-0000-4000-8000-000000000001',
    'ac000000-0000-4000-8000-000000000004',
    '4c000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000005/d7000000-0000-4000-8000-000000000004/original',
    0
  )
ON CONFLICT (operation_id, position) DO UPDATE
SET asset_id = EXCLUDED.asset_id,
    rendition_id = EXCLUDED.rendition_id,
    object_id = EXCLUDED.object_id,
    object_key = EXCLUDED.object_key;

-- Metric history for the two published demo Distributions, so the analytics
-- projection has a multi-point curve instead of a single reading.
INSERT INTO analytics_snapshots (
  id, distribution_id, org_id, views, likes, comments, shares,
  watch_time_sec, reach, impressions, snapshot_at
)
VALUES
  ('ab000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000101', '20000000-0000-4000-8000-000000000005', 640, 41, 5, 8, 1800, 480, 760, now() - interval '19 days'),
  ('ab000000-0000-4000-8000-000000000002', 'f8000000-0000-4000-8000-000000000101', '20000000-0000-4000-8000-000000000005', 1980, 132, 17, 24, 6100, 1490, 2380, now() - interval '12 days'),
  ('ab000000-0000-4000-8000-000000000003', 'f8000000-0000-4000-8000-000000000101', '20000000-0000-4000-8000-000000000005', 3640, 246, 33, 47, 11800, 2760, 4310, now() - interval '2 days'),
  ('ab000000-0000-4000-8000-000000000004', 'f8000000-0000-4000-8000-000000000103', '20000000-0000-4000-8000-000000000005', 910, 58, 6, 11, 2400, 690, 1010, now() - interval '13 days'),
  ('ab000000-0000-4000-8000-000000000005', 'f8000000-0000-4000-8000-000000000103', '20000000-0000-4000-8000-000000000005', 2265, 151, 19, 36, 5600, 1680, 2510, now() - interval '5 days'),
  ('ab000000-0000-4000-8000-000000000006', 'f8000000-0000-4000-8000-000000000122', '20000000-0000-4000-8000-000000000005', 118, 9, 1, 2, 320, 96, 150, now() - interval '30 minutes')
ON CONFLICT (id) DO UPDATE
SET views = EXCLUDED.views,
    likes = EXCLUDED.likes,
    comments = EXCLUDED.comments,
    shares = EXCLUDED.shares,
    watch_time_sec = EXCLUDED.watch_time_sec,
    reach = EXCLUDED.reach,
    impressions = EXCLUDED.impressions,
    snapshot_at = EXCLUDED.snapshot_at;

-- The demo workspace has to stay *usable*, not merely populated: the community
-- policy caps a period at ten uploads and thirty Distributions, and a workspace
-- already at its ceiling cannot be used to try the very flows these fixtures
-- demonstrate. The older half of the demo set therefore keeps its creation and
-- finalization instants in the previous period, which the current-period counter
-- (and the quota check behind it) does not count. Nothing displayed changes: a
-- Distribution's creation instant is not a rendered field, and a ready Asset is
-- previewable whenever it was finalized. The rows the counters do include are
-- exactly what a reconciliation recomputes, so the seeded `usage_records` values
-- stay authoritative.
UPDATE distributions
SET created_at = now() - interval '40 days',
    updated_at = now()
WHERE id IN (
  'f8000000-0000-4000-8000-000000000103',
  'f8000000-0000-4000-8000-000000000104',
  'f8000000-0000-4000-8000-000000000105',
  'f8000000-0000-4000-8000-000000000106',
  'f8000000-0000-4000-8000-000000000107',
  'f8000000-0000-4000-8000-000000000108',
  'f8000000-0000-4000-8000-000000000109',
  'f8000000-0000-4000-8000-000000000110',
  'f8000000-0000-4000-8000-000000000120'
);

UPDATE assets
SET finalized_at = now() - interval '40 days',
    updated_at = now()
WHERE id IN (
  'd7000000-0000-4000-8000-000000000003',
  'd7000000-0000-4000-8000-000000000004',
  'd7000000-0000-4000-8000-000000000007',
  'd8000000-0000-4000-8000-000000000001',
  'd8000000-0000-4000-8000-000000000002'
);

-- Usage meters for the demo workspace are written once, by the `usage_records`
-- insert above the demo set: an hourly reconciliation recomputes them from the
-- rows in this file exactly, so the sweep never rewrites the demo counters.

COMMIT;
