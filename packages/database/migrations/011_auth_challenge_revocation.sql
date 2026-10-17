-- meltiply-release-phase: expand
-- Password/account changes also revoke signed pending-factor and trusted-device
-- records. A password reset must not leave an earlier sign-in challenge usable.
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
       OR OLD."emailVerified" IS DISTINCT FROM NEW."emailVerified"
       OR OLD."installationOwner" IS DISTINCT FROM NEW."installationOwner" THEN
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
