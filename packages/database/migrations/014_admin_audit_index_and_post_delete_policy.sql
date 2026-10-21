-- meltiply-release-phase: expand

-- Idempotent service mutations look up a prior Audit entry by the full
-- (org_id, request_id, action, target_id) equality tuple before inserting.
-- The read-order index cannot seek on request_id, so without this index every
-- fresh mutation scans the Workspace's indefinitely retained history.
CREATE INDEX IF NOT EXISTS idx_workspace_audit_entries_request
    ON workspace_audit_entries(org_id, request_id, action, target_id);

-- Published history is administratively owned: Editors may delete drafts and
-- scheduled Posts, but only Admins may delete a Post that already reached a
-- Platform (or is awaiting confirmation). This mirrors the service-layer guard
-- so a direct authenticated transaction cannot cascade published Distributions
-- away. The restrictive policy ANDs with the permissive Editor/Admin write
-- policy; it never broadens access.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_rls') THEN
        RAISE NOTICE 'meltiply_rls role unavailable; skipping Post delete policy';
        RETURN;
    END IF;

    EXECUTE 'DROP POLICY IF EXISTS "Published Posts require admin deletion" ON posts';
    EXECUTE $policy$
        CREATE POLICY "Published Posts require admin deletion"
        ON posts AS RESTRICTIVE FOR DELETE TO meltiply_rls
        USING (
            public.auth_active_org_role() = 'admin'
            OR NOT EXISTS (
                SELECT 1
                FROM distributions
                WHERE distributions.post_id = posts.id
                  AND distributions.status IN ('published', 'awaiting_provider')
            )
        )
    $policy$;
END;
$$;
