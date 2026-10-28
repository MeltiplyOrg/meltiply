-- meltiply-release-phase: expand
-- Redemption ordering replaces the browser-session foreign-key cascade.
--
-- An approved grant must be redeemed while its claiming browser session is
-- alive, but the resulting CLI session is independent afterwards: signing out
-- of the browser must not revoke a CLI session that was already issued. The
-- API checks the claiming session again after Better Auth consumes the grant:
-- a deletion that completed before that check revokes the minted credential,
-- while a later browser sign-out leaves the CLI session usable.
--
-- Migration 024's trigger remains authoritative for grants that were still
-- pending or approved when that session disappeared.
DROP INDEX IF EXISTS idx_session_device_claim_session;
ALTER TABLE "session" DROP COLUMN IF EXISTS "deviceAuthorizationClaimSessionId";
