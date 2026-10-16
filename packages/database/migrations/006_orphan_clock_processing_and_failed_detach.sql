-- meltiply-release-phase: expand
-- Orphan-clock corrections for finalized uploads.
--
-- Two defects in migration 003 made a saved draft lose its media:
--
--   1. assets_orphan_unfinalized_check barred a 'processing' Asset from
--      carrying any orphan clock. But a completed upload is exactly the state
--      that starts async processing, and the API's completion path sets
--      status = 'processing' while arming the orphan clock for an upload that
--      is not yet attached to a Post. The first upload a creator saves was
--      therefore rejected at finalization, because the very clock that makes
--      an unowned upload reclaimable was forbidden in its own finalized
--      state. 'processing' is a finalized source, not an unfinished upload:
--      the upload is complete and its bytes are resident, so it may carry the
--      clock. 'pending_upload' and 'uploading' are genuinely unfinished and
--      stay clockless, as does 'deleting' (already claimed for reclamation).
--
--   2. post_attachments_maintain_orphan_clock() returned from its first
--      TG_OP = 'DELETE' branch, which only handled status = 'ready', so the
--      later widened branch that also handled 'failed' was unreachable.
--      Detaching the last attachment from a saved draft whose processing had
--      failed never armed the seven-day window, leaving a reclaimed candidate
--      with no deadline instead of a grace period.
--
-- The fix keeps 003 in place: this migration only relaxes the constraint to
-- the precise set that is correct and replaces the trigger function body. The
-- existing triggers keep firing against the same function name, so no trigger
-- has to be recreated and no caller changes.

BEGIN;

ALTER TABLE assets
    DROP CONSTRAINT IF EXISTS assets_orphan_unfinalized_check;

-- A finalized Asset may carry the paired orphan clock; only an upload that has
-- not produced resident bytes yet, or one already claimed for reclamation,
-- must not. The paired-clock shape (both columns set together, deadline never
-- before the orphan instant) stays enforced by
-- assets_orphan_deadline_shape_check.
ALTER TABLE assets
    ADD CONSTRAINT assets_orphan_unfinalized_check CHECK (
        orphaned_at IS NULL
        OR status NOT IN ('pending_upload', 'uploading', 'deleting')
    );

-- Single, unconditional detach branch. Replaces the 003 body whose first
-- DELETE branch returned early and shadowed its own 'failed' handling.
CREATE OR REPLACE FUNCTION public.post_attachments_maintain_orphan_clock()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
    target assets;
    clock_now timestamptz := now();
BEGIN
    IF TG_OP = 'DELETE' THEN
        -- Detaching the last retained reference starts a fresh seven-day
        -- window. It applies to a completed upload, to a finalized upload
        -- still being processed, and to a failed upload the creator kept as a
        -- draft attachment: in every case the bytes are resident and a
        -- creator who merely removed one attachment must not lose the media
        -- immediately. Checking remaining references under the Asset row lock
        -- serializes with attachment insertion; the clock is re-armed only
        -- when the last retained Post lets go.
        SELECT asset.* INTO target
        FROM assets AS asset
        WHERE asset.id = OLD.asset_id FOR UPDATE;
        IF NOT FOUND THEN
            RETURN OLD;
        END IF;
        IF EXISTS (
            SELECT 1 FROM post_attachments AS attachment
            WHERE attachment.asset_id = OLD.asset_id
        ) THEN
            RETURN OLD;
        END IF;
        IF target.status IN ('deleting', 'deleted') THEN
            -- Already claimed for reclamation, or already reclaimed: the
            -- reclaim path owns this Asset and its clock must not be reset
            -- or cleared from here.
            RETURN OLD;
        END IF;
        IF target.status = 'pending_upload' OR target.status = 'uploading' THEN
            -- Never finalized, so there are no resident bytes to reclaim and
            -- no deadline to arm.
            RETURN OLD;
        END IF;
        UPDATE assets
        SET orphaned_at = clock_now,
            orphan_delete_after = clock_now + INTERVAL '7 days',
            updated_at = clock_now
        WHERE id = OLD.asset_id
          AND (orphaned_at IS DISTINCT FROM clock_now
               OR orphan_delete_after IS DISTINCT FROM clock_now + INTERVAL '7 days');
        RETURN OLD;
    END IF;

    -- Attach.
    IF NOT EXISTS (
        SELECT 1 FROM posts AS post WHERE post.id = NEW.post_id
    ) THEN
        RETURN NEW;
    END IF;
    -- Attach only to media the uploader still owns: a completed upload, an
    -- Asset already being processed, an upload still in flight, or a failed
    -- Asset the creator is keeping as an actionable draft attachment. Only
    -- media already claimed for reclamation is rejected; readiness is a
    -- publication-time concern, not a draft-preservation concern.
    SELECT asset.* INTO target
    FROM assets AS asset
    WHERE asset.id = NEW.asset_id
    FOR UPDATE;
    IF NOT FOUND
       OR target.status IN ('deleting', 'deleted')
       OR (
           target.status IN ('pending_upload', 'uploading')
           AND NOT EXISTS (
               SELECT 1 FROM asset_upload_sessions AS session
               WHERE session.asset_id = NEW.asset_id
                 AND session.status IN ('created', 'uploading', 'completing')
                 AND session.expires_at > clock_now
           )
       )
    THEN
        RAISE EXCEPTION 'asset % is not attachable in status %', NEW.asset_id, target.status
            USING ERRCODE = '23514';
    END IF;
    -- A retained reference cancels any pending orphan deadline: the media is
    -- owned again, so it must no longer be reclaimable. Only the orphan clock
    -- is touched here; no other lifecycle state or protection is altered.
    UPDATE assets
    SET orphaned_at = NULL,
        orphan_delete_after = NULL,
        updated_at = clock_now
    WHERE id = NEW.asset_id
      AND (orphaned_at IS NOT NULL OR orphan_delete_after IS NOT NULL);
    RETURN NEW;
END;
$fn$;

COMMIT;