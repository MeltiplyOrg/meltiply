BEGIN;

INSERT INTO "user" (id, name, email, "emailVerified")
VALUES
  ('auth_user_local_alpha', 'Alpha Creator', 'alpha@meltiply.local', TRUE),
  ('auth_user_local_beta', 'Beta Admin', 'beta@meltiply.local', TRUE),
  ('auth_user_local_gamma', 'Gamma Editor', 'gamma@meltiply.local', TRUE),
  ('auth_user_local_delta', 'Delta Viewer', 'delta@meltiply.local', TRUE),
  ('auth_user_local_epsilon', 'Epsilon Suspended', 'epsilon@meltiply.local', TRUE)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    email = EXCLUDED.email,
    "emailVerified" = EXCLUDED."emailVerified",
    "updatedAt" = now();

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
  ),
  (
    'auth_account_local_epsilon',
    'auth_user_local_epsilon',
    'credential',
    'auth_user_local_epsilon',
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
  ('10000000-0000-4000-8000-000000000004', 'auth_user_local_delta', 'delta@meltiply.local', 'Delta Viewer', FALSE),
  ('10000000-0000-4000-8000-000000000005', 'auth_user_local_epsilon', 'epsilon@meltiply.local', 'Epsilon Suspended', FALSE)
ON CONFLICT (id) DO UPDATE
SET auth_user_id = EXCLUDED.auth_user_id,
    email = EXCLUDED.email,
    display_name = EXCLUDED.display_name,
    updated_at = now();

UPDATE users
SET suspended_at = now() - interval '2 days',
    suspension_reason = 'On leave — sample suspended member'
WHERE id = '10000000-0000-4000-8000-000000000005';

UPDATE users
SET suspended_at = NULL,
    suspension_reason = NULL
WHERE id <> '10000000-0000-4000-8000-000000000005'
  AND (suspended_at IS NOT NULL OR suspension_reason IS NOT NULL);

UPDATE users
SET installation_owner = FALSE
WHERE installation_owner
  AND id <> '10000000-0000-4000-8000-000000000001';
UPDATE users
SET installation_owner = TRUE
WHERE id = '10000000-0000-4000-8000-000000000001';

INSERT INTO organizations (id, name, slug)
VALUES
  ('20000000-0000-4000-8000-000000000001', 'Alpha Studio', 'alpha-studio'),
  ('20000000-0000-4000-8000-000000000002', 'Beta Studio', 'beta-studio')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    slug = EXCLUDED.slug,
    updated_at = now();

UPDATE organizations
SET is_shared = FALSE
WHERE is_shared
  AND id <> '20000000-0000-4000-8000-000000000005';

INSERT INTO organizations (id, name, slug, is_shared)
VALUES
  (
    '20000000-0000-4000-8000-000000000005',
    'Alpha Creator''s workspace',
    'workspace-10000000000040008000000000000001',
    TRUE
  ),
  (
    '20000000-0000-4000-8000-000000000006',
    'Beta Studio Archive',
    'workspace-10000000000040008000000000000002',
    FALSE
  )
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    slug = EXCLUDED.slug,
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
  ('30000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000004', 'viewer'),
  ('30000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000005', 'viewer')
ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role;

UPDATE organizations SET is_shared = TRUE
WHERE id = '20000000-0000-4000-8000-000000000005';

INSERT INTO workspace_invitations (
  id, org_id, email, role, invited_by, token_hash, expires_at
)
VALUES (
  'f0000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000005',
  'pending.invitee@meltiply.local',
  'editor',
  '10000000-0000-4000-8000-000000000001',
  'seed-pending-invitation-token-hash',
  now() + interval '7 days'
)
ON CONFLICT (id) DO UPDATE
SET email = EXCLUDED.email,
    role = EXCLUDED.role,
    invited_by = EXCLUDED.invited_by,
    token_hash = EXCLUDED.token_hash,
    expires_at = EXCLUDED.expires_at,
    accepted_at = NULL,
    revoked_at = NULL,
    updated_at = now();

INSERT INTO workspace_audit_entries (
  id, org_id, actor_user_id, actor_email, actor_display_name,
  action, target_type, target_id, before_state, after_state, request_id, created_at
)
VALUES
  (
    'f0000000-0000-4000-8000-000000000011',
    '20000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000001',
    'alpha@meltiply.local',
    'Alpha Creator',
    'workspace.renamed',
    'workspace',
    '20000000-0000-4000-8000-000000000005',
    '{"name":"Alpha''s workspace","slug":"personal-alpha"}'::jsonb,
    '{"name":"Alpha Creator''s workspace","slug":"workspace-10000000000040008000000000000001"}'::jsonb,
    'seed-admin-demo-rename',
    now() - interval '6 days'
  ),
  (
    'f0000000-0000-4000-8000-000000000012',
    '20000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000001',
    'alpha@meltiply.local',
    'Alpha Creator',
    'invitation.created',
    'invitation',
    'f0000000-0000-4000-8000-000000000001',
    NULL,
    '{"email":"pending.invitee@meltiply.local","role":"editor"}'::jsonb,
    'seed-admin-demo-invite',
    now() - interval '5 days'
  ),
  (
    'f0000000-0000-4000-8000-000000000013',
    '20000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000001',
    'alpha@meltiply.local',
    'Alpha Creator',
    'member.role_changed',
    'member',
    '10000000-0000-4000-8000-000000000003',
    '{"role":"viewer"}'::jsonb,
    '{"role":"editor"}'::jsonb,
    'seed-admin-demo-role',
    now() - interval '4 days'
  ),
  (
    'f0000000-0000-4000-8000-000000000014',
    '20000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000001',
    'alpha@meltiply.local',
    'Alpha Creator',
    'account.suspended',
    'member',
    '10000000-0000-4000-8000-000000000005',
    '{"status":"active"}'::jsonb,
    '{"reason":"On leave — sample suspended member","status":"suspended"}'::jsonb,
    'seed-admin-demo-suspend',
    now() - interval '2 days'
  ),
  (
    'f0000000-0000-4000-8000-000000000015',
    '20000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000002',
    'beta@meltiply.local',
    'Beta Admin',
    'invitation.revoked',
    'invitation',
    'f0000000-0000-4000-8000-000000000099',
    '{"email":"former.member@meltiply.local","role":"viewer"}'::jsonb,
    NULL,
    'seed-admin-demo-revoke',
    now() - interval '1 day'
  )
ON CONFLICT (id) DO NOTHING;

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

DELETE FROM platform_accounts
WHERE platform = 'linkedin'
  AND id IN (
    'e3000000-0000-4000-8000-000000000002',
    'e4000000-0000-4000-8000-000000000002'
  );
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
    'revoked',
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
  ),
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
    now() - interval '2 hours'
  ),
  (
    'e3000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'instagram',
    'local-instagram-alpha',
    NULL,
    'local-only-not-a-provider-credential',
    ARRAY['upload', 'analytics'],
    '{"fixture": true}'::jsonb,
    'connected',
    now() - interval '1 day'
  ),
  (
    'e3000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'threads',
    'local-threads-alpha',
    '@alpha.threads',
    'local-only-not-a-provider-credential',
    ARRAY['upload', 'analytics'],
    '{"fixture": true}'::jsonb,
    'expiring',
    now() - interval '3 hours'
  )
ON CONFLICT (platform, platform_user_id) DO UPDATE
SET display_name = EXCLUDED.display_name,
    scopes = EXCLUDED.scopes,
    metadata = EXCLUDED.metadata,
    connection_status = EXCLUDED.connection_status,
    last_synced_at = EXCLUDED.last_synced_at,
    updated_at = now();

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
  ),
  (
    '48000000-0000-4000-8000-000000000007',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'Analytics cohort launch',
    'Two supported destinations published in the retained analytics cohort.',
    'active'
  ),
  (
    '48000000-0000-4000-8000-000000000008',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'Analytics Facebook Reel',
    'A Page Reel with lifetime insights in the analytics cohort.',
    'active'
  )
ON CONFLICT (id) DO UPDATE
SET title = EXCLUDED.title,
    default_text = EXCLUDED.default_text,
    status = EXCLUDED.status,
    updated_at = now();

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
  ),
  (
    'f0000000-0000-4000-8000-000000000006',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '48000000-0000-4000-8000-000000000007',
    'e3000000-0000-4000-8000-000000000002',
    'instagram',
    'published',
    NULL,
    now() - interval '3 days',
    'local-post-analytics-instagram',
    'https://example.invalid/instagram/local-post-analytics-instagram',
    'Analytics cohort launch',
    NULL,
    NULL, 0, 1, now() - interval '3 days', NULL, NULL
  ),
  (
    'f0000000-0000-4000-8000-000000000007',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '48000000-0000-4000-8000-000000000007',
    'e3000000-0000-4000-8000-000000000003',
    'threads',
    'published',
    NULL,
    now() - interval '4 days',
    'local-post-analytics-threads',
    'https://example.invalid/threads/local-post-analytics-threads',
    'Analytics cohort launch',
    NULL,
    NULL, 0, 1, now() - interval '4 days', NULL, NULL
  ),
  (
    'f0000000-0000-4000-8000-000000000008',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    '48000000-0000-4000-8000-000000000008',
    'e3000000-0000-4000-8000-000000000001',
    'facebook',
    'published',
    NULL,
    now() - interval '2 days',
    'local-post-analytics-facebook',
    'https://example.invalid/facebook/local-post-analytics-facebook',
    'Analytics Facebook Reel',
    NULL,
    NULL, 0, 1, now() - interval '2 days', NULL, NULL
  )
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
  ('aa000000-0000-4000-8000-000000000006', 'f0000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 1935, 148, 18, 44, 3900, 1600, 2200, now() - interval '8 hours'),
  ('aa000000-0000-4000-8000-000000000007', 'f0000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000005', 640, 42, 6, 8, 0, 0, 0, now() - interval '12 hours'),
  ('aa000000-0000-4000-8000-000000000008', 'f0000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000005', 310, 19, 4, 3, 0, 0, 0, now() - interval '10 hours'),
  ('aa000000-0000-4000-8000-000000000009', 'f0000000-0000-4000-8000-000000000008', '20000000-0000-4000-8000-000000000005', 180, 12, 2, 1, 0, 0, 0, now() - interval '9 hours')
ON CONFLICT (id) DO UPDATE
SET views = EXCLUDED.views,
    likes = EXCLUDED.likes,
    comments = EXCLUDED.comments,
    shares = EXCLUDED.shares,
    watch_time_sec = EXCLUDED.watch_time_sec,
    reach = EXCLUDED.reach,
    impressions = EXCLUDED.impressions,
    snapshot_at = EXCLUDED.snapshot_at;

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

INSERT INTO usage_records (
  org_id, period, uploads, distributions, api_calls, storage_bytes
)
VALUES
  ('20000000-0000-4000-8000-000000000001', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'), 1, 1, 12, 4096),
  ('20000000-0000-4000-8000-000000000002', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'), 1, 0, 3, 0),
  ('20000000-0000-4000-8000-000000000005', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'), 7, 20, 214, 18317312),
  ('20000000-0000-4000-8000-000000000006', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'), 0, 0, 3, 0),
  ('20000000-0000-4000-8000-000000000005', to_char((now() - interval '1 month') AT TIME ZONE 'UTC', 'YYYY-MM'), 3, 2, 96, 4194304)
ON CONFLICT (org_id, period) DO UPDATE
SET uploads = EXCLUDED.uploads,
    distributions = EXCLUDED.distributions,
    api_calls = EXCLUDED.api_calls,
    storage_bytes = EXCLUDED.storage_bytes,
    updated_at = now();

INSERT INTO brand_profiles (id, org_id, name, color)
VALUES
  ('c4000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'Alpha Labs', '#0f766e')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    color = EXCLUDED.color,
    updated_at = now();

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
    ARRAY['upload', 'analytics'],
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
    ARRAY['upload', 'analytics'],
    '{"fixture": true}'::jsonb,
    'expiring',
    now() - interval '3 hours',
    NULL
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
  ('4b000000-0000-4000-8000-000000000007', 'e0000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Two channels, one revoked', NULL, ARRAY['d7000000-0000-4000-8000-000000000002']::uuid[])
ON CONFLICT (post_id, platform_account_id) DO UPDATE
SET title_override = EXCLUDED.title_override,
    description_override = EXCLUDED.description_override,
    attachment_ids = EXCLUDED.attachment_ids,
    updated_at = now();

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
    'e0000000-0000-4000-8000-000000000002',
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

CREATE TEMP TABLE demo_analytics_campaign ON COMMIT DROP AS
WITH channels (ordinal, account_id, campaign, multiplier) AS (
  VALUES
    (1, 'e3000000-0000-4000-8000-000000000001'::uuid, 'Community dispatch', 3),
    (2, 'e3000000-0000-4000-8000-000000000002'::uuid, 'Studio journal', 5),
    (3, 'e3000000-0000-4000-8000-000000000003'::uuid, 'Creator conversation', 2),
    (4, 'e0000000-0000-4000-8000-000000000001'::uuid, 'Inside the launch', 12),
    (5, 'e0000000-0000-4000-8000-000000000002'::uuid, 'One-minute workshop', 9),
    (6, 'e3000000-0000-4000-8000-000000000006'::uuid, 'After-hours sessions', 7),
    (7, 'e4000000-0000-4000-8000-000000000001'::uuid, 'Build log', 4)
), publications AS (
  SELECT channels.*, account.org_id, account.brand_profile_id, account.platform,
    edition,
    (ordinal * 100 + edition) AS fixture_number,
    (date_trunc('day', now() AT TIME ZONE 'UTC')
      - make_interval(days => CASE WHEN edition <= 30 THEN edition * 3 - 2
                                  ELSE 90 + (edition - 30) * 30 END)
      + make_interval(hours => 6 + ((edition * 7 + ordinal * 3) % 17)))
      AT TIME ZONE 'UTC' AS published_at,
    media.images, media.videos
  FROM channels
  JOIN platform_accounts AS account ON account.id = channels.account_id
  CROSS JOIN generate_series(1, 36) AS editions(edition)
  CROSS JOIN LATERAL (
    SELECT
      array_agg(asset.id ORDER BY asset.id) FILTER (WHERE asset.asset_type = 'image') AS images,
      array_agg(asset.id ORDER BY asset.id) FILTER (WHERE asset.asset_type = 'video') AS videos
    FROM assets AS asset
    WHERE asset.brand_profile_id = account.brand_profile_id
      AND asset.status = 'ready'
  ) AS media
)
SELECT *,
  ('4f100000-0000-4000-8000-' || lpad(fixture_number::text, 12, '0'))::uuid AS post_id,
  ('f9000000-0000-4000-8000-' || lpad(fixture_number::text, 12, '0'))::uuid AS distribution_id,
  campaign || ' · ' || lpad(edition::text, 2, '0') AS title,
  CASE
    WHEN platform IN ('youtube', 'tiktok') AND videos IS NOT NULL THEN videos[1:1]
    WHEN edition % 4 = 0 THEN ARRAY[]::uuid[]
    WHEN edition % 4 = 1 AND cardinality(images) >= 2 THEN images[1:2]
    WHEN edition % 4 = 2 AND videos IS NOT NULL THEN videos[1:1]
    ELSE images[1:1]
  END AS attachment_ids,
  (multiplier * (160 + (37 - edition) * 19 + (edition * 83 % 470))
    * CASE WHEN edition % 11 = 0 THEN 5 WHEN edition % 7 = 0 THEN 0.35 ELSE 1 END)::bigint
    AS final_views
FROM publications;

INSERT INTO posts (id, org_id, brand_profile_id, title, default_text, status, created_at)
SELECT post_id, org_id, brand_profile_id, title,
  campaign || ': ' || (ARRAY[
    'A practical look behind the scenes, with the details that made the difference.',
    'Three lessons from this week. What would you like us to explore next?',
    'From the first sketch to the finished release — the full story.',
    'A small experiment, a surprising result, and the next idea to try.'
  ])[1 + edition % 4], 'active', published_at - interval '2 days'
FROM demo_analytics_campaign
ON CONFLICT (id) DO UPDATE
SET title = EXCLUDED.title, default_text = EXCLUDED.default_text,
    created_at = EXCLUDED.created_at, updated_at = now();

INSERT INTO post_attachments (post_id, asset_id, org_id, brand_profile_id, position)
SELECT campaign.post_id, attachment.asset_id, campaign.org_id, campaign.brand_profile_id,
  (attachment.position - 1)::integer
FROM demo_analytics_campaign AS campaign
CROSS JOIN LATERAL unnest(campaign.attachment_ids) WITH ORDINALITY AS attachment(asset_id, position)
ON CONFLICT (post_id, position) DO UPDATE SET asset_id = EXCLUDED.asset_id;

INSERT INTO post_targets (
  post_id, platform_account_id, org_id, brand_profile_id, title_override, attachment_ids
)
SELECT post_id, account_id, org_id, brand_profile_id, title, attachment_ids
FROM demo_analytics_campaign
ON CONFLICT (post_id, platform_account_id) DO UPDATE
SET title_override = EXCLUDED.title_override, attachment_ids = EXCLUDED.attachment_ids,
    updated_at = now();

INSERT INTO distributions (
  id, org_id, brand_profile_id, post_id, platform_account_id, platform, status,
  published_at, platform_post_id, platform_url, title_override, attachment_ids, created_at
)
SELECT distribution_id, org_id, brand_profile_id, post_id, account_id, platform, 'published',
  published_at, 'local-campaign-' || fixture_number,
  'https://example.invalid/' || platform || '/local-campaign-' || fixture_number,
  title, attachment_ids,
  LEAST(published_at - interval '2 days',
    date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '1 second')
FROM demo_analytics_campaign
ON CONFLICT (id) DO UPDATE
SET published_at = EXCLUDED.published_at, attachment_ids = EXCLUDED.attachment_ids,
    title_override = EXCLUDED.title_override, created_at = EXCLUDED.created_at,
    updated_at = now();

INSERT INTO analytics_snapshots (
  id, distribution_id, org_id, views, likes, comments, shares,
  watch_time_sec, reach, impressions, snapshot_at
)
SELECT
  ('ae000000-0000-4000-8000-' || lpad((fixture_number * 10 + reading.step)::text, 12, '0'))::uuid,
  distribution_id, org_id,
  (final_views * reading.fraction)::bigint,
  (final_views * reading.fraction * (0.035 + (edition % 5) * 0.009))::bigint,
  (final_views * reading.fraction * (0.003 + (edition % 3) * 0.002))::bigint,
  (final_views * reading.fraction * (0.006 + (edition % 4) * 0.003))::bigint,
  CASE WHEN platform IN ('youtube', 'tiktok') THEN (final_views * reading.fraction * 12)::bigint ELSE 0 END,
  CASE WHEN platform IN ('youtube', 'tiktok', 'facebook') THEN (final_views * reading.fraction * 0.78)::bigint ELSE 0 END,
  CASE WHEN platform IN ('youtube', 'tiktok', 'facebook') THEN (final_views * reading.fraction * 1.24)::bigint ELSE 0 END,
  published_at + LEAST(reading.elapsed, (now() - interval '1 hour' - published_at) * reading.fraction)
FROM demo_analytics_campaign
CROSS JOIN (VALUES
  (1, 0.15, interval '1 hour'),
  (2, 0.48, interval '6 hours'),
  (3, 1.0, interval '2 days')
) AS reading(step, fraction, elapsed)
ON CONFLICT (id) DO UPDATE
SET views = EXCLUDED.views, likes = EXCLUDED.likes, comments = EXCLUDED.comments,
    shares = EXCLUDED.shares, watch_time_sec = EXCLUDED.watch_time_sec,
    reach = EXCLUDED.reach, impressions = EXCLUDED.impressions,
    snapshot_at = EXCLUDED.snapshot_at;

INSERT INTO platform_account_snapshots
  (id, platform_account_id, org_id, followers, following, posts, captured_at, raw_data)
SELECT
  ('af000000-0000-4000-8000-' || lpad((channel.ordinal * 1000 + day.age)::text, 12, '0'))::uuid,
  channel.account_id, channel.org_id,
  (CASE channel.platform
    WHEN 'instagram' THEN 12400 WHEN 'threads' THEN 8300 WHEN 'facebook' THEN 5100
    WHEN 'tiktok' THEN 21600 WHEN 'youtube' THEN 34800
  END + channel.account_rank * 137
    + (56 - day.age) * channel.weekly_gain / 7.0
    + sin(day.age / 4.0 + channel.ordinal) * channel.weekly_gain * 0.3
    + CASE WHEN day.age < 18 THEN (18 - day.age) * channel.weekly_gain * 0.15 ELSE 0 END)::bigint,
  120 + channel.ordinal * 31,
  400 + (365 - day.age) / 3,
  CASE WHEN day.age = 0 THEN now()
    ELSE (date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => day.age))
      AT TIME ZONE 'UTC' END,
  '{"fixture": true, "seed": "analytics-campaign"}'::jsonb
FROM (
  SELECT roster.*, row_number() OVER (ORDER BY account_id) AS account_rank,
    CASE platform WHEN 'instagram' THEN 42 WHEN 'threads' THEN 31
      WHEN 'facebook' THEN 18 WHEN 'tiktok' THEN 96 WHEN 'youtube' THEN 125 END AS weekly_gain
  FROM (
    SELECT DISTINCT ordinal, account_id, org_id, platform
    FROM demo_analytics_campaign
  ) AS roster
) AS channel
CROSS JOIN (
  SELECT generate_series(0, 90) AS age
  UNION ALL
  SELECT generate_series(97, 363, 7) AS age
) AS day
ON CONFLICT (id) DO UPDATE
SET followers = EXCLUDED.followers, following = EXCLUDED.following,
    posts = EXCLUDED.posts, captured_at = EXCLUDED.captured_at,
    raw_data = EXCLUDED.raw_data;

DELETE FROM publishing_queue_memberships
WHERE left(id::text, 8) = '5d000000'
  AND (assigned_at < now() - interval '5 weeks' OR assigned_at > now() + interval '5 weeks');

DELETE FROM posts
WHERE left(id::text, 8) IN ('5c000000', '5f000000')
  AND NOT EXISTS (
    SELECT 1
    FROM publishing_queue_memberships membership
    WHERE membership.post_id = posts.id
      AND membership.released_at IS NULL
  );

INSERT INTO publishing_queues (id, org_id, brand_profile_id, name, timezone, slots)
VALUES
  (
    '5a000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'Morning momentum',
    'Europe/Berlin',
    '[{"weekday":1,"time":"09:00"},{"weekday":2,"time":"07:30"},{"weekday":3,"time":"09:00"},
      {"weekday":4,"time":"07:30"},{"weekday":5,"time":"09:00"},{"weekday":6,"time":"10:00"}]'::jsonb
  ),
  (
    '5a000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    'Evening spotlight',
    'America/New_York',
    '[{"weekday":1,"time":"18:00"},{"weekday":2,"time":"18:00"},{"weekday":3,"time":"18:00"},
      {"weekday":4,"time":"18:00"},{"weekday":5,"time":"17:00"},{"weekday":0,"time":"19:30"}]'::jsonb
  ),
  (
    '5a000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000005',
    'c4000000-0000-4000-8000-000000000001',
    'Labs briefings',
    'Asia/Kathmandu',
    '[{"weekday":2,"time":"11:15"},{"weekday":4,"time":"11:15"},{"weekday":6,"time":"09:45"}]'::jsonb
  ),
  (
    '5a000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000002',
    'Nights drops',
    'Pacific/Auckland',
    '[{"weekday":1,"time":"20:00"},{"weekday":4,"time":"20:00"},{"weekday":5,"time":"21:15"}]'::jsonb
  )
ON CONFLICT (id) DO UPDATE
SET brand_profile_id = EXCLUDED.brand_profile_id,
    name = EXCLUDED.name,
    timezone = EXCLUDED.timezone,
    slots = EXCLUDED.slots,
    deleted_at = NULL,
    updated_at = now();

CREATE TEMP TABLE queue_demo_accounts ON COMMIT DROP AS
SELECT *
FROM (
  VALUES
    ('5a000000-0000-4000-8000-000000000001'::uuid, 'e3000000-0000-4000-8000-000000000003'::uuid, 'threads'),
    ('5a000000-0000-4000-8000-000000000002'::uuid, 'e3000000-0000-4000-8000-000000000001'::uuid, 'facebook'),
    ('5a000000-0000-4000-8000-000000000003'::uuid, 'e4000000-0000-4000-8000-000000000001'::uuid, 'instagram'),
    ('5a000000-0000-4000-8000-000000000004'::uuid, 'e3000000-0000-4000-8000-000000000005'::uuid, 'youtube')
) AS accounts(queue_id, platform_account_id, platform);

CREATE TEMP TABLE queue_demo_filled ON COMMIT DROP AS
SELECT occurrence.*,
       row_number() OVER (PARTITION BY occurrence.queue_id ORDER BY occurrence.assigned_at) AS seq
FROM (
  SELECT plan.id AS queue_id,
         plan.brand_profile_id,
         plan.name AS queue_name,
         plan.timezone,
         slot.time AS slot_time,
         wall.wall_time AT TIME ZONE plan.timezone AS assigned_at
  FROM publishing_queues plan
  CROSS JOIN LATERAL jsonb_to_recordset(plan.slots) AS slot(weekday integer, time text)
  CROSS JOIN generate_series(-2, 2) AS weeks(week_offset)
  CROSS JOIN LATERAL (
    SELECT date_trunc('week', (now() AT TIME ZONE plan.timezone))::date
           + ((slot.weekday + 6) % 7)
           + (slot.time)::time
           + make_interval(weeks => weeks.week_offset) AS wall_time
  ) AS wall
  WHERE left(plan.id::text, 8) = '5a000000'
    AND ((wall.wall_time AT TIME ZONE plan.timezone) AT TIME ZONE plan.timezone) = wall.wall_time
) AS occurrence;

INSERT INTO posts (id, org_id, brand_profile_id, title, default_text, status, created_at, updated_at)
SELECT ('5c000000-0000-4000-8000-' || substr(md5(fill.queue_id::text || ':' || fill.assigned_at::text), 1, 12))::uuid,
       '20000000-0000-4000-8000-000000000005',
       fill.brand_profile_id,
       caption.title,
       caption.title || E'\n\nQueued from ' || fill.queue_name || '.' || E'\n\n#creator #publishing',
       'active',
       least(now() - interval '1 hour', fill.assigned_at - interval '3 days'),
       now()
FROM queue_demo_filled fill
CROSS JOIN LATERAL (
  SELECT (ARRAY[
    'Studio reset',
    'Three hooks',
    'Weekly planning',
    'Editor sprint notes',
    'Community Q&A',
    'One idea, five cuts',
    'Pre-publish checklist',
    'Launch recap',
    'Scheduling notes',
    'First-month lessons'
  ])[1 + (abs(hashtext(fill.queue_id::text || fill.assigned_at::text)::bigint) % 10)] AS title
) AS caption
WHERE fill.seq % 4 <> 3
ON CONFLICT (id) DO UPDATE
SET title = EXCLUDED.title,
    default_text = EXCLUDED.default_text,
    status = 'active',
    deleted_at = NULL,
    updated_at = now();

INSERT INTO publishing_queue_memberships (
  id, org_id, brand_profile_id, queue_id, post_id, queue_name, assigned_at
)
SELECT ('5d000000-0000-4000-8000-' || substr(md5(fill.queue_id::text || ':' || fill.assigned_at::text), 1, 12))::uuid,
       '20000000-0000-4000-8000-000000000005',
       fill.brand_profile_id,
       fill.queue_id,
       ('5c000000-0000-4000-8000-' || substr(md5(fill.queue_id::text || ':' || fill.assigned_at::text), 1, 12))::uuid,
       fill.queue_name,
       fill.assigned_at
FROM queue_demo_filled fill
WHERE fill.seq % 4 <> 3
ON CONFLICT (id) DO UPDATE
SET assigned_at = EXCLUDED.assigned_at,
    queue_name = EXCLUDED.queue_name,
    released_at = NULL;

INSERT INTO distributions (
  id, org_id, brand_profile_id, post_id, platform_account_id, platform, status,
  scheduled_at, published_at, platform_post_id, platform_url, attachment_ids,
  error_message, retry_count, attempt_count, last_attempt_at, created_at, updated_at
)
SELECT ('5e000000-0000-4000-8000-' || substr(md5(fill.queue_id::text || ':' || fill.assigned_at::text), 1, 12))::uuid,
       '20000000-0000-4000-8000-000000000005',
       fill.brand_profile_id,
       ('5c000000-0000-4000-8000-' || substr(md5(fill.queue_id::text || ':' || fill.assigned_at::text), 1, 12))::uuid,
       account.platform_account_id,
       account.platform,
       CASE WHEN fill.assigned_at <= now() THEN 'published' ELSE 'scheduled' END,
       fill.assigned_at,
       CASE WHEN fill.assigned_at <= now() THEN fill.assigned_at + interval '2 minutes' END,
       CASE WHEN fill.assigned_at <= now()
            THEN 'demo-' || substr(md5(fill.queue_id::text || ':' || fill.assigned_at::text), 1, 10) END,
       CASE WHEN fill.assigned_at <= now()
            THEN 'https://example.invalid/demo/' || substr(md5(fill.queue_id::text || ':' || fill.assigned_at::text), 1, 10) END,
       NULL,
       NULL,
       0,
       CASE WHEN fill.assigned_at <= now() THEN 1 ELSE 0 END,
       CASE WHEN fill.assigned_at <= now() THEN fill.assigned_at + interval '2 minutes' END,
       now() - interval '40 days',
       now()
FROM queue_demo_filled fill
JOIN queue_demo_accounts account ON account.queue_id = fill.queue_id
WHERE fill.seq % 4 <> 3
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status,
    scheduled_at = EXCLUDED.scheduled_at,
    published_at = EXCLUDED.published_at,
    platform_post_id = EXCLUDED.platform_post_id,
    platform_url = EXCLUDED.platform_url,
    attempt_count = EXCLUDED.attempt_count,
    last_attempt_at = EXCLUDED.last_attempt_at,
    updated_at = now();

UPDATE distributions AS distribution
SET status = 'failed',
    published_at = NULL,
    platform_post_id = NULL,
    platform_url = NULL,
    error_message = 'Provider rejected the publish request: rate limited.',
    failure_code = 'provider_rate_limited',
    failure_retryable = TRUE,
    attempt_count = 2,
    updated_at = now()
FROM publishing_queue_memberships AS membership
WHERE membership.post_id = distribution.post_id
  AND left(distribution.id::text, 8) = '5e000000'
  AND distribution.status = 'published'
  AND membership.released_at IS NULL
  AND membership.assigned_at = (
    SELECT max(elapsed.assigned_at)
    FROM publishing_queue_memberships AS elapsed
    WHERE elapsed.queue_id = membership.queue_id
      AND elapsed.released_at IS NULL
      AND elapsed.assigned_at < now()
  );

CREATE TEMP TABLE queue_demo_off_plan ON COMMIT DROP AS
SELECT *
FROM (
  VALUES
    ('01'::text, 'c0000000-0000-4000-8000-000000000001'::uuid,
     'e3000000-0000-4000-8000-000000000003'::uuid, 'threads'::text,
     'Off-plan: a midweek teardown'::text, interval '2 days 13 hours 15 minutes'),
    ('02', 'c0000000-0000-4000-8000-000000000002',
     'e3000000-0000-4000-8000-000000000006', 'tiktok',
     'Off-plan: the clip everyone asked for', interval '4 days 21 hours 45 minutes'),
    ('03', 'c4000000-0000-4000-8000-000000000001',
     'e4000000-0000-4000-8000-000000000002', 'linkedin',
     'Off-plan: a short note on craft', interval '6 days 8 hours 15 minutes'),
    ('04', 'c0000000-0000-4000-8000-000000000001',
     'e3000000-0000-4000-8000-000000000001', 'facebook',
     'Off-plan: the long-form recap', interval '9 days 16 hours 45 minutes')
) AS off_plan(slug, brand_profile_id, platform_account_id, platform, title, scheduled_after);

INSERT INTO posts (id, org_id, brand_profile_id, title, default_text, status, created_at, updated_at)
SELECT ('5f000000-0000-4000-8000-0000000000' || off_plan.slug)::uuid,
       '20000000-0000-4000-8000-000000000005',
       off_plan.brand_profile_id,
       off_plan.title,
       off_plan.title || E'\n\nScheduled by hand, outside the weekly plan.',
       'active',
       now() - interval '40 days',
       now()
FROM queue_demo_off_plan off_plan
ON CONFLICT (id) DO UPDATE
SET title = EXCLUDED.title,
    default_text = EXCLUDED.default_text,
    status = 'active',
    deleted_at = NULL,
    updated_at = now();

INSERT INTO distributions (
  id, org_id, brand_profile_id, post_id, platform_account_id, platform, status,
  scheduled_at, published_at, attachment_ids, error_message, retry_count,
  attempt_count, last_attempt_at, created_at, updated_at
)
SELECT ('5e000000-0000-4000-8000-0000000000' || off_plan.slug)::uuid,
       '20000000-0000-4000-8000-000000000005',
       off_plan.brand_profile_id,
       ('5f000000-0000-4000-8000-0000000000' || off_plan.slug)::uuid,
       off_plan.platform_account_id,
       off_plan.platform,
       'scheduled',
       date_trunc('hour', now()) + off_plan.scheduled_after,
       NULL,
       NULL,
       NULL,
       0,
       0,
       NULL,
       now() - interval '40 days',
       now()
FROM queue_demo_off_plan off_plan
ON CONFLICT (id) DO UPDATE
SET status = 'scheduled',
    scheduled_at = EXCLUDED.scheduled_at,
    published_at = NULL,
    updated_at = now();

INSERT INTO posts (id, org_id, brand_profile_id, title, default_text, status, created_at)
VALUES
  ('4d000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Native Page draft', 'A native Page draft waiting for review in Facebook.', 'active', now()),
  ('4d000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Finish in TikTok', 'Complete this handed-off draft in the TikTok app.', 'active', now()),
  ('4d000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Prepared Live broadcast', 'Connect an external encoder to start this broadcast.', 'active', now()),
  ('4d000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Published with a secondary-share warning', 'The Threads Post succeeded; its secondary Instagram Story share did not.', 'active', now()),
  ('4d000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'Instagram published without all requested content', 'This caption was requested, but Instagram published the media without attaching it.', 'active', now())
ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, default_text = EXCLUDED.default_text;

INSERT INTO distributions (id, org_id, brand_profile_id, post_id, platform_account_id, platform,
  status, provider_options, provider_operation_id, provider_warnings, platform_post_id, published_at, attachment_ids)
VALUES
  ('4d100000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', '4d000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'facebook', 'delivered', '{"facebook":{"postType":"feed","deliveryMode":"draft"}}', 'post_draft:99801', '[]', NULL, NULL, '{}'),
  ('4d100000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', '4d000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000002', 'tiktok', 'delivered', '{"tiktok":{"postMode":"inbox","allowComment":false,"allowDuet":false,"allowStitch":false,"brandContent":false,"brandOrganic":false,"isAiGenerated":false,"musicUsageConfirmed":true}}', 'inbox:preview-only-publish-id', '[]', NULL, NULL, '{}'),
  ('4d100000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', '4d000000-0000-4000-8000-000000000003', 'e3000000-0000-4000-8000-000000000001', 'facebook', 'delivered', '{"facebook":{"postType":"live"}}', 'live:99803', '[]', NULL, NULL, '{}'),
  ('4d100000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', '4d000000-0000-4000-8000-000000000004', 'e3000000-0000-4000-8000-000000000003', 'threads', 'published', '{"threads":{"crossreshare_to_ig":true}}', 'created:99804', '["instagram_crossshare_failed"]', 'preview-only-threads-post', now(), '{}'),
  ('4d100000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', '4d000000-0000-4000-8000-000000000005', 'e3000000-0000-4000-8000-000000000002', 'instagram', 'published', '{"instagram":{"postType":"feed"}}', 'created:99805', '["instagram_publish_partial"]', 'preview-only-instagram-post', now(), '{}')
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, provider_options = EXCLUDED.provider_options,
  provider_operation_id = EXCLUDED.provider_operation_id, provider_warnings = EXCLUDED.provider_warnings,
  platform_post_id = EXCLUDED.platform_post_id, published_at = EXCLUDED.published_at;

INSERT INTO post_targets (post_id, platform_account_id, org_id, brand_profile_id, provider_options, attachment_ids)
SELECT post_id, platform_account_id, org_id, brand_profile_id, provider_options, attachment_ids
FROM distributions
WHERE id IN ('4d100000-0000-4000-8000-000000000001', '4d100000-0000-4000-8000-000000000002',
  '4d100000-0000-4000-8000-000000000003', '4d100000-0000-4000-8000-000000000004',
  '4d100000-0000-4000-8000-000000000005')
ON CONFLICT (post_id, platform_account_id) DO UPDATE SET provider_options = EXCLUDED.provider_options;

COMMIT;
