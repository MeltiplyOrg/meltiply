-- meltiply-release-phase: expand
-- Authenticated write access to the staging asset-object inventory.
--
-- Migration 003 made asset_objects the single source of truth for every
-- inventoried object but granted meltiply_rls SELECT only, so the API's
-- tenant transaction could not insert the staging row, record the write-hold
-- deadline, transfer the quota reservation, or settle verified bytes. This
-- migration grants those writes exclusively over the member's own staging
-- rows: an authenticated INSERT must name a staging object key under the
-- bucket-root staging/<org>/<asset>/ namespace, a 'writing' status, and no
-- charged bytes; the mutable column list is exactly the set the upload
-- lifecycle writes; and a restrictive UPDATE policy turns an attempted
-- mutation of an original, thumbnail, or rendition row into an error rather
-- than a silent no-op. Members still hold no DELETE grant, so per-object
-- removal stays a system transition.
--
-- The system role keeps ALL privileges: processing, promotion, purge, and
-- cleanup continue to run with unrestricted inventory access.

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_rls'
    ) THEN
        RAISE NOTICE 'meltiply_rls role unavailable; skipping staging object grants';
        RETURN;
    END IF;

    -- INSERT is whole-row but the WITH CHECK below constrains every mutable
    -- shape. UPDATE is column-scoped to the fields the upload lifecycle
    -- actually settles: a member can never rewrite identity, ownership, kind,
    -- key, or decoded media dimensions.
    EXECUTE 'GRANT INSERT ON TABLE asset_objects TO meltiply_rls';
    EXECUTE 'GRANT UPDATE (status, write_hold_until, reserved_bytes, bytes, etag, version, sha256, content_type, updated_at) ON TABLE asset_objects TO meltiply_rls';

    -- An authenticated staging row is always an unfinished upload: it lives in
    -- the active workspace, carries no verified size or reservation yet, holds
    -- no writer deadline before its first URL is minted, and uses a key under
    -- staging/<org>/<asset>/ so the write capability can never name a
    -- publishable path.
    EXECUTE $policy$
        CREATE POLICY "Members can insert staging asset objects in their active org"
        ON asset_objects
        FOR INSERT TO meltiply_rls
        WITH CHECK (
            org_id = (SELECT public.auth_active_org_id())
            AND kind = 'staging'
            AND profile IS NULL
            AND status = 'writing'
            AND bytes IS NULL
            AND reserved_bytes IS NULL
            AND write_hold_until IS NULL
            AND deleted_at IS NULL
            AND r2_key LIKE 'staging/' || org_id::text || '/' || asset_id::text || '/%'
        )
    $policy$;

    -- The upload lifecycle moves a staging row through 'writing' -> 'ready'
    -- (verified settle) and 'writing'/'ready' -> 'deleting' (abort, expiry, or
    -- reclaim handoff). 'deleted' and 'superseded' stay system-owned terminal
    -- transitions so a member cannot release accounting or retire a byte
    -- inventory row before its external delete completes. Row visibility for
    -- the update stays whole-org so a mutation aimed at a protected original,
    -- thumbnail, or rendition row fails the WITH CHECK as an error instead of
    -- filtering the row out as a silent no-op.
    EXECUTE $policy$
        CREATE POLICY "Members can update staging asset objects in their active org"
        ON asset_objects
        FOR UPDATE TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
        WITH CHECK (
            org_id = (SELECT public.auth_active_org_id())
            AND kind = 'staging'
            AND status IN ('writing', 'ready', 'deleting')
        )
    $policy$;
END;
$$;

COMMIT;
