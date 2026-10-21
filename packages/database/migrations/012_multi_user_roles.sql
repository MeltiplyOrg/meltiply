-- meltiply-release-phase: expand
-- Multi-user Workspace roles, installation ownership, suspension, and audit.
--
-- One Installation Owner and one shared Workspace replace the single-owner
-- personal workspace model. Existing data stays attached to the Workspace the
-- owner already used; only the personal marker and the auth-user owner gate
-- are retired. Every content policy gains an explicit role predicate so
-- PostgreSQL remains the defense-in-depth authorization boundary.

-- ---------------------------------------------------------------------------
-- Workspace roles: admin, editor, viewer.
-- ---------------------------------------------------------------------------

ALTER TABLE org_members DROP CONSTRAINT IF EXISTS org_members_role_check;
UPDATE org_members SET role = 'editor' WHERE role = 'member';
ALTER TABLE org_members
    ADD CONSTRAINT org_members_role_check CHECK (role IN ('admin', 'editor', 'viewer'));
ALTER TABLE org_members ALTER COLUMN role SET DEFAULT 'viewer';

ALTER TABLE workspace_invitations DROP CONSTRAINT IF EXISTS workspace_invitations_role_check;
UPDATE workspace_invitations SET role = 'editor' WHERE role = 'member';
ALTER TABLE workspace_invitations
    ADD CONSTRAINT workspace_invitations_role_check
    CHECK (role IN ('admin', 'editor', 'viewer'));
ALTER TABLE workspace_invitations ALTER COLUMN role SET DEFAULT 'viewer';

-- ---------------------------------------------------------------------------
-- Installation ownership and account suspension on the internal user record.
-- The partial unique index is the final arbiter even for concurrent setup.
-- ---------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN installation_owner BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN suspended_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN suspension_reason TEXT;

UPDATE users u
SET installation_owner = TRUE
FROM "user" a
WHERE a.id = u.auth_user_id
  AND a."installationOwner";

-- A database created before the owner marker existed still gets one owner.
UPDATE users
SET installation_owner = TRUE
WHERE id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM users WHERE installation_owner);

CREATE UNIQUE INDEX one_installation_owner
    ON users ((TRUE))
    WHERE installation_owner;

-- ---------------------------------------------------------------------------
-- One shared Workspace. The owner's personal workspace (or, when absent, the
-- oldest workspace they belong to) becomes the shared Workspace in place, so
-- Brand Profiles, Channels, Posts, Assets, Distributions, and history stay
-- attached to the same tenant id.
-- ---------------------------------------------------------------------------

ALTER TABLE organizations ADD COLUMN is_shared BOOLEAN NOT NULL DEFAULT FALSE;

WITH owner AS (
    SELECT id FROM users WHERE installation_owner LIMIT 1
), picked AS (
    SELECT COALESCE(
        (SELECT o.id
         FROM organizations o, owner
         WHERE o.personal_user_id = owner.id
         ORDER BY o.created_at, o.id
         LIMIT 1),
        (SELECT om.org_id
         FROM org_members om, owner
         WHERE om.user_id = owner.id
         ORDER BY om.created_at, om.org_id
         LIMIT 1),
        (SELECT o.id FROM organizations o ORDER BY o.created_at, o.id LIMIT 1)
    ) AS id
)
UPDATE organizations o
SET is_shared = TRUE,
    updated_at = now()
FROM picked
WHERE o.id = picked.id;

INSERT INTO organizations (name, slug, is_shared)
SELECT COALESCE(
           NULLIF(btrim(regexp_replace(u.display_name, '[[:cntrl:]]+', ' ', 'g')), ''),
           split_part(u.email, '@', 1),
           'Meltiply'
       ) || '''s workspace',
       'workspace-' || replace(u.id::text, '-', ''),
       TRUE
FROM users u
WHERE u.installation_owner
  AND NOT EXISTS (SELECT 1 FROM organizations WHERE is_shared);

INSERT INTO org_members (org_id, user_id, role)
SELECT o.id, u.id, 'admin'
FROM organizations o
CROSS JOIN users u
WHERE o.is_shared
  AND u.installation_owner
ON CONFLICT (org_id, user_id) DO UPDATE
SET role = 'admin',
    updated_at = now();

INSERT INTO usage_reconciliation_state (org_id)
SELECT id FROM organizations WHERE is_shared
ON CONFLICT (org_id) DO NOTHING;

CREATE UNIQUE INDEX one_shared_workspace
    ON organizations ((TRUE))
    WHERE is_shared;

DROP INDEX IF EXISTS idx_organizations_personal_user;
ALTER TABLE organizations DROP COLUMN personal_user_id;

-- ---------------------------------------------------------------------------
-- Retire the auth-user-only owner gate. The internal users row owns ownership
-- from here on; Better Auth remains identity, session, and verification only.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS single_installation_owner;
DROP TRIGGER IF EXISTS revoke_account_sessions ON "user";
ALTER TABLE "user" DROP COLUMN "installationOwner";

CREATE OR REPLACE FUNCTION public.revoke_security_sessions() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'account' THEN
        IF OLD.password IS DISTINCT FROM NEW.password THEN
            DELETE FROM "session" WHERE "userId" = NEW."userId";
        END IF;
    ELSIF OLD."twoFactorEnabled" IS DISTINCT FROM NEW."twoFactorEnabled"
       OR OLD.email IS DISTINCT FROM NEW.email
       OR OLD."emailVerified" IS DISTINCT FROM NEW."emailVerified" THEN
        DELETE FROM "session" WHERE "userId" = NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS revoke_account_sessions ON "user";
CREATE TRIGGER revoke_account_sessions
AFTER UPDATE OF "twoFactorEnabled", email, "emailVerified" ON "user"
FOR EACH ROW EXECUTE FUNCTION public.revoke_security_sessions();

-- ---------------------------------------------------------------------------
-- Workspace Audit entries. System-owned writes; Workspace Admins read.
-- ---------------------------------------------------------------------------

CREATE TABLE workspace_audit_entries (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_email        TEXT NOT NULL,
    actor_display_name TEXT,
    action             TEXT NOT NULL,
    target_type        TEXT NOT NULL,
    target_id          TEXT NOT NULL,
    before_state       JSONB,
    after_state        JSONB,
    request_id         TEXT NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT workspace_audit_entries_action_check
        CHECK (length(action) BETWEEN 1 AND 100 AND action !~ '[[:cntrl:]]'),
    CONSTRAINT workspace_audit_entries_target_type_check
        CHECK (length(target_type) BETWEEN 1 AND 64 AND target_type !~ '[[:cntrl:]]'),
    CONSTRAINT workspace_audit_entries_target_id_check
        CHECK (length(target_id) BETWEEN 1 AND 256 AND target_id !~ '[[:cntrl:]]'),
    CONSTRAINT workspace_audit_entries_actor_email_check
        CHECK (length(actor_email) BETWEEN 1 AND 320 AND actor_email !~ '[[:cntrl:]]'),
    CONSTRAINT workspace_audit_entries_request_id_check
        CHECK (length(request_id) BETWEEN 1 AND 128 AND request_id !~ '[[:cntrl:]]')
);

CREATE INDEX idx_workspace_audit_entries_org_created
    ON workspace_audit_entries(org_id, created_at DESC, id DESC);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_system') THEN
        EXECUTE 'GRANT SELECT, INSERT ON workspace_audit_entries TO meltiply_system';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_rls') THEN
        EXECUTE 'REVOKE ALL ON workspace_audit_entries FROM meltiply_rls';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- RLS: active workspace always comes from the org claim; personal fallback and
-- the Owner bypass are gone. Content writes require editor or admin; brand
-- configuration and administration require admin.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_rls') THEN
        RAISE NOTICE 'meltiply_rls role unavailable; skipping RLS setup';
        RETURN;
    END IF;

    EXECUTE $fn$
        CREATE OR REPLACE FUNCTION public.auth_active_org_id()
        RETURNS uuid
        LANGUAGE sql
        STABLE
        SECURITY DEFINER
        SET search_path = public, auth, pg_temp
        AS $body$
            SELECT o.id
            FROM organizations o
            JOIN org_members om ON om.org_id = o.id
            JOIN users u ON u.id = om.user_id
            WHERE (
                u.auth_user_id = auth.jwt()->>'sub'
                OR u.id::text = auth.jwt()->>'sub'
            )
            AND NULLIF(auth.jwt()->>'org_id', '') IS NOT NULL
            AND o.id::text = auth.jwt()->>'org_id'
            LIMIT 1
        $body$
    $fn$;

    EXECUTE 'REVOKE ALL ON FUNCTION public.auth_active_org_id() FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.auth_active_org_id() TO meltiply_rls';

    EXECUTE 'GRANT SELECT ON TABLE workspace_audit_entries TO meltiply_rls';
    EXECUTE 'ALTER TABLE workspace_audit_entries ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "Admins can read workspace audit entries" ON workspace_audit_entries';
    EXECUTE $policy$
        CREATE POLICY "Admins can read workspace audit entries"
        ON workspace_audit_entries
        FOR SELECT
        TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() = 'admin'
        )
    $policy$;

    -- Content writes: editor or admin. Reads remain available to every member.
    EXECUTE 'DROP POLICY IF EXISTS "Users can insert assets in their active org" ON assets';
    EXECUTE 'DROP POLICY IF EXISTS "Users can update assets in their active org" ON assets';
    EXECUTE 'DROP POLICY IF EXISTS "Users can delete assets in their active org" ON assets';
    EXECUTE 'DROP POLICY IF EXISTS "Users can insert distributions in their active org" ON distributions';
    EXECUTE 'DROP POLICY IF EXISTS "Users can update distributions in their active org" ON distributions';
    EXECUTE 'DROP POLICY IF EXISTS "Users can insert usage records in their active org" ON usage_records';
    EXECUTE 'DROP POLICY IF EXISTS "Users can update usage records in their active org" ON usage_records';
    EXECUTE 'DROP POLICY IF EXISTS "Users can update comments in their active org" ON comments';
    EXECUTE 'DROP POLICY IF EXISTS "Users can manage idempotency in their active org" ON idempotency_keys';
    EXECUTE 'DROP POLICY IF EXISTS "Users can create outbox events in their active org" ON outbox_events';
    EXECUTE 'DROP POLICY IF EXISTS "Users can cancel unpublished outbox events" ON outbox_events';
    EXECUTE 'DROP POLICY IF EXISTS "Users can update unpublished outbox events" ON outbox_events';
    EXECUTE 'DROP POLICY IF EXISTS "Users can manage upload sessions in their active org" ON asset_upload_sessions';
    EXECUTE 'DROP POLICY IF EXISTS "Users can manage upload parts in their active org" ON asset_upload_parts';
    EXECUTE 'DROP POLICY IF EXISTS "Users can manage quota reservations in their active org" ON asset_quota_reservations';
    EXECUTE 'DROP POLICY IF EXISTS "Users can manage provider operations in their active org" ON provider_operations';
    EXECUTE 'DROP POLICY IF EXISTS "Users can lock their active organization" ON organization_locks';
    EXECUTE 'DROP POLICY IF EXISTS "Users can delete platform accounts in their active org" ON platform_accounts';
    EXECUTE 'DROP POLICY IF EXISTS "Users can insert posts in their active org" ON posts';
    EXECUTE 'DROP POLICY IF EXISTS "Users can update posts in their active org" ON posts';
    EXECUTE 'DROP POLICY IF EXISTS "Users can delete posts in their active org" ON posts';
    EXECUTE 'DROP POLICY IF EXISTS "Users can insert post attachments in their active org" ON post_attachments';
    EXECUTE 'DROP POLICY IF EXISTS "Users can update post attachments in their active org" ON post_attachments';
    EXECUTE 'DROP POLICY IF EXISTS "Users can delete post attachments in their active org" ON post_attachments';
    EXECUTE 'DROP POLICY IF EXISTS "Users can insert post targets in their active org" ON post_targets';
    EXECUTE 'DROP POLICY IF EXISTS "Users can update post targets in their active org" ON post_targets';
    EXECUTE 'DROP POLICY IF EXISTS "Users can delete post targets in their active org" ON post_targets';

    EXECUTE $policy$
        CREATE POLICY "Editors can write assets in their active org"
        ON assets FOR ALL TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
        WITH CHECK (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Editors can write distributions in their active org"
        ON distributions FOR ALL TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
        WITH CHECK (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Editors can write usage records in their active org"
        ON usage_records FOR ALL TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
        WITH CHECK (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Editors can update comments in their active org"
        ON comments FOR UPDATE TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
        WITH CHECK (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Editors can manage idempotency in their active org"
        ON idempotency_keys FOR ALL TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
        WITH CHECK (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Editors can create outbox events in their active org"
        ON outbox_events FOR INSERT TO meltiply_rls
        WITH CHECK (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Editors can cancel unpublished outbox events"
        ON outbox_events FOR DELETE TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
            AND state IN ('pending', 'failed')
        )
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Editors can update unpublished outbox events"
        ON outbox_events FOR UPDATE TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
            AND state IN ('pending', 'failed')
        )
        WITH CHECK (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Editors can manage upload sessions in their active org"
        ON asset_upload_sessions FOR ALL TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
        WITH CHECK (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Editors can manage upload parts in their active org"
        ON asset_upload_parts FOR ALL TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
        WITH CHECK (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Editors can manage quota reservations in their active org"
        ON asset_quota_reservations FOR ALL TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
        WITH CHECK (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Editors can manage provider operations in their active org"
        ON provider_operations FOR ALL TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
        WITH CHECK (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Editors can lock their active organization"
        ON organization_locks FOR ALL TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
        WITH CHECK (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Admins can delete platform accounts in their active org"
        ON platform_accounts FOR DELETE TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() = 'admin'
        )
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Editors can write posts in their active org"
        ON posts FOR ALL TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
        WITH CHECK (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Editors can write post attachments in their active org"
        ON post_attachments FOR ALL TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
        WITH CHECK (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Editors can write post targets in their active org"
        ON post_targets FOR ALL TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
        WITH CHECK (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() IN ('admin', 'editor')
        )
    $policy$;

    -- Invitations and member management are administration surfaces.
    EXECUTE 'DROP POLICY IF EXISTS "Users can view invitations in their active workspace" ON workspace_invitations';
    EXECUTE 'DROP POLICY IF EXISTS "Admins can manage invitations in their active workspace" ON workspace_invitations';
    EXECUTE $policy$
        CREATE POLICY "Admins can read invitations in their active workspace"
        ON workspace_invitations FOR SELECT TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() = 'admin'
        )
    $policy$;
    EXECUTE $policy$
        CREATE POLICY "Admins can manage invitations in their active workspace"
        ON workspace_invitations FOR ALL TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() = 'admin'
        )
        WITH CHECK (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() = 'admin'
        )
    $policy$;
END;
$$;
