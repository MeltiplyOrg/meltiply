-- meltiply-release-phase: expand
-- A device grant is consented to by one live browser session. Deleting that
-- session (sign-out, security change, or account/session revocation) must
-- invalidate any pending or approved request it claimed before the FK's
-- ON DELETE SET NULL can make the request appear unclaimed to another session.
-- A consumed grant also binds its minted CLI session to the claiming browser
-- session, so a concurrent deletion cascades to that session instead of
-- releasing durable authority after the grant row has been consumed.
-- Superseded by migration 025: the session binding and cascade are removed so
-- a later browser sign-out leaves an already-issued CLI session usable; the
-- API now rechecks the claiming session after consumption instead.
ALTER TABLE "session"
    ADD COLUMN "deviceAuthorizationClaimSessionId" TEXT
    REFERENCES "session"(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_session_device_claim_session
    ON "session"("deviceAuthorizationClaimSessionId");

-- The Better Auth token endpoint still owns atomic one-time consumption; this
-- trigger only transitions outstanding grants to the plugin's terminal denied
-- state in the same transaction as session deletion.
CREATE OR REPLACE FUNCTION public.invalidate_device_grants_for_claim_session()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE "deviceCode"
       SET status = 'denied'
     WHERE "claimSessionId" = OLD.id
       AND status IN ('pending', 'approved');
    RETURN OLD;
END;
$$;

CREATE TRIGGER invalidate_device_grants_before_claim_session_delete
BEFORE DELETE ON "session"
FOR EACH ROW
EXECUTE FUNCTION public.invalidate_device_grants_for_claim_session();
