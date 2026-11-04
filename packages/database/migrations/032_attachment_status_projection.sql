-- meltiply-release-phase: expand
-- Attachment retention needs the Asset status, not its descriptive media fields.
CREATE OR REPLACE FUNCTION public.post_attachments_maintain_orphan_clock()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
    target_status TEXT;
    clock_now timestamptz := now();
BEGIN
    IF TG_OP = 'DELETE' THEN
        -- The Asset lock serializes the last detach with attachment insertion.
        SELECT asset.status INTO target_status
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
        IF target_status IN ('deleting', 'deleted', 'pending_upload', 'uploading') THEN
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

    IF NOT EXISTS (SELECT 1 FROM posts AS post WHERE post.id = NEW.post_id) THEN
        RETURN NEW;
    END IF;
    SELECT asset.status INTO target_status
    FROM assets AS asset
    WHERE asset.id = NEW.asset_id FOR UPDATE;
    IF NOT FOUND
       OR target_status IN ('deleting', 'deleted')
       OR (
           target_status IN ('pending_upload', 'uploading')
           AND NOT EXISTS (
               SELECT 1 FROM asset_upload_sessions AS session
               WHERE session.asset_id = NEW.asset_id
                 AND session.status IN ('created', 'uploading', 'completing')
                 AND session.expires_at > clock_now
           )
       )
    THEN
        RAISE EXCEPTION 'asset % is not attachable in status %', NEW.asset_id, target_status
            USING ERRCODE = '23514';
    END IF;
    -- Retention cancels reclamation without altering any other lifecycle state.
    UPDATE assets
    SET orphaned_at = NULL,
        orphan_delete_after = NULL,
        updated_at = clock_now
    WHERE id = NEW.asset_id
      AND (orphaned_at IS NOT NULL OR orphan_delete_after IS NOT NULL);
    RETURN NEW;
END;
$fn$;
