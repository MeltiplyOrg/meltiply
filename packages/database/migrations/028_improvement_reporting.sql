-- meltiply-release-phase: expand
-- Installation-wide improvement-reporting policy: the requested/effective consent
-- per category, the one-time attribution response, and the bounded queue of
-- already-sanitized reports awaiting best-effort PostHog delivery.
--
-- System role only. Nothing here is reachable from a tenant transaction: the
-- reporting HTTP surface reads and writes through the system connection and
-- `meltiply_rls` is revoked so a member session cannot inspect or forge the
-- installation's reporting state.

CREATE TABLE reporting_preferences (
    id                                BOOLEAN PRIMARY KEY DEFAULT TRUE,
    schema_version                    INTEGER NOT NULL DEFAULT 1,
    usage_requested                   BOOLEAN NOT NULL DEFAULT FALSE,
    usage_disclosure_version          INTEGER,
    usage_decided_at                  TIMESTAMPTZ,
    usage_interval_started_at         TIMESTAMPTZ,
    diagnostics_requested             BOOLEAN NOT NULL DEFAULT FALSE,
    diagnostics_disclosure_version    INTEGER,
    diagnostics_decided_at            TIMESTAMPTZ,
    diagnostics_interval_started_at   TIMESTAMPTZ,
    installation_reporting_id         UUID,
    updated_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT reporting_preferences_singleton CHECK (id),
    CONSTRAINT reporting_preferences_schema_version_check
        CHECK (schema_version > 0),
    -- An enabled category always carries the interval it was enabled in; the
    -- interval is what makes a frozen report identity unambiguous.
    CONSTRAINT reporting_preferences_usage_interval_check
        CHECK (NOT usage_requested OR usage_interval_started_at IS NOT NULL),
    CONSTRAINT reporting_preferences_diagnostics_interval_check
        CHECK (NOT diagnostics_requested OR diagnostics_interval_started_at IS NOT NULL),
    -- The pseudonymous installation identifier exists only once a category has
    -- been enabled; an installation that never opts in stays unidentifiable.
    CONSTRAINT reporting_preferences_identity_check
        CHECK (
            (NOT usage_requested AND NOT diagnostics_requested)
            OR installation_reporting_id IS NOT NULL
        )
);

CREATE TABLE reporting_attribution_responses (
    id                BOOLEAN PRIMARY KEY DEFAULT TRUE,
    response_id       UUID NOT NULL,
    discovery_source  TEXT NOT NULL,
    shared            BOOLEAN NOT NULL,
    schema_version    INTEGER NOT NULL DEFAULT 1,
    submitted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT reporting_attribution_singleton CHECK (id),
    CONSTRAINT reporting_attribution_schema_version_check CHECK (schema_version > 0),
    CONSTRAINT reporting_attribution_source_check
        CHECK (
            discovery_source IN (
                'github',
                'search_engine',
                'social_media',
                'video',
                'article_newsletter',
                'friend_word_of_mouth',
                'ai_assistant',
                'other',
                'prefer_not_to_say'
            )
        )
);

CREATE TABLE reporting_pending_reports (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category          TEXT NOT NULL,
    logical_id        TEXT NOT NULL,
    event_name        TEXT NOT NULL,
    schema_version    INTEGER NOT NULL,
    -- Frozen logical delivery identity. PostHog de-duplicates an event on
    -- uuid + event + timestamp + distinct_id, so every retry of one report
    -- repeats these two values instead of minting a fresh identity or
    -- re-stamping the send time.
    event_uuid        UUID NOT NULL,
    event_timestamp   TIMESTAMPTZ NOT NULL,
    distinct_id       TEXT NOT NULL,
    payload           JSONB NOT NULL,
    state             TEXT NOT NULL DEFAULT 'pending',
    attempts          INTEGER NOT NULL DEFAULT 0,
    available_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at        TIMESTAMPTZ NOT NULL,
    lease_expires_at  TIMESTAMPTZ,
    last_error_code   TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT reporting_pending_reports_category_check
        CHECK (category IN ('usage', 'diagnostics', 'feedback')),
    CONSTRAINT reporting_pending_reports_state_check
        CHECK (state IN ('pending', 'leased', 'sent', 'discarded')),
    CONSTRAINT reporting_pending_reports_schema_version_check CHECK (schema_version > 0),
    CONSTRAINT reporting_pending_reports_logical_id_check
        CHECK (length(logical_id) BETWEEN 1 AND 200),
    CONSTRAINT reporting_pending_reports_event_name_check
        CHECK (length(event_name) BETWEEN 1 AND 100),
    -- One logical report identity per category: a retried schedule, a repeated
    -- feedback submission, or a duplicate diagnostic cannot become a second
    -- measurement, and a partial send resumes the same row.
    CONSTRAINT reporting_pending_reports_identity_unique UNIQUE (category, logical_id),
    CONSTRAINT reporting_pending_reports_expiry_check CHECK (expires_at > created_at),
    -- Optional data expires within seven days; the row is discarded, never sent
    -- late, and a stale row can never accumulate an unbounded payload.
    CONSTRAINT reporting_pending_reports_expiry_horizon_check
        CHECK (expires_at <= created_at + INTERVAL '7 days'),
    CONSTRAINT reporting_pending_reports_attempts_check CHECK (attempts >= 0),
    CONSTRAINT reporting_pending_reports_payload_size_check
        CHECK (pg_column_size(payload) <= 8192)
);

CREATE INDEX idx_reporting_pending_reports_due
    ON reporting_pending_reports (available_at, expires_at)
    WHERE state IN ('pending', 'leased');

CREATE INDEX idx_reporting_pending_reports_category_state
    ON reporting_pending_reports (category, state);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_system') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON reporting_preferences,
                 reporting_attribution_responses, reporting_pending_reports
                 TO meltiply_system';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_rls') THEN
        EXECUTE 'REVOKE ALL ON reporting_preferences, reporting_attribution_responses,
                 reporting_pending_reports FROM meltiply_rls';
    END IF;
END;
$$;
