-- meltiply-release-phase: expand
-- Reporting retention, consent-interval binding, durable bootstrap intent and
-- optional-screen progress.
--
-- 1. A pending report remembers the consent interval it was produced in, so a
--    withdrawal plus re-enable can never authorize a detached, already-claimed
--    row from the previous interval.
-- 2. Terminal rows keep only a minimal delivery receipt. Their payload — the
--    part that could still describe expired activity — is deleted on a bounded
--    schedule instead of living forever beside the deduplication facts.
-- 3. The setup form's chosen Workspace name is recorded before the account is
--    created, so an account-creation or verification-mail failure cannot lose a
--    name the Owner already typed. Registration authority is unchanged: the
--    existence of an account still closes public sign-up.
-- 4. The optional first-run screen the Owner reached is its own fact, separate
--    from consent, attribution and terminal completion, so a restart resumes
--    where the journey stopped.

ALTER TABLE reporting_pending_reports
    ADD COLUMN interval_started_at TIMESTAMPTZ,
    ADD COLUMN lease_token UUID;

COMMENT ON COLUMN reporting_pending_reports.interval_started_at IS
    'Consent interval that produced this report; delivery discards a row whose interval no longer matches the live policy.';
COMMENT ON COLUMN reporting_pending_reports.lease_token IS
    'Ownership fence of the current lease; a completion update must present the token it claimed with.';

-- Rows written before this migration keep NULL: delivery treats a NULL
-- interval as "produced outside any recorded interval" and discards them, which
-- is the fail-closed reading for legacy telemetry.
CREATE INDEX idx_reporting_pending_reports_lease
    ON reporting_pending_reports (lease_expires_at)
    WHERE state = 'leased';

-- The engagement cohort reads the newest published Distributions under a bound,
-- and `published_at` is nullable. The cohort query asks for `DESC NULLS LAST`, so
-- the index must match that order to supply it: the migration-029 index defaults
-- to `NULLS FIRST`, which cannot satisfy the requested ordering and would force a
-- full sort of every published Distribution on each daily pass.
CREATE INDEX idx_distributions_usage_published_cohort_order
    ON distributions (published_at DESC NULLS LAST, id DESC)
    WHERE status = 'published';

-- The daily producer bounds the Post marks by a raw timestamp window before it
-- groups by UTC date. This index serves that window directly; the plain
-- `first_confirmed_at` index from migration 035 already covers it, so the
-- expression/`GROUP BY` form has no reason to scan an unbounded interval.

-- Minimal durable delivery facts. They outlive the payload and keep logical
-- identity from being replayed after the queue row is pruned.
CREATE TABLE reporting_delivery_receipts (
    category        TEXT NOT NULL,
    logical_id      TEXT NOT NULL,
    event_uuid      UUID NOT NULL,
    event_timestamp TIMESTAMPTZ NOT NULL,
    state           TEXT NOT NULL,
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (category, logical_id),
    CONSTRAINT reporting_delivery_receipts_category_check
        CHECK (category IN ('usage', 'diagnostics', 'feedback')),
    CONSTRAINT reporting_delivery_receipts_state_check
        CHECK (state IN ('sent', 'discarded'))
);

CREATE INDEX idx_reporting_delivery_receipts_recorded
    ON reporting_delivery_receipts (recorded_at);

-- Chosen Workspace name captured before Better Auth creates the account.
-- `auth_user_id` is filled by the sign-up response; when that response never
-- arrives (mail failure, invocation termination) the row is matched by the
-- normalized sign-up email during actor resolution.
CREATE TABLE installation_bootstrap_intent (
    email          TEXT PRIMARY KEY,
    auth_user_id   TEXT,
    workspace_name TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT installation_bootstrap_intent_workspace_name_check
        CHECK (workspace_name IS NULL OR (
            length(btrim(workspace_name)) BETWEEN 1 AND 200
            AND workspace_name !~ '[[:cntrl:]]'
        ))
);

ALTER TABLE installation_onboarding
    ADD COLUMN progress_step TEXT NOT NULL DEFAULT 'improvement';

COMMENT ON COLUMN installation_onboarding.progress_step IS
    'Optional first-run screen the Owner reached; independent of consent, attribution and completion.';

ALTER TABLE installation_onboarding
    ADD CONSTRAINT installation_onboarding_progress_step_check
        CHECK (progress_step IN ('improvement', 'ready'));

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_system') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON reporting_delivery_receipts
                 TO meltiply_system';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON installation_bootstrap_intent
                 TO meltiply_system';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_rls') THEN
        EXECUTE 'REVOKE ALL ON reporting_delivery_receipts FROM meltiply_rls';
        EXECUTE 'REVOKE ALL ON installation_bootstrap_intent FROM meltiply_rls';
    END IF;
END;
$$;
