-- meltiply-release-phase: expand
-- Terminal release for the `profile='original'` renditions migration 007
-- stranded on Assets it never re-queued.
--
-- 007 demoted every ready original rendition to 'processing' with
-- `object_id = NULL`, then re-queued only Assets that were 'ready' (or already
-- 'processing') for native re-verification. A demoted row on an Asset in any
-- other state — 'failed', 'deleting', 'deleted', an unfinished upload, or one
-- whose re-verification already committed 'ready' through the optimized
-- profile row — waits on a verdict no job will ever write: `processMedia`
-- skips every Asset that is not 'processing'. That row then blocks the
-- orphan sweep's `status IN ('processing', 'deleting')` rendition exclusion
-- and the Brand Profile purge forever, so the Asset's bytes are never
-- reclaimed.
--
-- Each stranded row moves to the terminal state its Asset already reached:
-- 'deleting'/'deleted' mirrors the reclamation the deletion path performs
-- itself. A 'ready' Asset's demoted row is 'failed' with the
-- 'original_superseded' record the verdict-commit paths write for a demoted
-- row released by a live run — its processing demonstrably committed, so the
-- unverified reference was retired by a committed rendition. Every other
-- non-processing Asset gets 'failed' — inheriting the Asset's own failure
-- evidence when it exists, else a stable 'original_unverified' record. Both
-- updates are guarded on the exact demoted shape 007 produced, so a replay is
-- a no-op and a later re-processing can still overwrite 'failed' with a fresh
-- verdict.

BEGIN;

-- Reclamation-matched release: the deletion path marks every rendition
-- 'deleted' when it finishes, so a demoted row on an Asset already claimed
-- (or reclaimed) takes the matching state and stops blocking both the sweep
-- and the purge on a reference that no longer decides anything. The second
-- arm converges a row this migration moved to 'deleting' before its Asset's
-- own deletion finished: nothing else rewrites it, so a replay settles the
-- match the deletion sweep would have written.
UPDATE asset_renditions AS rendition
SET status = asset.status,
    failure_code = NULL,
    failure_message = NULL,
    failure_at = NULL,
    updated_at = now()
FROM assets AS asset
WHERE asset.id = rendition.asset_id
  AND asset.org_id = rendition.org_id
  AND asset.status IN ('deleting', 'deleted')
  AND rendition.profile = 'original'
  AND rendition.object_id IS NULL
  AND (
    rendition.status = 'processing'
    OR (rendition.status = 'deleting' AND asset.status = 'deleted')
  );

-- Terminal failure release: a demoted row on an Asset no job can reach is a
-- verdict that was never produced, so it records 'failed'. A 'ready' Asset's
-- processing demonstrably committed — the live verdict-commit paths write
-- 'original_superseded' for the same release — while every other
-- non-processing Asset inherits its own failure evidence when present and a
-- stable, actionable 'original_unverified' record otherwise. A 'ready' Asset
-- keeps its committed optimized rendition; only the unverified original
-- reference is retired here.
UPDATE asset_renditions AS rendition
SET status = 'failed',
    failure_code = CASE
        WHEN asset.status = 'ready' THEN 'original_superseded'
        ELSE COALESCE(asset.failure_code, 'original_unverified')
    END,
    failure_message = CASE
        WHEN asset.status = 'ready' THEN
            'The committed optimized rendition superseded this unverified ' ||
            'original reference.'
        ELSE COALESCE(
            asset.failure_message,
            'The original upload was never verified by the media processor; '
            'upload the file again to re-process it.'
        )
    END,
    failure_at = COALESCE(asset.failure_at, now()),
    updated_at = now()
FROM assets AS asset
WHERE asset.id = rendition.asset_id
  AND asset.org_id = rendition.org_id
  AND asset.status NOT IN ('processing', 'deleting', 'deleted')
  AND rendition.profile = 'original'
  AND rendition.status = 'processing'
  AND rendition.object_id IS NULL;

COMMIT;
