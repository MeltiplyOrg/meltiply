-- meltiply-release-phase: expand
-- Durable state for the installed Better Auth device-authorization plugin.
--
-- The plugin owns issuance, claim, approval/denial, polling, expiry, and atomic
-- consumption. This table is the plugin's schema authority pinned to the
-- installed version, with two server-side additions:
--
--   * "claimSessionId" binds approval/denial to the browser session that
--     verified the user code. Better Auth itself binds a request to the member
--     (userId); the API Worker adds the stricter same-session guard required by
--     the melti-cli protocol. A null value after session revocation fails
--     closed, so a replacement browser session must restart authorization.
--   * The client check keeps the supported client identifier at exactly
--     melti-cli even if application composition regresses.
--
-- Only the privileged auth/database role may read or write this table. Device
-- and user codes are credentials: no RLS role, PUBLIC grant, or log surface may
-- expose them. Expired rows are removed by the plugin when encountered; the
-- expiry index keeps a future cleanup job bounded.
CREATE TABLE IF NOT EXISTS "deviceCode" (
    id                TEXT PRIMARY KEY,
    "deviceCode"      TEXT NOT NULL,
    "userCode"        TEXT NOT NULL,
    "userId"          TEXT REFERENCES "user"(id) ON DELETE CASCADE,
    "expiresAt"       TIMESTAMPTZ NOT NULL,
    status            TEXT NOT NULL,
    "lastPolledAt"    TIMESTAMPTZ,
    "pollingInterval" INTEGER,
    "clientId"        TEXT NOT NULL,
    scope             TEXT,
    "claimSessionId"  TEXT REFERENCES "session"(id) ON DELETE SET NULL,
    CONSTRAINT device_code_unique_device_code UNIQUE ("deviceCode"),
    CONSTRAINT device_code_unique_user_code UNIQUE ("userCode"),
    CONSTRAINT device_code_status_check CHECK (status IN ('pending', 'approved', 'denied')),
    CONSTRAINT device_code_client_check CHECK ("clientId" = 'melti-cli')
);

CREATE INDEX IF NOT EXISTS idx_device_code_expiry ON "deviceCode"("expiresAt");
CREATE INDEX IF NOT EXISTS idx_device_code_claim_session ON "deviceCode"("claimSessionId");

REVOKE ALL ON "deviceCode" FROM PUBLIC, meltiply_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON "deviceCode" TO meltiply_system;
