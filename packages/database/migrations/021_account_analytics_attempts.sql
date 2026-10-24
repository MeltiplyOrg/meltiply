-- meltiply-release-phase: expand
-- Claim before provider I/O so failed or interrupted captures back off and rotate
-- behind accounts that have never been attempted. Captures remain separate data.
ALTER TABLE platform_accounts
    ADD COLUMN IF NOT EXISTS account_analytics_attempted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_platform_accounts_account_analytics_due
    ON platform_accounts(account_analytics_attempted_at NULLS FIRST, id)
    WHERE connection_status = 'connected' AND access_token IS NOT NULL;
