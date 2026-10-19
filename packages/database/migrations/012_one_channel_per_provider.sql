-- meltiply-release-phase: expand
-- One Brand Profile owns at most one Channel per Provider. Multiple distinct
-- external accounts of the same Platform must be split across Brand Profiles;
-- the global (platform, platform_user_id) key from 001 still prevents the same
-- external account from attaching anywhere else until it is disconnected.
--
-- Existing duplicates are not deleted silently: a local database seeded before
-- this migration should be reset with `make reset`, and a live database must
-- disconnect the extra Channels explicitly before the index can be built.
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
        RAISE EXCEPTION
            'Brand Profiles already own more than one Channel of a Provider: %. Disconnect the extra Channels before applying this migration, or reset a local database with make reset.',
            conflicts;
    END IF;
END;
$$;

-- The unique index is the final arbiter even for concurrent OAuth callbacks.
CREATE UNIQUE INDEX platform_accounts_brand_profile_platform_unique
    ON platform_accounts (brand_profile_id, platform);
