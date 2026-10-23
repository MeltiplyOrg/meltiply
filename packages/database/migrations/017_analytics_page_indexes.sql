-- meltiply-release-phase: expand
-- Analytics cohorts select published Distributions by publication instant, not
-- by the calendar's event_at. These additive partial indexes keep the new
-- workspace-wide and Brand Profile-scoped cohort scans ordered without reading
-- the rest of the publication history. The existing analytics snapshot indexes
-- already cover the latest-snapshot join per Distribution.
CREATE INDEX IF NOT EXISTS idx_distributions_org_published_at
    ON distributions(org_id, published_at, id)
    WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_distributions_brand_profile_published_at
    ON distributions(brand_profile_id, published_at, id)
    WHERE status = 'published';
