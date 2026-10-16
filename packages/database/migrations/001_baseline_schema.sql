-- meltiply-release-phase: expand
-- Better Auth and native Workspace baseline schema.
--
-- Baseline schema definition: every domain table, index, constraint, RLS function,
-- and policy is created here. users.auth_user_id maps one-to-one to the Better Auth
-- "user".id subject, workspaces are native organizations (personal_user_id marks the
-- 1:1 personal workspace), membership roles are 'admin'/'member', and RLS
-- resolves the active workspace through public.auth_active_org_id() /
-- public.auth_active_user_id() from the transaction-local request.jwt.claims
-- GUC. Brand Profiles (brand_profiles) are the mandatory ownership boundary
-- for assets, platform_accounts, and distributions inside a workspace.
-- Existing databases are unsupported: reset volumes before applying.

-- ---------------------------------------------------------------------------
-- Better Auth core tables (managed by the Better Auth PG adapter; the API
-- worker accesses them through the meltiply_system role only).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "user" (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE,
    "emailVerified" BOOLEAN NOT NULL DEFAULT FALSE,
    image           TEXT,
    "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "session" (
    id          TEXT PRIMARY KEY,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    token       TEXT NOT NULL UNIQUE,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId"    TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "account" (
    id                      TEXT PRIMARY KEY,
    "accountId"             TEXT NOT NULL,
    "providerId"            TEXT NOT NULL,
    "userId"                TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "accessToken"           TEXT,
    "refreshToken"          TEXT,
    "idToken"               TEXT,
    "accessTokenExpiresAt"  TIMESTAMPTZ,
    "refreshTokenExpiresAt" TIMESTAMPTZ,
    scope                   TEXT,
    password                TEXT,
    "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt"             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "verification" (
    id          TEXT PRIMARY KEY,
    identifier  TEXT NOT NULL,
    value       TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ DEFAULT now(),
    "updatedAt" TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_user_id ON "session"("userId");
CREATE INDEX IF NOT EXISTS idx_account_user_id ON "account"("userId");
CREATE INDEX IF NOT EXISTS idx_verification_identifier ON "verification"(identifier);

-- ---------------------------------------------------------------------------
-- Identity and workspace model.
-- users.auth_user_id is the sole durable link to the Better Auth subject;
-- email alone never attaches an identity. organizations.personal_user_id
-- marks the single personal workspace each user owns.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id TEXT NOT NULL UNIQUE REFERENCES "user"(id) ON DELETE CASCADE,
    email        TEXT NOT NULL UNIQUE,
    display_name TEXT,
    avatar_url   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organizations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT NOT NULL,
    slug                TEXT NOT NULL,
    plan                TEXT NOT NULL DEFAULT 'free',
    billing_status      TEXT NOT NULL DEFAULT 'free',
    billing_customer_id TEXT,
    renews_at           TIMESTAMPTZ,
    cancel_at           TIMESTAMPTZ,
    billing_event_at    TIMESTAMPTZ,
    personal_user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT organizations_billing_status_check
        CHECK (billing_status IN ('free', 'trialing', 'active', 'past_due', 'cancelled')),
    CONSTRAINT organizations_billing_customer_id_check
        CHECK (billing_customer_id IS NULL OR (
            length(billing_customer_id) BETWEEN 1 AND 512
            AND billing_customer_id !~ '[[:space:][:cntrl:]]'
        ))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_slug
    ON organizations(slug);

CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_billing_customer_id
    ON organizations(billing_customer_id)
    WHERE billing_customer_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_personal_user
    ON organizations(personal_user_id)
    WHERE personal_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS org_members (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL DEFAULT 'member',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(org_id, user_id),
    CONSTRAINT org_members_role_check CHECK (role IN ('admin', 'member'))
);

-- Native workspace invitations. Only team workspaces (personal_user_id IS
-- NULL) may invite; acceptance transactionally creates the org_members row.
-- The opaque invite token is stored as a SHA-256 hash so a database read
-- never discloses a usable token. Lifecycle state is derived: pending when
-- neither timestamp is set and expires_at is in the future, expired once
-- expires_at passes, accepted/revoked via the respective timestamp. The
-- caller writes email normalized to lowercase so the partial unique index
-- enforces one open invitation per workspace and address; an expired row
-- must be marked revoked_at before the same address can be re-invited.
CREATE TABLE IF NOT EXISTS workspace_invitations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'member',
    invited_by  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    revoked_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT workspace_invitations_role_check CHECK (role IN ('admin', 'member')),
    CONSTRAINT workspace_invitations_outcome_check
        CHECK (NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_workspace_invitations_org_id
    ON workspace_invitations(org_id);
CREATE INDEX IF NOT EXISTS idx_workspace_invitations_email
    ON workspace_invitations(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_invitations_pending_email
    ON workspace_invitations(org_id, email)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Database-backed fixed-window abuse control for authentication endpoints.
-- One row per (action, normalized subject, window bucket); the API worker
-- increments through public.auth_rate_limit_hit() on the system role so an
-- over-limit attempt is rejected atomically inside the counting statement.
CREATE TABLE IF NOT EXISTS auth_rate_limits (
    action        TEXT NOT NULL,
    subject       TEXT NOT NULL,
    window_start  TIMESTAMPTZ NOT NULL,
    attempt_count INT NOT NULL DEFAULT 0,
    expires_at    TIMESTAMPTZ NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (action, subject, window_start),
    CONSTRAINT auth_rate_limits_attempt_count_check CHECK (attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_expiry
    ON auth_rate_limits(expires_at);

-- Atomically records one authentication attempt and reports whether the
-- fixed window is exhausted. The caller supplies a normalized subject
-- (lowercased email or client IP) plus the window size and limit; the
-- INSERT ... ON CONFLICT increment is atomic under concurrency, so the
-- returned attempt_count is authoritative for the reject decision.
-- Returns NULL when the attempt is allowed, or the whole number of seconds
-- until the window expires (suitable for Retry-After) when it is denied.
CREATE OR REPLACE FUNCTION public.auth_rate_limit_hit(
    p_action TEXT,
    p_subject TEXT,
    p_window_seconds INT,
    p_max_attempts INT
)
RETURNS INT
LANGUAGE sql
AS $$
    WITH params AS (
        SELECT date_bin(make_interval(secs => p_window_seconds), now(), 'epoch') AS window_start,
               now() + make_interval(secs => p_window_seconds) AS expires_at
    ),
    hit AS (
        INSERT INTO auth_rate_limits (action, subject, window_start, attempt_count, expires_at)
        SELECT p_action, p_subject, params.window_start, 1, params.expires_at
        FROM params
        ON CONFLICT (action, subject, window_start) DO UPDATE
            SET attempt_count = auth_rate_limits.attempt_count + 1,
                expires_at = GREATEST(auth_rate_limits.expires_at, EXCLUDED.expires_at),
                updated_at = now()
        RETURNING attempt_count, expires_at
    )
    SELECT CASE
        WHEN hit.attempt_count > p_max_attempts
        THEN GREATEST(1, CEIL(EXTRACT(EPOCH FROM (hit.expires_at - now())))::int)
        ELSE NULL
    END
    FROM hit
$$;

REVOKE ALL ON FUNCTION public.auth_rate_limit_hit(TEXT, TEXT, INT, INT) FROM PUBLIC;

ALTER TABLE auth_rate_limits ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Tenant domain tables.
-- Brand Profiles are the ownership boundary inside a Workspace: assets,
-- platform accounts, and distributions each carry a mandatory
-- brand_profile_id, and distributions additionally bind their asset and
-- platform account to the same profile through composite foreign keys.
-- ---------------------------------------------------------------------------

-- Brand Profile: the named, color-labelled identity inside one Workspace that
-- owns assets, platform accounts, and distributions. description is an optional
-- short plain-text summary shown when the Channels board has no connected accounts.
-- normalized_name is a stored projection (case-folded, whitespace-collapsed) so
-- the unconditional UNIQUE(org_id, normalized_name) keeps a soft-deleted profile's
-- name reserved until the row is purged. color is restricted to a fixed palette of
-- 51 accessible hex values (Tailwind 700/800/900 ramps, all >= 4.5:1 contrast on
-- white); the API contract mirrors this list verbatim. deleted_at marks soft
-- deletion and purge_at the retention deadline (deleted_at + 7 days, written by
-- the caller: timestamptz interval math is timezone-dependent and cannot be a
-- generated column); the check keeps the pair consistent.
CREATE TABLE IF NOT EXISTS brand_profiles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT,
    normalized_name TEXT GENERATED ALWAYS AS
        (lower(btrim(regexp_replace(name, '\s+', ' ', 'g')))) STORED,
    color           TEXT NOT NULL,
    deleted_at      TIMESTAMPTZ,
    purge_at        TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(org_id, normalized_name),
    CONSTRAINT brand_profiles_id_org_unique UNIQUE (id, org_id),
    CONSTRAINT brand_profiles_name_check
        CHECK (length(btrim(name)) BETWEEN 1 AND 100
            AND name !~ '[[:cntrl:]]'),
    CONSTRAINT brand_profiles_description_check
        CHECK (description IS NULL
            OR (length(btrim(description)) BETWEEN 1 AND 280
                AND description !~ '[[:cntrl:]]')),
    CONSTRAINT brand_profiles_normalized_name_check
        CHECK (normalized_name <> ''),
    CONSTRAINT brand_profiles_purge_check
        CHECK ((deleted_at IS NULL) = (purge_at IS NULL)
            AND (purge_at IS NULL OR purge_at > deleted_at)),
    CONSTRAINT brand_profiles_color_check
        CHECK (color IN (
            '#b91c1c', '#991b1b', '#7f1d1d',
            '#c2410c', '#9a3412', '#7c2d12',
            '#b45309', '#92400e', '#78350f',
            '#a16207', '#854d0e', '#713f12',
            '#4d7c0f', '#3f6212', '#365314',
            '#15803d', '#166534', '#14532d',
            '#0f766e', '#115e59', '#134e4a',
            '#0e7490', '#155e75', '#164e63',
            '#0369a1', '#075985', '#0c4a6e',
            '#1d4ed8', '#1e40af', '#1e3a8a',
            '#4338ca', '#3730a3', '#312e81',
            '#6d28d9', '#5b21b6', '#4c1d95',
            '#7e22ce', '#6b21a8', '#581c87',
            '#a21caf', '#86198f', '#701a75',
            '#be185d', '#9d174d', '#831843',
            '#be123c', '#9f1239', '#881337',
            '#374151', '#1f2937', '#111827'
        ))
);

CREATE TABLE IF NOT EXISTS platform_accounts (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    brand_profile_id                UUID NOT NULL,
    platform                        TEXT NOT NULL,
    platform_user_id                TEXT NOT NULL,
    display_name                    TEXT,
    avatar_url                      TEXT,
    access_token                    TEXT NOT NULL,
    refresh_token                   TEXT,
    token_expires_at                TIMESTAMPTZ,
    scopes                          TEXT[],
    metadata                        JSONB,
    connection_status               TEXT NOT NULL DEFAULT 'connected',
    last_synced_at                  TIMESTAMPTZ,
    revoked_at                      TIMESTAMPTZ,
    token_refresh_next_attempt_at   TIMESTAMPTZ,
    token_refresh_lease_expires_at  TIMESTAMPTZ,
    token_refresh_event_id          UUID,
    token_refresh_attempt_count     INT NOT NULL DEFAULT 0,
    token_refresh_last_error        TEXT,
    reconnect_notified_at           TIMESTAMPTZ,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The external Platform identity is globally unique: one social account
    -- can be connected to at most one Brand Profile in one Workspace until it
    -- is locally disconnected (the row is deleted).
    UNIQUE(platform, platform_user_id),
    CONSTRAINT platform_accounts_id_brand_profile_unique
        UNIQUE (id, brand_profile_id),
    CONSTRAINT platform_accounts_brand_profile_org_fkey
        FOREIGN KEY (brand_profile_id, org_id)
        REFERENCES brand_profiles(id, org_id) ON DELETE CASCADE,
    CONSTRAINT platform_accounts_connection_status_check
        CHECK (connection_status IN (
            'connected', 'expiring', 'expired', 'revoked', 'reconnect_required'
        )),
    CONSTRAINT platform_accounts_token_refresh_attempt_count_check
        CHECK (token_refresh_attempt_count >= 0 AND token_refresh_attempt_count <= 20)
);

CREATE TABLE IF NOT EXISTS assets (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    brand_profile_id UUID NOT NULL,
    uploaded_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    title            TEXT NOT NULL,
    description      TEXT,
    r2_key           TEXT,
    r2_thumbnail     TEXT,
    duration_sec     INT,
    file_size        BIGINT,
    mime_type        TEXT,
    width            INT,
    height           INT,
    tags             TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    status           TEXT NOT NULL DEFAULT 'ready',
    asset_type       TEXT NOT NULL DEFAULT 'video',
    text_content     TEXT,
    original_filename TEXT,
    failure_code     TEXT,
    failure_message  TEXT,
    failure_retryable BOOLEAN,
    failure_at       TIMESTAMPTZ,
    deleted_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT assets_id_brand_profile_unique
        UNIQUE (id, brand_profile_id),
    CONSTRAINT assets_brand_profile_org_fkey
        FOREIGN KEY (brand_profile_id, org_id)
        REFERENCES brand_profiles(id, org_id) ON DELETE CASCADE,
    CONSTRAINT assets_status_check
        CHECK (status IN (
            'pending_upload', 'uploading', 'processing', 'ready',
            'failed', 'deleting', 'deleted'
        ))
);

CREATE TABLE IF NOT EXISTS distributions (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    brand_profile_id                UUID NOT NULL,
    -- The asset and platform account foreign keys carry brand_profile_id so a
    -- distribution can only reference rows owned by its own Brand Profile;
    -- cross-brand publishing is rejected by the database itself. The account
    -- FK nulls only platform_account_id on disconnect so the distribution
    -- keeps its profile ownership for history.
    asset_id                        UUID NOT NULL,
    platform_account_id             UUID,
    platform                        TEXT NOT NULL,
    status                          TEXT NOT NULL DEFAULT 'queued',
    scheduled_at                    TIMESTAMPTZ,
    published_at                    TIMESTAMPTZ,
    platform_post_id                TEXT,
    platform_url                    TEXT,
    title_override                  TEXT,
    description_override            TEXT,
    hashtags                        TEXT[],
    error_message                   TEXT,
    retry_count                     INT NOT NULL DEFAULT 0,
    attempt_count                   INT NOT NULL DEFAULT 0,
    last_attempt_at                 TIMESTAMPTZ,
    next_attempt_at                 TIMESTAMPTZ,
    failure_code                    TEXT,
    failure_retryable               BOOLEAN,
    provider_operation_id           TEXT,
    cancel_requested_at             TIMESTAMPTZ,
    batch_id                        UUID,
    reconciliation_attempt_count    INT NOT NULL DEFAULT 0,
    provider_options                JSONB NOT NULL DEFAULT '{}'::jsonb,
    provider_poll_attempts          INT NOT NULL DEFAULT 0,
    analytics_cursor                TEXT,
    analytics_last_synced_at        TIMESTAMPTZ,
    analytics_next_sync_at          TIMESTAMPTZ,
    analytics_lease_expires_at      TIMESTAMPTZ,
    analytics_sync_event_id         UUID,
    analytics_attempt_count         INT NOT NULL DEFAULT 0,
    analytics_last_error            TEXT,
    comments_cursor                 TEXT,
    comments_last_synced_at         TIMESTAMPTZ,
    comments_next_sync_at           TIMESTAMPTZ,
    comments_lease_expires_at       TIMESTAMPTZ,
    comments_sync_event_id          UUID,
    comments_attempt_count          INT NOT NULL DEFAULT 0,
    comments_last_error             TEXT,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    event_at                        TIMESTAMPTZ GENERATED ALWAYS AS
        (COALESCE(scheduled_at, published_at, created_at)) STORED,
    CONSTRAINT distributions_brand_profile_org_fkey
        FOREIGN KEY (brand_profile_id, org_id)
        REFERENCES brand_profiles(id, org_id) ON DELETE CASCADE,
    CONSTRAINT distributions_asset_brand_profile_fkey
        FOREIGN KEY (asset_id, brand_profile_id)
        REFERENCES assets(id, brand_profile_id) ON DELETE CASCADE,
    CONSTRAINT distributions_platform_account_brand_profile_fkey
        FOREIGN KEY (platform_account_id, brand_profile_id)
        REFERENCES platform_accounts(id, brand_profile_id)
        ON DELETE SET NULL (platform_account_id),
    CONSTRAINT distributions_status_check CHECK (
        status IN (
            'scheduled', 'queued', 'processing', 'awaiting_provider',
            'published', 'failed', 'cancel_requested', 'cancelled',
            'needs_reconciliation'
        )
    ),
    CONSTRAINT distributions_provider_sync_attempts_check CHECK (
        analytics_attempt_count >= 0 AND analytics_attempt_count <= 20
        AND comments_attempt_count >= 0 AND comments_attempt_count <= 20
    ),
    CONSTRAINT distributions_provider_options_check CHECK (
        jsonb_typeof(provider_options) = 'object'
        AND octet_length(provider_options::text) <= 4096
    )
);

CREATE TABLE IF NOT EXISTS analytics_snapshots (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    distribution_id  UUID NOT NULL REFERENCES distributions(id) ON DELETE CASCADE,
    org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    views            BIGINT NOT NULL DEFAULT 0,
    likes            BIGINT NOT NULL DEFAULT 0,
    comments         BIGINT NOT NULL DEFAULT 0,
    shares           BIGINT NOT NULL DEFAULT 0,
    watch_time_sec   BIGINT NOT NULL DEFAULT 0,
    reach            BIGINT NOT NULL DEFAULT 0,
    impressions      BIGINT NOT NULL DEFAULT 0,
    snapshot_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    raw_data         JSONB
);

CREATE TABLE IF NOT EXISTS comments (
    id                                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    distribution_id                     UUID NOT NULL REFERENCES distributions(id) ON DELETE CASCADE,
    org_id                              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    platform_comment_id                 TEXT NOT NULL,
    author_name                         TEXT,
    author_avatar                       TEXT,
    body                                TEXT NOT NULL,
    replied                             BOOLEAN NOT NULL DEFAULT false,
    reply_text                          TEXT,
    reply_status                        TEXT NOT NULL DEFAULT 'none',
    reply_error                         TEXT,
    reply_attempted_at                  TIMESTAMPTZ,
    reply_provider_operation_id         TEXT,
    reply_provider_post_id              TEXT,
    reply_attempt_count                 INT NOT NULL DEFAULT 0,
    reply_reconciliation_attempt_count  INT NOT NULL DEFAULT 0,
    reply_lease_expires_at              TIMESTAMPTZ,
    commented_at                        TIMESTAMPTZ NOT NULL,
    synced_at                           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(distribution_id, platform_comment_id),
    CONSTRAINT comments_reply_status_check CHECK (
        reply_status IN (
            'none', 'queued', 'in_progress', 'failed',
            'succeeded', 'needs_reconciliation'
        )
    ),
    CONSTRAINT comments_reply_attempt_count_check
        CHECK (reply_attempt_count >= 0 AND reply_attempt_count <= 10),
    CONSTRAINT comments_reply_reconciliation_attempt_count_check CHECK (
        reply_reconciliation_attempt_count >= 0
        AND reply_reconciliation_attempt_count <= 20
    )
);

CREATE TABLE IF NOT EXISTS usage_records (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    period         TEXT NOT NULL,
    uploads        INT NOT NULL DEFAULT 0,
    distributions  INT NOT NULL DEFAULT 0,
    api_calls      INT NOT NULL DEFAULT 0,
    storage_bytes  BIGINT NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(org_id, period)
);

-- ---------------------------------------------------------------------------
-- Worker API primitives: durable events, idempotency, outbox, upload
-- lifecycle, billing, reconciliation, and observability ledgers.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS webhook_events (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider      TEXT NOT NULL,
    event_id      TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    payload_hash  TEXT NOT NULL,
    outcome       TEXT NOT NULL DEFAULT 'processing',
    attempts      INT NOT NULL DEFAULT 1,
    error_message TEXT,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at  TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(provider, event_id),
    CONSTRAINT webhook_events_outcome_check
        CHECK (outcome IN ('processing', 'processed', 'ignored', 'failed'))
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    id               UUID NOT NULL DEFAULT gen_random_uuid(),
    org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    operation        TEXT NOT NULL,
    idempotency_key  TEXT NOT NULL,
    request_hash     TEXT NOT NULL,
    response_status  INT,
    response_body    JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at       TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours'),
    PRIMARY KEY (org_id, operation, idempotency_key)
);

-- billing_operations.idempotency_id references this surrogate key, so the
-- unique index must exist before that table is created.
CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_keys_id
    ON idempotency_keys(id);

CREATE TABLE IF NOT EXISTS outbox_events (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    topic            TEXT NOT NULL,
    aggregate_type   TEXT NOT NULL,
    aggregate_id     UUID NOT NULL,
    dedupe_key       TEXT NOT NULL,
    payload          JSONB NOT NULL,
    state            TEXT NOT NULL DEFAULT 'pending',
    attempt_count    INT NOT NULL DEFAULT 0,
    available_at     TIMESTAMPTZ DEFAULT now(),
    lease_expires_at TIMESTAMPTZ,
    published_at     TIMESTAMPTZ,
    last_error       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(org_id, topic, dedupe_key),
    CONSTRAINT outbox_events_state_check
        CHECK (state IN ('pending', 'leased', 'published', 'failed', 'dead'))
);

CREATE TABLE IF NOT EXISTS async_job_events (
    event_key        TEXT PRIMARY KEY,
    job_type         TEXT NOT NULL,
    aggregate_id     UUID,
    org_id           UUID REFERENCES organizations(id) ON DELETE CASCADE,
    aggregate_type   TEXT NOT NULL,
    outcome          TEXT NOT NULL DEFAULT 'processing',
    attempt_count    INT NOT NULL DEFAULT 1,
    lease_expires_at TIMESTAMPTZ,
    last_error       TEXT,
    processed_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT async_job_events_outcome_check
        CHECK (outcome IN ('processing', 'succeeded', 'skipped', 'failed')),
    CONSTRAINT async_job_events_attempt_count_check CHECK (attempt_count > 0)
);

CREATE TABLE IF NOT EXISTS asset_upload_sessions (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    asset_id             UUID NOT NULL UNIQUE REFERENCES assets(id) ON DELETE CASCADE,
    uploaded_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    strategy             TEXT NOT NULL,
    status               TEXT NOT NULL DEFAULT 'created',
    content_type         TEXT NOT NULL,
    file_size            BIGINT NOT NULL,
    object_key           TEXT NOT NULL UNIQUE,
    multipart_upload_id  TEXT,
    part_size            BIGINT,
    part_count           INT,
    max_parallel_parts   INT,
    expires_at           TIMESTAMPTZ NOT NULL,
    completed_at         TIMESTAMPTZ,
    aborted_at           TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT asset_upload_sessions_id_org_unique UNIQUE (id, org_id),
    CONSTRAINT asset_upload_sessions_strategy_check
        CHECK (strategy IN ('single', 'multipart')),
    CONSTRAINT asset_upload_sessions_status_check
        CHECK (status IN (
            'created', 'uploading', 'completing', 'completed', 'aborted', 'expired'
        )),
    CONSTRAINT asset_upload_sessions_file_size_check CHECK (file_size > 0),
    CONSTRAINT asset_upload_sessions_multipart_shape_check
        CHECK (
            (
                strategy = 'single'
                AND multipart_upload_id IS NULL
                AND part_size IS NULL
                AND part_count IS NULL
                AND max_parallel_parts IS NULL
            )
            OR
            (
                strategy = 'multipart'
                AND multipart_upload_id IS NOT NULL
                AND part_size >= 5242880
                AND part_count BETWEEN 2 AND 10000
                AND max_parallel_parts BETWEEN 1 AND 16
            )
        )
);

CREATE TABLE IF NOT EXISTS asset_upload_parts (
    session_id    UUID NOT NULL,
    org_id        UUID NOT NULL,
    part_number   INT NOT NULL,
    etag          TEXT NOT NULL,
    size          BIGINT NOT NULL,
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, part_number),
    CONSTRAINT asset_upload_parts_number_check
        CHECK (part_number BETWEEN 1 AND 10000),
    CONSTRAINT asset_upload_parts_size_check CHECK (size > 0),
    CONSTRAINT asset_upload_parts_session_org_fkey
        FOREIGN KEY (session_id, org_id)
        REFERENCES asset_upload_sessions(id, org_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS asset_quota_reservations (
    session_id   UUID PRIMARY KEY,
    org_id       UUID NOT NULL,
    bytes        BIGINT NOT NULL,
    state        TEXT NOT NULL DEFAULT 'reserved',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at  TIMESTAMPTZ,
    committed_at TIMESTAMPTZ,
    CONSTRAINT asset_quota_reservations_bytes_check CHECK (bytes > 0),
    CONSTRAINT asset_quota_reservations_state_check
        CHECK (state IN ('reserved', 'committed', 'released')),
    CONSTRAINT asset_quota_reservations_session_org_fkey
        FOREIGN KEY (session_id, org_id)
        REFERENCES asset_upload_sessions(id, org_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS provider_operations (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    distribution_id       UUID NOT NULL REFERENCES distributions(id) ON DELETE CASCADE,
    comment_id            UUID REFERENCES comments(id) ON DELETE CASCADE,
    operation             TEXT NOT NULL,
    idempotency_key       TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'started',
    provider_operation_id TEXT,
    provider_post_id      TEXT,
    provider_url          TEXT,
    error_class           TEXT,
    last_error            TEXT,
    attempt_count         INT NOT NULL DEFAULT 1,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at          TIMESTAMPTZ,
    UNIQUE (distribution_id, operation, idempotency_key),
    CONSTRAINT provider_operations_status_check CHECK (
        status IN ('started', 'succeeded', 'failed', 'needs_reconciliation', 'cancelled')
    )
);

CREATE TABLE IF NOT EXISTS operator_actions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action          TEXT NOT NULL,
    actor_subject   TEXT NOT NULL,
    actor_email     TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash    TEXT NOT NULL,
    request_id      TEXT NOT NULL,
    reason          TEXT NOT NULL,
    target_type     TEXT NOT NULL,
    target_id       UUID NOT NULL,
    before_state    JSONB NOT NULL,
    after_state     JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (actor_subject, idempotency_key),
    CONSTRAINT operator_actions_action_check CHECK (
        action IN (
            'resolve_distribution_reconciliation',
            'resolve_billing_reconciliation'
        )
    ),
    CONSTRAINT operator_actions_target_type_check CHECK (
        target_type IN ('distribution', 'billing_operation')
    )
);

CREATE TABLE IF NOT EXISTS usage_reconciliation_state (
    org_id                 UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    next_reconciliation_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_until            TIMESTAMPTZ,
    last_started_at        TIMESTAMPTZ,
    last_completed_at      TIMESTAMPTZ,
    consecutive_failures   INT NOT NULL DEFAULT 0,
    last_error_code        TEXT,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT usage_reconciliation_failures_check
        CHECK (consecutive_failures >= 0)
);

CREATE TABLE IF NOT EXISTS usage_corrections (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    period           TEXT NOT NULL,
    reason           TEXT NOT NULL,
    prior_usage      JSONB NOT NULL,
    reconciled_usage JSONB NOT NULL,
    evidence         JSONB NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT usage_corrections_period_check
        CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
    CONSTRAINT usage_corrections_reason_check
        CHECK (reason = 'scheduled_authoritative_reconciliation')
);

CREATE TABLE IF NOT EXISTS billing_operations (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    idempotency_id              UUID NOT NULL UNIQUE REFERENCES idempotency_keys(id) ON DELETE RESTRICT,
    operation                   TEXT NOT NULL,
    operation_id                TEXT NOT NULL UNIQUE,
    status                      TEXT NOT NULL DEFAULT 'started',
    provider_customer_id        TEXT,
    provider_plan_id            TEXT,
    provider_session_expires_at TIMESTAMPTZ,
    attempt_count               INT NOT NULL DEFAULT 1,
    lease_expires_at            TIMESTAMPTZ,
    last_error_code             TEXT,
    started_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at                TIMESTAMPTZ,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT billing_operations_operation_check CHECK (
        operation IN ('checkout', 'portal')
    ),
    CONSTRAINT billing_operations_status_check CHECK (
        status IN ('started', 'succeeded', 'failed', 'needs_reconciliation')
    ),
    CONSTRAINT billing_operations_operation_id_check CHECK (
        length(operation_id) BETWEEN 1 AND 256
        AND operation_id !~ '[[:space:][:cntrl:]]'
    ),
    CONSTRAINT billing_operations_customer_id_check CHECK (
        provider_customer_id IS NULL OR (
            length(provider_customer_id) BETWEEN 1 AND 512
            AND provider_customer_id !~ '[[:space:][:cntrl:]]'
        )
    ),
    CONSTRAINT billing_operations_provider_plan_id_check CHECK (
        provider_plan_id IS NULL OR (
            length(provider_plan_id) BETWEEN 1 AND 512
            AND provider_plan_id !~ '[[:space:][:cntrl:]]'
        )
    ),
    CONSTRAINT billing_operations_attempt_count_check CHECK (
        attempt_count >= 1
    ),
    CONSTRAINT billing_operations_last_error_code_check CHECK (
        last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'
    )
);

CREATE TABLE IF NOT EXISTS organization_locks (
    org_id     UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS operator_action_locks (
    actor_subject   TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (actor_subject, idempotency_key)
);

CREATE TABLE IF NOT EXISTS flow_runs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    environment TEXT NOT NULL,
    trace_id    TEXT NOT NULL,
    request_id  TEXT NOT NULL,
    org_id      UUID REFERENCES organizations(id) ON DELETE CASCADE,
    entrypoint  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'running',
    error_code  TEXT,
    retryable   BOOLEAN,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    duration_ms NUMERIC(12, 2),
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT flow_runs_status_check CHECK (
        status IN ('running', 'succeeded', 'failed', 'cancelled')
    ),
    CONSTRAINT flow_runs_trace_id_check CHECK (
        length(trace_id) BETWEEN 8 AND 128
        AND trace_id !~ '[[:space:][:cntrl:]]'
    ),
    CONSTRAINT flow_runs_request_id_check CHECK (
        length(request_id) BETWEEN 8 AND 128
        AND request_id !~ '[[:space:][:cntrl:]]'
    ),
    CONSTRAINT flow_runs_metadata_object_check CHECK (jsonb_typeof(metadata) = 'object'),
    UNIQUE (environment, request_id)
);

CREATE TABLE IF NOT EXISTS flow_steps (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id         UUID NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
    parent_step_id UUID REFERENCES flow_steps(id) ON DELETE SET NULL,
    org_id         UUID REFERENCES organizations(id) ON DELETE CASCADE,
    node_key       TEXT NOT NULL,
    node_type      TEXT NOT NULL,
    service        TEXT NOT NULL,
    operation      TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'running',
    attempt        INT NOT NULL DEFAULT 1,
    request_id     TEXT,
    trace_id       TEXT NOT NULL,
    job_id         TEXT,
    workflow_id    TEXT,
    queue_name     TEXT,
    provider       TEXT,
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at    TIMESTAMPTZ,
    duration_ms    NUMERIC(12, 2),
    error_code     TEXT,
    retryable      BOOLEAN,
    metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT flow_steps_status_check CHECK (
        status IN ('running', 'succeeded', 'failed', 'skipped', 'retrying')
    ),
    CONSTRAINT flow_steps_attempt_check CHECK (attempt > 0),
    CONSTRAINT flow_steps_metadata_object_check CHECK (jsonb_typeof(metadata) = 'object')
);

-- Provider rate-limit budget cache. Written by the Automation worker system
-- transaction; read by the API worker for connected-account responses.
CREATE TABLE IF NOT EXISTS rate_limit_budgets (
    platform     TEXT NOT NULL,
    account_id   TEXT NOT NULL,
    remaining    INT,
    percent_used INT,
    resets_at    TIMESTAMPTZ,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (platform, account_id),
    CHECK (remaining IS NULL OR remaining >= 0),
    CHECK (percent_used IS NULL OR percent_used BETWEEN 0 AND 100),
    CHECK (resets_at IS NULL OR resets_at >= updated_at)
);

ALTER TABLE rate_limit_budgets ENABLE ROW LEVEL SECURITY;

CREATE POLICY rate_limit_budgets_visible_account
    ON rate_limit_budgets
    FOR SELECT
    USING (EXISTS (
        SELECT 1
        FROM platform_accounts AS account
        WHERE account.platform = rate_limit_budgets.platform
          AND account.platform_user_id = rate_limit_budgets.account_id
    ));

-- ---------------------------------------------------------------------------
-- Indexes (final set after the redundant-index review; strict prefixes of
-- broader indexes are intentionally absent).
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_org_members_org_id ON org_members(org_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user_id ON org_members(user_id);

-- Brand Profile lifecycle indexes: the two partial org listings back the
-- active and Deleted Brand Profiles views, and the purge index feeds the
-- seven-day retention sweep. The unconditional (org_id, normalized_name)
-- unique constraint on the table already covers name lookups.
CREATE INDEX IF NOT EXISTS idx_brand_profiles_org_active
    ON brand_profiles(org_id, created_at ASC, id)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_brand_profiles_org_deleted
    ON brand_profiles(org_id, deleted_at DESC, id)
    WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_brand_profiles_purge_due
    ON brand_profiles(purge_at, id)
    WHERE purge_at IS NOT NULL;

-- brand_profile_id leftmost indexes serve both the composite-FK cascade
-- probes on Brand Profile purge and the profile-scoped list views.
CREATE INDEX IF NOT EXISTS idx_platform_accounts_brand_profile_id
    ON platform_accounts(brand_profile_id);

CREATE INDEX IF NOT EXISTS idx_platform_accounts_org_id ON platform_accounts(org_id);
CREATE INDEX IF NOT EXISTS idx_platform_accounts_org_id_created_at
    ON platform_accounts(org_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_platform_accounts_token_expires_at
    ON platform_accounts(token_expires_at)
    WHERE token_expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_platform_accounts_token_refresh_due
    ON platform_accounts(token_refresh_next_attempt_at, id)
    WHERE connection_status IN ('connected', 'expiring')
      AND token_expires_at IS NOT NULL
      AND token_refresh_next_attempt_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_assets_org_id ON assets(org_id);
CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);
CREATE INDEX IF NOT EXISTS idx_assets_org_id_created_at_active
    ON assets(org_id, created_at DESC)
    WHERE status <> 'deleted';
CREATE INDEX IF NOT EXISTS idx_assets_lifecycle_due
    ON assets(status, failure_at, updated_at, id)
    WHERE status IN ('processing', 'failed', 'deleting');
CREATE INDEX IF NOT EXISTS idx_assets_org_type_status_created
    ON assets(org_id, asset_type, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_assets_org_tags
    ON assets USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_assets_brand_profile_created_at
    ON assets(brand_profile_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_distributions_asset_id ON distributions(asset_id);
CREATE INDEX IF NOT EXISTS idx_distributions_status ON distributions(status);
CREATE INDEX IF NOT EXISTS idx_distributions_org_event_stable
    ON distributions(org_id, event_at, id);
CREATE INDEX IF NOT EXISTS idx_distributions_brand_profile_event
    ON distributions(brand_profile_id, event_at, id);
CREATE INDEX IF NOT EXISTS idx_distributions_org_id_published_id
    ON distributions(org_id, id)
    WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_distributions_published_platform_sync_at
    ON distributions((COALESCE(published_at, updated_at)), id)
    WHERE status = 'published'
      AND platform_post_id IS NOT NULL
      AND platform_post_id <> '';
CREATE INDEX IF NOT EXISTS idx_distributions_due_schedule
    ON distributions(status, scheduled_at, id)
    WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_distributions_retry_due
    ON distributions(status, next_attempt_at, id)
    WHERE status = 'failed' AND failure_retryable = true;
CREATE INDEX IF NOT EXISTS idx_distributions_reconciliation_due
    ON distributions(status, next_attempt_at, id)
    WHERE status IN ('awaiting_provider', 'needs_reconciliation')
      AND next_attempt_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_distributions_analytics_sync_due
    ON distributions(analytics_next_sync_at, id)
    WHERE status = 'published'
      AND platform_post_id IS NOT NULL
      AND analytics_next_sync_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_distributions_comments_sync_due
    ON distributions(comments_next_sync_at, id)
    WHERE status = 'published'
      AND platform_post_id IS NOT NULL
      AND comments_next_sync_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_distributions_comments_on_demand
    ON distributions(org_id, comments_last_synced_at, id)
    WHERE status = 'published'
      AND platform_post_id IS NOT NULL
      AND comments_next_sync_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_distributions_platform_account_cancel
    ON distributions(platform_account_id)
    WHERE status IN ('scheduled', 'queued');
CREATE INDEX IF NOT EXISTS idx_distributions_usage_period
    ON distributions(org_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_analytics_distribution_id ON analytics_snapshots(distribution_id);
CREATE INDEX IF NOT EXISTS idx_analytics_snapshot_at ON analytics_snapshots(snapshot_at);
CREATE INDEX IF NOT EXISTS idx_analytics_distribution_id_snapshot_at_desc
    ON analytics_snapshots(distribution_id, snapshot_at DESC)
    INCLUDE (views, likes, comments, shares);
CREATE INDEX IF NOT EXISTS idx_analytics_org_id_distribution_snapshot_at_desc
    ON analytics_snapshots(org_id, distribution_id, snapshot_at DESC)
    INCLUDE (views, likes, comments, shares);
CREATE INDEX IF NOT EXISTS idx_analytics_org_snapshot_distribution
    ON analytics_snapshots(org_id, snapshot_at, distribution_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_distribution_hour_unique
    ON analytics_snapshots(distribution_id, snapshot_at);
CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_retention
    ON analytics_snapshots(snapshot_at, id);

CREATE INDEX IF NOT EXISTS idx_comments_distribution_id ON comments(distribution_id);
CREATE INDEX IF NOT EXISTS idx_comments_replied ON comments(replied);
CREATE INDEX IF NOT EXISTS idx_comments_reply_status ON comments(reply_status);
CREATE INDEX IF NOT EXISTS idx_comments_org_id_commented_at
    ON comments(org_id, commented_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_org_id_replied_commented_at
    ON comments(org_id, replied, commented_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_org_filters_stable
    ON comments(org_id, commented_at DESC, id DESC)
    INCLUDE (distribution_id, reply_status, replied);
CREATE INDEX IF NOT EXISTS idx_comments_reply_work
    ON comments(reply_status, reply_lease_expires_at, updated_at, id)
    WHERE reply_status IN ('queued', 'in_progress', 'needs_reconciliation');

CREATE INDEX IF NOT EXISTS idx_usage_records_org_id ON usage_records(org_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_period ON usage_records(period);

CREATE INDEX IF NOT EXISTS idx_webhook_events_provider_outcome_received
    ON webhook_events(provider, outcome, received_at);
CREATE INDEX IF NOT EXISTS idx_webhook_events_retention
    ON webhook_events(processed_at, id)
    WHERE outcome IN ('processed', 'ignored', 'failed');

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expiry
    ON idempotency_keys(expires_at);

CREATE INDEX IF NOT EXISTS idx_outbox_events_due
    ON outbox_events(state, available_at, created_at)
    WHERE state IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_outbox_events_relay_due
    ON outbox_events(state, available_at, lease_expires_at, created_at, id)
    WHERE state IN ('pending', 'failed', 'leased');
CREATE INDEX IF NOT EXISTS idx_outbox_events_retention
    ON outbox_events(updated_at, id)
    WHERE state IN ('published', 'dead');
CREATE INDEX IF NOT EXISTS idx_outbox_events_aggregate_publish_pending
    ON outbox_events(aggregate_id)
    WHERE topic = 'distribution.publish.requested'
      AND state IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_async_job_events_outcome_updated
    ON async_job_events(outcome, lease_expires_at, updated_at, event_key);
CREATE INDEX IF NOT EXISTS idx_async_job_events_org_type
    ON async_job_events(org_id, aggregate_type, created_at);
CREATE INDEX IF NOT EXISTS idx_async_job_events_retention
    ON async_job_events(processed_at, event_key)
    WHERE outcome IN ('succeeded', 'skipped');

CREATE INDEX IF NOT EXISTS idx_asset_upload_sessions_org_status_expiry
    ON asset_upload_sessions(org_id, status, expires_at, id);
CREATE INDEX IF NOT EXISTS idx_asset_upload_sessions_usage_period
    ON asset_upload_sessions(org_id, completed_at, asset_id)
    WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS idx_asset_upload_sessions_retention
    ON asset_upload_sessions(expires_at, id)
    WHERE status IN ('created', 'uploading');

CREATE INDEX IF NOT EXISTS idx_asset_quota_reservations_org_active
    ON asset_quota_reservations(org_id, state)
    INCLUDE (bytes);

CREATE INDEX IF NOT EXISTS idx_provider_operations_distribution
    ON provider_operations(distribution_id, operation, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_operations_comment
    ON provider_operations(comment_id, operation, updated_at DESC)
    WHERE comment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_provider_operations_usage_period
    ON provider_operations(org_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_operator_actions_target
    ON operator_actions(target_type, target_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_reconciliation_due
    ON usage_reconciliation_state(next_reconciliation_at, lease_until, org_id);

CREATE INDEX IF NOT EXISTS idx_usage_corrections_org_period
    ON usage_corrections(org_id, period, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_usage_corrections_retention
    ON usage_corrections(created_at, id);

CREATE INDEX IF NOT EXISTS idx_billing_operations_reconciliation
    ON billing_operations(status, lease_expires_at, updated_at, id)
    WHERE status IN ('started', 'needs_reconciliation');
CREATE INDEX IF NOT EXISTS idx_billing_operations_org_created
    ON billing_operations(org_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_flow_runs_recent
    ON flow_runs(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_flow_runs_trace
    ON flow_runs(environment, trace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_flow_runs_org
    ON flow_runs(org_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_flow_steps_run
    ON flow_steps(run_id, started_at, id);
CREATE INDEX IF NOT EXISTS idx_flow_steps_request
    ON flow_steps(request_id, started_at, id)
    WHERE request_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Row-level security. The API worker serializes verified actor claims
-- ({ sub: auth subject, org_id: internal workspace UUID, org_role }) into the
-- transaction-local request.jwt.claims GUC; auth.jwt() exposes it and the
-- auth_active_* functions resolve the active workspace and user through
-- users.auth_user_id (with an internal-UUID subject fallback for seeded
-- fixtures). All of this requires the meltiply_rls role, which the local
-- migrate script and Neon provisioning create before migrations run.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = 'meltiply_rls'
    ) THEN
        RAISE NOTICE 'meltiply_rls role unavailable; skipping RLS setup';
        RETURN;
    END IF;

    -- GUC-backed claims accessor replacing the Neon pg_session_jwt extension
    -- so RLS enforces identically on Neon and on plain Postgres (local/CI).
    CREATE SCHEMA IF NOT EXISTS auth;
    EXECUTE $fn$
        CREATE OR REPLACE FUNCTION auth.jwt()
        RETURNS jsonb
        LANGUAGE sql
        STABLE
        AS $body$
            SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb
        $body$
    $fn$;
    EXECUTE 'REVOKE ALL ON FUNCTION auth.jwt() FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION auth.jwt() TO meltiply_rls';

    -- Active workspace: the org_id claim names an internal organizations.id
    -- the subject belongs to; without the claim the subject's personal
    -- workspace is the active one.
    EXECUTE $fn$
        CREATE OR REPLACE FUNCTION public.auth_active_org_id()
        RETURNS uuid
        LANGUAGE sql
        STABLE
        SECURITY DEFINER
        SET search_path = public, auth, pg_temp
        AS $body$
            SELECT o.id
            FROM organizations o
            JOIN org_members om ON om.org_id = o.id
            JOIN users u ON u.id = om.user_id
            WHERE (
                u.auth_user_id = auth.jwt()->>'sub'
                OR u.id::text = auth.jwt()->>'sub'
            )
            AND (
                (
                    NULLIF(auth.jwt()->>'org_id', '') IS NOT NULL
                    AND o.id::text = auth.jwt()->>'org_id'
                )
                OR (
                    NULLIF(auth.jwt()->>'org_id', '') IS NULL
                    AND o.personal_user_id = u.id
                )
            )
            LIMIT 1
        $body$
    $fn$;

    -- Active user resolves through the active workspace so both helpers share
    -- a single definition of "active workspace" (personal sessions carry no
    -- org_id claim and must still resolve their identity row).
    EXECUTE $fn$
        CREATE OR REPLACE FUNCTION public.auth_active_user_id()
        RETURNS uuid
        LANGUAGE sql
        STABLE
        SECURITY DEFINER
        SET search_path = public, auth, pg_temp
        AS $body$
            SELECT u.id
            FROM users u
            JOIN org_members om ON om.user_id = u.id
            WHERE (
                u.auth_user_id = auth.jwt()->>'sub'
                OR u.id::text = auth.jwt()->>'sub'
            )
            AND om.org_id = public.auth_active_org_id()
            LIMIT 1
        $body$
    $fn$;

    EXECUTE $fn$
        CREATE OR REPLACE FUNCTION public.auth_user_can_access_org(target_org_id uuid)
        RETURNS boolean
        LANGUAGE sql
        STABLE
        SECURITY DEFINER
        SET search_path = public, auth, pg_temp
        AS $body$
            SELECT target_org_id = public.auth_active_org_id()
        $body$
    $fn$;

    -- Active membership role resolves from org_members rather than the
    -- org_role claim so RLS admin checks stay authoritative even if a stale
    -- or incomplete claim set reaches the database. Returns NULL when the
    -- subject has no membership in the active workspace.
    EXECUTE $fn$
        CREATE OR REPLACE FUNCTION public.auth_active_org_role()
        RETURNS text
        LANGUAGE sql
        STABLE
        SECURITY DEFINER
        SET search_path = public, auth, pg_temp
        AS $body$
            SELECT om.role
            FROM org_members om
            WHERE om.org_id = public.auth_active_org_id()
              AND om.user_id = public.auth_active_user_id()
            LIMIT 1
        $body$
    $fn$;

    EXECUTE 'REVOKE ALL ON FUNCTION public.auth_active_org_id() FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION public.auth_active_user_id() FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION public.auth_active_org_role() FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION public.auth_user_can_access_org(uuid) FROM PUBLIC';
    EXECUTE 'GRANT USAGE ON SCHEMA public TO meltiply_rls';
    EXECUTE 'GRANT USAGE ON SCHEMA auth TO meltiply_rls';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.auth_active_org_id() TO meltiply_rls';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.auth_active_user_id() TO meltiply_rls';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.auth_active_org_role() TO meltiply_rls';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.auth_user_can_access_org(uuid) TO meltiply_rls';

    -- Table grants for the authenticated role. Better Auth tables and the
    -- abuse-control ledger stay system-only.
    EXECUTE 'REVOKE ALL ON TABLE "user", "session", "account", "verification", auth_rate_limits FROM meltiply_rls';
    EXECUTE 'GRANT SELECT ON TABLE users TO meltiply_rls';
    EXECUTE 'GRANT SELECT ON TABLE org_members TO meltiply_rls';
    EXECUTE 'GRANT SELECT ON TABLE organizations TO meltiply_rls';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE brand_profiles TO meltiply_rls';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE workspace_invitations TO meltiply_rls';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE assets TO meltiply_rls';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE distributions TO meltiply_rls';
    EXECUTE 'GRANT SELECT, DELETE ON TABLE platform_accounts TO meltiply_rls';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE usage_records TO meltiply_rls';
    EXECUTE 'GRANT SELECT, UPDATE ON TABLE comments TO meltiply_rls';
    EXECUTE 'GRANT SELECT ON TABLE analytics_snapshots TO meltiply_rls';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE idempotency_keys TO meltiply_rls';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE outbox_events TO meltiply_rls';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE asset_upload_sessions TO meltiply_rls';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE asset_upload_parts TO meltiply_rls';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE asset_quota_reservations TO meltiply_rls';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE provider_operations TO meltiply_rls';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE organization_locks TO meltiply_rls';
    EXECUTE 'GRANT SELECT ON TABLE flow_runs TO meltiply_rls';
    EXECUTE 'GRANT SELECT ON TABLE flow_steps TO meltiply_rls';
    EXECUTE 'GRANT SELECT ON TABLE rate_limit_budgets TO meltiply_rls';

    EXECUTE 'ALTER TABLE users ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE org_members ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE organizations ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE workspace_invitations ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE brand_profiles ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE assets ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE distributions ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE platform_accounts ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE comments ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE analytics_snapshots ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE asset_upload_sessions ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE asset_upload_parts ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE asset_quota_reservations ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE provider_operations ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE organization_locks ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE flow_runs ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE flow_steps ENABLE ROW LEVEL SECURITY';

    EXECUTE $policy$
        CREATE POLICY "Users can view their active identity"
        ON users
        FOR SELECT
        TO meltiply_rls
        USING (id = (SELECT public.auth_active_user_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can view their active membership"
        ON org_members
        FOR SELECT
        TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND user_id = (SELECT public.auth_active_user_id())
        )
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can view their active organization"
        ON organizations
        FOR SELECT
        TO meltiply_rls
        USING (id = (SELECT public.auth_active_org_id()))
    $policy$;

    -- Brand Profile policies: every workspace member reads active profiles;
    -- only admins see soft-deleted rows or run management mutations. The role
    -- check resolves through org_members (auth_active_org_role) rather than
    -- the org_role claim so a stale claim cannot escalate privileges.
    EXECUTE $policy$
        CREATE POLICY "Members can view active brand profiles in their workspace"
        ON brand_profiles
        FOR SELECT
        TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND deleted_at IS NULL
        )
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Admins can view deleted brand profiles in their workspace"
        ON brand_profiles
        FOR SELECT
        TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND deleted_at IS NOT NULL
            AND public.auth_active_org_role() = 'admin'
        )
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Admins can insert brand profiles in their workspace"
        ON brand_profiles
        FOR INSERT
        TO meltiply_rls
        WITH CHECK (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() = 'admin'
        )
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Admins can update brand profiles in their workspace"
        ON brand_profiles
        FOR UPDATE
        TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() = 'admin'
        )
        WITH CHECK (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() = 'admin'
        )
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Admins can delete brand profiles in their workspace"
        ON brand_profiles
        FOR DELETE
        TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() = 'admin'
        )
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can view invitations in their active workspace"
        ON workspace_invitations
        FOR SELECT
        TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Admins can manage invitations in their active workspace"
        ON workspace_invitations
        FOR ALL
        TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
        WITH CHECK (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can view assets in their active org"
        ON assets
        FOR SELECT
        TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can insert assets in their active org"
        ON assets
        FOR INSERT
        TO meltiply_rls
        WITH CHECK (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can update assets in their active org"
        ON assets
        FOR UPDATE
        TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
        WITH CHECK (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can delete assets in their active org"
        ON assets
        FOR DELETE
        TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can view distributions in their active org"
        ON distributions
        FOR SELECT
        TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can insert distributions in their active org"
        ON distributions
        FOR INSERT
        TO meltiply_rls
        WITH CHECK (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can update distributions in their active org"
        ON distributions
        FOR UPDATE
        TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
        WITH CHECK (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can view platform accounts in their active org"
        ON platform_accounts
        FOR SELECT
        TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can delete platform accounts in their active org"
        ON platform_accounts
        FOR DELETE
        TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can view usage records in their active org"
        ON usage_records
        FOR SELECT
        TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can insert usage records in their active org"
        ON usage_records
        FOR INSERT
        TO meltiply_rls
        WITH CHECK (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can update usage records in their active org"
        ON usage_records
        FOR UPDATE
        TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
        WITH CHECK (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can view comments in their active org"
        ON comments
        FOR SELECT
        TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can update comments in their active org"
        ON comments
        FOR UPDATE
        TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
        WITH CHECK (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can view analytics snapshots in their active org"
        ON analytics_snapshots
        FOR SELECT
        TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can manage idempotency in their active org"
        ON idempotency_keys
        FOR ALL
        TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
        WITH CHECK (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can create outbox events in their active org"
        ON outbox_events
        FOR INSERT
        TO meltiply_rls
        WITH CHECK (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can view outbox events in their active org"
        ON outbox_events
        FOR SELECT
        TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can cancel unpublished outbox events"
        ON outbox_events
        FOR DELETE TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id())
               AND state IN ('pending', 'failed'))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can update unpublished outbox events"
        ON outbox_events
        FOR UPDATE TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id())
               AND state IN ('pending', 'failed'))
        WITH CHECK (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can manage upload sessions in their active org"
        ON asset_upload_sessions
        FOR ALL
        TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
        WITH CHECK (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can manage upload parts in their active org"
        ON asset_upload_parts
        FOR ALL
        TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
        WITH CHECK (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can manage quota reservations in their active org"
        ON asset_quota_reservations
        FOR ALL
        TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
        WITH CHECK (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can manage provider operations in their active org"
        ON provider_operations
        FOR ALL TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
        WITH CHECK (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can lock their active organization"
        ON organization_locks
        FOR ALL
        TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
        WITH CHECK (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can view flow runs in their active org"
        ON flow_runs
        FOR SELECT TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
    $policy$;

    EXECUTE $policy$
        CREATE POLICY "Users can view flow steps in their active org"
        ON flow_steps
        FOR SELECT TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
    $policy$;
END;
$$;

-- The abuse-control ledger is written through the system role only.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_system') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth_rate_limits TO meltiply_system';
        EXECUTE 'GRANT EXECUTE ON FUNCTION public.auth_rate_limit_hit(TEXT, TEXT, INT, INT) TO meltiply_system';
    END IF;
END;
$$;
