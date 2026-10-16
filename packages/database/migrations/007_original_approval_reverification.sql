-- meltiply-release-phase: expand
-- Re-verification of migrated Asset originals (issue #284):
-- Migration 003 backfilled `profile='original'` rendition references pointing
-- at each Asset's legacy public-writable object. Those references carry the
-- legacy assets.width/height/duration_sec summary — not a native decode proof
-- — so they cannot stand in for a verified rendition. This migration demotes
-- them, re-queues real native processing for every Asset that was approved on
-- that evidence, and leaves the legacy object rows inventoried and charged
-- until the processor promotes the canonical protected key and supersedes
-- them. Additive and deterministic: no bytes are deleted here, and every
-- UPDATE is guarded so a re-run is a no-op.

BEGIN;

-- Demote the unverified approvals. `object_id` is cleared so nothing can
-- resolve the legacy object through a non-ready reference, and the failure
-- fields are reset so the next processor verdict writes fresh evidence. Only
-- 'ready' rows are touched: a failed or processing row has already been
-- decided and re-demoting it would churn the (asset_id, profile) slot.
UPDATE asset_renditions
SET status = 'processing',
    object_id = NULL,
    failure_code = NULL,
    failure_message = NULL,
    failure_at = NULL,
    updated_at = now()
WHERE profile = 'original'
  AND status = 'ready';

-- Re-queue every Asset whose approval was one of the demoted references and
-- whose lifecycle is still live. 'ready' is the only state that claimed the
-- unverified approval; 'failed', 'deleting' and 'deleted' Assets keep their
-- terminal state, and an Asset already mid-processing is simply re-armed. The
-- orphan clock stays valid: migration 006 already extends it to 'processing'.
UPDATE assets AS asset
SET status = 'processing',
    failure_code = NULL,
    failure_message = NULL,
    failure_retryable = NULL,
    failure_at = NULL,
    updated_at = now()
WHERE asset.status = 'ready'
  AND EXISTS (
    SELECT 1
    FROM asset_renditions AS rendition
    WHERE rendition.asset_id = asset.id
      AND rendition.profile = 'original'
      AND rendition.status = 'processing'
      AND rendition.object_id IS NULL
  );

-- Emit one idempotent processing request per re-queued Asset through the same
-- outbox envelope the upload-finalization path uses, so a migration replay or
-- an already-pending request for the same Asset can never double the work.
-- The dedupe key is purpose-scoped: a later lifecycle-recovery rearm or a new
-- upload for the same Asset still mints its own event.
INSERT INTO outbox_events
    (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
SELECT
    rendition.org_id,
    'asset.processing.requested',
    'asset',
    rendition.asset_id,
    concat('asset:', rendition.asset_id, ':original-approval-recheck'),
    jsonb_build_object(
        'asset_id', rendition.asset_id,
        'original_approval_recheck', true
    )
FROM asset_renditions AS rendition
JOIN assets AS asset
  ON asset.id = rendition.asset_id
 AND asset.org_id = rendition.org_id
 AND asset.status = 'processing'
WHERE rendition.profile = 'original'
  AND rendition.status = 'processing'
  AND rendition.object_id IS NULL
ON CONFLICT (org_id, topic, dedupe_key) DO NOTHING;

COMMIT;
