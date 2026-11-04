-- meltiply-release-phase: expand
-- Installation bootstrap and resumable Owner onboarding.
--
-- The chosen Workspace name is captured with the first sign-up so it survives
-- the email-verification handoff, then applied once when the canonical shared
-- Workspace is created. Onboarding progress is a separate fact from
-- registration authority: the existence of an owner account remains the only
-- gate on public sign-up, so an unfinished optional journey never reopens it.
CREATE TABLE installation_bootstrap (
    -- Better Auth subject of the account created by the serialized first sign-up.
    auth_user_id   TEXT PRIMARY KEY,
    -- Name chosen in the setup form; NULL when the client omitted it.
    workspace_name TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT installation_bootstrap_workspace_name_check
        CHECK (workspace_name IS NULL OR (
            length(btrim(workspace_name)) BETWEEN 1 AND 200
            AND workspace_name !~ '[[:cntrl:]]'
        ))
);

-- One row per installation whose Owner entered first-run onboarding. Its
-- absence is what marks an existing upgraded installation as not applicable.
CREATE TABLE installation_onboarding (
    org_id          UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    -- Chosen name at finalization; kept for the progress record, never re-applied.
    workspace_name  TEXT,
    -- True once the chosen name was applied to the shared Workspace. A later
    -- Settings rename does not clear it, so finalization never overwrites it.
    workspace_named BOOLEAN NOT NULL DEFAULT FALSE,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT installation_onboarding_workspace_name_check
        CHECK (workspace_name IS NULL OR (
            length(btrim(workspace_name)) BETWEEN 1 AND 200
            AND workspace_name !~ '[[:cntrl:]]'
        ))
);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_system') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE ON installation_bootstrap TO meltiply_system';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE ON installation_onboarding TO meltiply_system';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_rls') THEN
        EXECUTE 'REVOKE ALL ON installation_bootstrap FROM meltiply_rls';
        EXECUTE 'REVOKE ALL ON installation_onboarding FROM meltiply_rls';
    END IF;
END;
$$;
