-- meltiply-release-phase: expand
-- Credential provenance belongs to the session, not to spoofable request
-- headers or JWT hints. Existing and directly inserted sessions remain unknown;
-- only the issuing auth endpoint establishes web or CLI provenance.
ALTER TABLE "session"
    ADD COLUMN "clientChannel" TEXT NOT NULL DEFAULT 'unknown',
    ADD CONSTRAINT session_client_channel_check
        CHECK ("clientChannel" IN ('web', 'cli', 'unknown'));
