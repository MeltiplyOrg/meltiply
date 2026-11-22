-- meltiply-release-phase: expand
-- Retires superseded and prefix-redundant indexes and adds a composite claim
-- index covering reporting delivery lease reclamation.
--
-- 1. `idx_distributions_usage_published_cohort` (migration 035) ordered
--    `published_at DESC NULLS FIRST`, superseded by migration 036's
--    `idx_distributions_usage_published_cohort_order` (`DESC NULLS LAST`).
-- 2. `idx_analytics_distribution_id`, `idx_analytics_snapshot_at`, and
--    `platform_accounts_brand_profile_id` are strict left-prefixes of existing
--    composite indexes on the same tables.
-- 3. `idx_reporting_pending_reports_claim` supports the reporting delivery
--    claim query ordering `(available_at, created_at, id)` over pending and
--    expired-lease rows without a full bitmap sort.

DROP INDEX IF EXISTS idx_distributions_usage_published_cohort;
DROP INDEX IF EXISTS idx_analytics_distribution_id;
DROP INDEX IF EXISTS idx_analytics_snapshot_at;
DROP INDEX IF EXISTS platform_accounts_brand_profile_id;

CREATE INDEX IF NOT EXISTS idx_reporting_pending_reports_claim
    ON reporting_pending_reports (available_at, created_at, id)
    WHERE state IN ('pending', 'leased');
