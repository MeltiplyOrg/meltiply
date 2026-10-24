-- meltiply-release-phase: expand
-- 018 created this descending index beside the table's UNIQUE
-- (platform_account_id, captured_at) constraint. The constraint's B-tree already
-- serves the latest-per-account read in either direction, so the second index
-- only added write and storage cost.
DROP INDEX IF EXISTS idx_platform_account_snapshots_account_captured;
