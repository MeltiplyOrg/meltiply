-- meltiply-release-phase: expand
-- Live upload/renderer capabilities may recreate a staging object after DELETE.
-- Keep its inventory and quota ownership until the last writer window closes;
-- updated_at remains an audit timestamp rather than a future cleanup deadline.
BEGIN;

ALTER TABLE asset_objects
    ADD COLUMN write_hold_until TIMESTAMPTZ;

COMMENT ON COLUMN asset_objects.write_hold_until IS
    'Latest durable writer deadline: object deletion and quota settlement wait until this instant; NULL means no externally writable capability.';

-- Existing upload sessions bound every issued source-upload capability. Group
-- before joining so retries cannot select an arbitrary, shorter session expiry.
UPDATE asset_objects AS object
SET write_hold_until = GREATEST(session.expires_at, object.updated_at),
    updated_at = LEAST(object.updated_at, now())
FROM (
    SELECT asset_id, MAX(expires_at) AS expires_at
    FROM asset_upload_sessions
    GROUP BY asset_id
) AS session
WHERE object.asset_id = session.asset_id
  AND object.kind = 'staging'
  AND object.profile IS NULL
  AND object.status <> 'deleted'
  AND session.expires_at > now();

-- A deployment can overlap an already-issued native output capability. Retain
-- its inventoried bytes for the existing conservative 30-minute writer window.
UPDATE asset_objects
SET write_hold_until = GREATEST(updated_at, now() + interval '30 minutes'),
    updated_at = LEAST(updated_at, now())
WHERE kind = 'staging'
  AND profile IS NOT NULL
  AND status <> 'deleted';

CREATE INDEX idx_asset_objects_writer_deadline
    ON asset_objects(write_hold_until, id)
    WHERE status IN ('writing', 'superseded', 'deleting')
      AND write_hold_until IS NOT NULL;

COMMIT;
