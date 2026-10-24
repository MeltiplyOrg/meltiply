-- meltiply-release-phase: expand
-- Account-level follower history and provider counters that are not part of the
-- original per-Post snapshot. `saves` and `clicks` stay nullable because most
-- Providers do not expose them; null means "not measured", never zero.
ALTER TABLE analytics_snapshots
    ADD COLUMN IF NOT EXISTS saves BIGINT,
    ADD COLUMN IF NOT EXISTS clicks BIGINT;

ALTER TABLE analytics_snapshots
    ADD CONSTRAINT analytics_snapshots_saves_check CHECK (saves IS NULL OR saves >= 0),
    ADD CONSTRAINT analytics_snapshots_clicks_check CHECK (clicks IS NULL OR clicks >= 0);

CREATE TABLE IF NOT EXISTS platform_account_snapshots (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    platform_account_id UUID NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
    org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    followers           BIGINT NOT NULL,
    following           BIGINT,
    posts               BIGINT,
    captured_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    raw_data            JSONB,
    CONSTRAINT platform_account_snapshots_followers_check CHECK (followers >= 0),
    CONSTRAINT platform_account_snapshots_following_check
        CHECK (following IS NULL OR following >= 0),
    CONSTRAINT platform_account_snapshots_posts_check
        CHECK (posts IS NULL OR posts >= 0),
    CONSTRAINT platform_account_snapshots_unique
        UNIQUE (platform_account_id, captured_at)
);

CREATE INDEX IF NOT EXISTS idx_platform_account_snapshots_account_captured
    ON platform_account_snapshots(platform_account_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_account_snapshots_org_captured
    ON platform_account_snapshots(org_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_account_snapshots_retention
    ON platform_account_snapshots(captured_at, id);

-- Provider sync writes account history from the system role; the authenticated
-- role only reads it through the tenant transaction.
GRANT SELECT ON TABLE platform_account_snapshots TO meltiply_rls;
ALTER TABLE platform_account_snapshots ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'platform_account_snapshots'
          AND policyname = 'Users can view account snapshots in their active org'
    ) THEN
        CREATE POLICY "Users can view account snapshots in their active org"
        ON platform_account_snapshots
        FOR SELECT
        TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()));
    END IF;
END
$$;
