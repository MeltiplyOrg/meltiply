-- meltiply-release-phase: expand
-- Preserve migration 011's pending-factor and trusted-device revocation while
-- dropping the retired auth-user owner marker. Without this, a password change
-- or reset would delete sessions but leave an earlier sign-in challenge usable.
CREATE OR REPLACE FUNCTION public.revoke_security_sessions() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    subject_id TEXT;
BEGIN
    IF TG_TABLE_NAME = 'account' THEN
        IF OLD.password IS DISTINCT FROM NEW.password THEN
            subject_id := NEW."userId";
        END IF;
    ELSIF OLD."twoFactorEnabled" IS DISTINCT FROM NEW."twoFactorEnabled"
       OR OLD.email IS DISTINCT FROM NEW.email
       OR OLD."emailVerified" IS DISTINCT FROM NEW."emailVerified" THEN
        subject_id := NEW.id;
    END IF;
    IF subject_id IS NOT NULL THEN
        DELETE FROM "session" WHERE "userId" = subject_id;
        DELETE FROM "verification" WHERE value = subject_id
          AND (identifier LIKE '2fa-%' OR identifier LIKE 'trust-device-%');
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS revoke_password_sessions ON "account";
CREATE TRIGGER revoke_password_sessions AFTER UPDATE OF password ON "account"
FOR EACH ROW EXECUTE FUNCTION public.revoke_security_sessions();

DROP TRIGGER IF EXISTS revoke_account_sessions ON "user";
CREATE TRIGGER revoke_account_sessions
AFTER UPDATE OF "twoFactorEnabled", email, "emailVerified" ON "user"
FOR EACH ROW EXECUTE FUNCTION public.revoke_security_sessions();
