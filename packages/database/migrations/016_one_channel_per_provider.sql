-- meltiply-release-phase: expand
-- One Brand Profile owns at most one Channel per Provider. Multiple distinct
-- external accounts of the same Platform must be split across Brand Profiles;
-- the global (platform, platform_user_id) key from 001 still prevents the same
-- external account from attaching anywhere else until it is disconnected.
--
-- The previous flow allowed several accounts of one Platform under a Profile,
-- so existing duplicates are not rewritten or deleted: this expand phase keeps
-- them usable (including token rotation and reconnect) and enforces the
-- invariant for every new Channel or owner change. A later contract migration
-- can replace the trigger with the unique index once operators have
-- disconnected the extras.
DO $$
DECLARE
    conflicts TEXT;
BEGIN
    SELECT string_agg(
               format('%s/%s (%s Channels)', brand_profile_id, platform, channel_count),
               '; ' ORDER BY brand_profile_id, platform)
      INTO conflicts
      FROM (
        SELECT brand_profile_id, platform, count(*) AS channel_count
          FROM platform_accounts
         GROUP BY brand_profile_id, platform
        HAVING count(*) > 1
      ) AS duplicate;
    IF conflicts IS NOT NULL THEN
        RAISE NOTICE
            'Legacy Brand Profiles still own more than one Channel of a Provider: %. Existing Channels keep working; disconnect the extra Channels before a contract migration can add the unique index.',
            conflicts;
    END IF;
END;
$$;

-- Supports the trigger's profile/Provider lookup and the API's conflict
-- pre-check without blocking a duplicate-clean database.
CREATE INDEX IF NOT EXISTS platform_accounts_brand_profile_platform_idx
    ON platform_accounts (brand_profile_id, platform);

-- Arbitrates concurrent OAuth callbacks and direct writes. An INSERT whose
-- (platform, platform_user_id) already exists is the ON CONFLICT target for a
-- reconnect and can only update that row, so it never adds a slot. Every other
-- insert, and any move to another Profile or Provider, is checked against the
-- owning Profile.
CREATE OR REPLACE FUNCTION public.reject_duplicate_profile_channel()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT'
       AND EXISTS (
           SELECT 1
           FROM public.platform_accounts
           WHERE platform = NEW.platform
             AND platform_user_id = NEW.platform_user_id
       )
    THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT'
       OR NEW.brand_profile_id IS DISTINCT FROM OLD.brand_profile_id
       OR NEW.platform IS DISTINCT FROM OLD.platform
    THEN
        IF EXISTS (
            SELECT 1
            FROM public.platform_accounts
            WHERE brand_profile_id = NEW.brand_profile_id
              AND platform = NEW.platform
              AND id IS DISTINCT FROM NEW.id
        ) THEN
            RAISE EXCEPTION
                'Brand Profile % already owns a % Channel; disconnect it before connecting another.',
                NEW.brand_profile_id, NEW.platform
                USING ERRCODE = '23505';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS platform_accounts_one_channel_per_provider ON platform_accounts;
CREATE TRIGGER platform_accounts_one_channel_per_provider
    BEFORE INSERT OR UPDATE OF brand_profile_id, platform ON platform_accounts
    FOR EACH ROW
    EXECUTE FUNCTION public.reject_duplicate_profile_channel();

-- The function ships with the default PUBLIC EXECUTE grant; name the tenant
-- role explicitly so a future PUBLIC revocation cannot break Channel writes
-- from the authenticated pool or the shared test fixtures.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_rls') THEN
        GRANT EXECUTE ON FUNCTION public.reject_duplicate_profile_channel() TO meltiply_rls;
    END IF;
END;
$$;
