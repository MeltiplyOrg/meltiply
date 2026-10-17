-- meltiply-release-phase: expand
-- The owner marker is server-only. Non-owner rows remain useful for isolated RLS
-- fixtures, but cannot establish application sessions. Registration always sets it.
ALTER TABLE "user" ADD COLUMN "installationOwner" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "user" ADD COLUMN "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
    IF (SELECT count(*) FROM "user") > 1 THEN
        RAISE EXCEPTION 'Single-user migration requires exactly one existing account or an empty installation. Local databases seeded before this migration should be reset with make reset. For production databases, back up and explicitly select the retained owner before migrating.';
    END IF;
    UPDATE "user" SET "installationOwner" = TRUE;
END;
$$;

-- The unique index is the final arbiter even for concurrent first registrations.
CREATE UNIQUE INDEX single_installation_owner ON "user" ((TRUE)) WHERE "installationOwner";

CREATE TABLE "twoFactor" (
    id TEXT PRIMARY KEY,
    secret TEXT NOT NULL,
    "backupCodes" TEXT NOT NULL,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    verified BOOLEAN NOT NULL DEFAULT TRUE,
    "failedVerificationCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ
);
CREATE INDEX two_factor_user_id ON "twoFactor" ("userId");
CREATE INDEX two_factor_secret ON "twoFactor" (secret);
REVOKE ALL ON "twoFactor" FROM PUBLIC, meltiply_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON "twoFactor" TO meltiply_system;

-- Credentials and factor changes invalidate previously minted authority. New
-- replacement sessions, if any, are created by Better Auth after these writes.
CREATE FUNCTION public.revoke_security_sessions() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'account' THEN
        IF OLD.password IS DISTINCT FROM NEW.password THEN
            DELETE FROM "session" WHERE "userId" = NEW."userId";
        END IF;
    ELSIF OLD."twoFactorEnabled" IS DISTINCT FROM NEW."twoFactorEnabled"
       OR OLD.email IS DISTINCT FROM NEW.email
       OR OLD."emailVerified" IS DISTINCT FROM NEW."emailVerified"
       OR OLD."installationOwner" IS DISTINCT FROM NEW."installationOwner" THEN
        DELETE FROM "session" WHERE "userId" = NEW.id;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER revoke_password_sessions AFTER UPDATE OF password ON "account"
FOR EACH ROW EXECUTE FUNCTION public.revoke_security_sessions();
CREATE TRIGGER revoke_account_sessions AFTER UPDATE OF "twoFactorEnabled", email, "emailVerified", "installationOwner" ON "user"
FOR EACH ROW EXECUTE FUNCTION public.revoke_security_sessions();
