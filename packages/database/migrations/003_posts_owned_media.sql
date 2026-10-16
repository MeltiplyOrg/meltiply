-- meltiply-release-phase: expand
-- Post-owned media: durable Post identities, ordered scoped Post attachments
-- and targets, Distribution.post_id, immutable publication snapshots, and a
-- complete per-object storage inventory with deterministic rendition
-- identity, orphan grace deadlines, and Asset-lock ownership guards.
--
-- This migration is additive-then-contract for the development data present
-- in a local stack: it never edits 001/002 and it copies every column it
-- removes (text/description into Post default_text, r2_key/r2_thumbnail into
-- asset_objects). It performs no destructive wipe of external data. Assets
-- are never merged: each published group (batch_id when present, otherwise a
-- distinct asset/channel/schedule group) becomes its own Post, and every
-- existing Distribution row with its comments, analytics snapshots, and
-- provider operation ledger entries survives under the new Post identity.

BEGIN;

-- ---------------------------------------------------------------------------
-- Post identity and composition.
-- ---------------------------------------------------------------------------

-- One Post is one durable composition/publication intent. status is a
-- lifecycle state (draft vs active), never a global publication result:
-- per-Channel outcomes live in distributions. Deletion is a soft delete
-- (deleted_at) so published history and analytics keep their references.
CREATE TABLE IF NOT EXISTS posts (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    brand_profile_id UUID NOT NULL,
    title            TEXT NOT NULL DEFAULT '',
    default_text     TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'draft',
    revision         INT NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at       TIMESTAMPTZ,
    CONSTRAINT posts_status_check CHECK (status IN ('draft', 'active')),
    CONSTRAINT posts_revision_check CHECK (revision >= 0),
    -- Composite keys let post_attachments, post_targets, and
    -- distributions carry brand_profile_id so tenant and profile integrity
    -- are enforced by foreign keys rather than application checks.
    CONSTRAINT posts_id_brand_profile_unique UNIQUE (id, brand_profile_id),
    CONSTRAINT posts_id_org_unique UNIQUE (id, org_id),
    CONSTRAINT posts_brand_profile_org_fkey
        FOREIGN KEY (brand_profile_id, org_id)
        REFERENCES brand_profiles(id, org_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_posts_org_id_created_at
    ON posts(org_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_brand_profile_created_at
    ON posts(brand_profile_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_org_id_updated_at
    ON posts(org_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_brand_profile_active
    ON posts(brand_profile_id, updated_at DESC, id DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_posts_status
    ON posts(status);

-- Ordered Post-to-Asset relationships. One Asset may be attached to several
-- retained Posts inside the same Brand Profile; detach is a hard DELETE, and
-- the orphan grace clock is maintained by triggers below so callers never
-- have to remember it.
CREATE TABLE IF NOT EXISTS post_attachments (
    post_id          UUID NOT NULL,
    asset_id         UUID NOT NULL,
    org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    brand_profile_id UUID NOT NULL,
    position         INT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT post_attachments_position_check CHECK (position >= 0),
    CONSTRAINT post_attachments_pk PRIMARY KEY (post_id, asset_id),
    CONSTRAINT post_attachments_post_position_unique UNIQUE (post_id, position),
    CONSTRAINT post_attachments_post_brand_profile_fkey
        FOREIGN KEY (post_id, brand_profile_id)
        REFERENCES posts(id, brand_profile_id) ON DELETE CASCADE,
    CONSTRAINT post_attachments_asset_brand_profile_fkey
        FOREIGN KEY (asset_id, brand_profile_id)
        REFERENCES assets(id, brand_profile_id) ON DELETE CASCADE,
    CONSTRAINT post_attachments_brand_profile_org_fkey
        FOREIGN KEY (brand_profile_id, org_id)
        REFERENCES brand_profiles(id, org_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_post_attachments_asset_id
    ON post_attachments(asset_id);
CREATE INDEX IF NOT EXISTS idx_post_attachments_post_id
    ON post_attachments(post_id, position);
CREATE INDEX IF NOT EXISTS idx_post_attachments_brand_profile_id
    ON post_attachments(brand_profile_id);

-- Saved per-Channel target settings. attachment_ids is the ordered subset
-- chosen for that Channel: NULL inherits the Post attachment order, an empty
-- array is a deliberate text-only target.
CREATE TABLE IF NOT EXISTS post_targets (
    post_id              UUID NOT NULL,
    platform_account_id  UUID NOT NULL,
    org_id               UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    brand_profile_id     UUID NOT NULL,
    title_override       TEXT,
    description_override TEXT,
    hashtags             TEXT[],
    provider_options     JSONB NOT NULL DEFAULT '{}'::jsonb,
    attachment_ids       UUID[],
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT post_targets_provider_options_check CHECK (
        jsonb_typeof(provider_options) = 'object'
        AND octet_length(provider_options::text) <= 4096
    ),
    CONSTRAINT post_targets_pk PRIMARY KEY (post_id, platform_account_id),
    CONSTRAINT post_targets_post_brand_profile_fkey
        FOREIGN KEY (post_id, brand_profile_id)
        REFERENCES posts(id, brand_profile_id) ON DELETE CASCADE,
    CONSTRAINT post_targets_platform_account_brand_profile_fkey
        FOREIGN KEY (platform_account_id, brand_profile_id)
        REFERENCES platform_accounts(id, brand_profile_id) ON DELETE CASCADE,
    CONSTRAINT post_targets_brand_profile_org_fkey
        FOREIGN KEY (brand_profile_id, org_id)
        REFERENCES brand_profiles(id, org_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_post_targets_platform_account_id
    ON post_targets(platform_account_id);
CREATE INDEX IF NOT EXISTS idx_post_targets_brand_profile_id
    ON post_targets(brand_profile_id);
CREATE INDEX IF NOT EXISTS idx_post_targets_org_id
    ON post_targets(org_id);

-- ---------------------------------------------------------------------------
-- Storage inventory. asset_objects is the single source of truth for every
-- R2 object belonging to an Asset (staging, promoted original, thumbnail,
-- optimization outputs). assets.r2_key/r2_thumbnail move here.
-- ---------------------------------------------------------------------------

-- Durable per-object inventory. bytes is the verified physical size charged
-- against Entitlements once status leaves 'writing'; reserved_bytes is the
-- capacity reserved for a bounded in-flight write (a completed upload or an
-- optimization output) and is the single charge-once settle point: promotion
-- sets bytes and clears reserved_bytes in one guarded update.
CREATE TABLE IF NOT EXISTS asset_objects (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    asset_id         UUID NOT NULL,
    brand_profile_id UUID NOT NULL,
    kind             TEXT NOT NULL,
    profile          TEXT,
    r2_key           TEXT NOT NULL UNIQUE,
    bytes            BIGINT,
    reserved_bytes   BIGINT,
    etag             TEXT,
    version          TEXT,
    sha256           TEXT,
    content_type     TEXT,
    width            INT,
    height           INT,
    duration_sec     NUMERIC,
    status           TEXT NOT NULL DEFAULT 'writing',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at       TIMESTAMPTZ,
    CONSTRAINT asset_objects_kind_check
        CHECK (kind IN ('staging', 'original', 'thumbnail', 'rendition')),
    CONSTRAINT asset_objects_status_check
        CHECK (status IN ('writing', 'ready', 'superseded', 'deleting', 'deleted')),
    CONSTRAINT asset_objects_bytes_check CHECK (bytes IS NULL OR bytes >= 0),
    CONSTRAINT asset_objects_reserved_bytes_check
        CHECK (reserved_bytes IS NULL OR reserved_bytes > 0),
    CONSTRAINT asset_objects_dimensions_check CHECK (
        (width IS NULL OR width > 0) AND (height IS NULL OR height > 0)
    ),
    CONSTRAINT asset_objects_duration_check CHECK (duration_sec IS NULL OR duration_sec >= 0),
    CONSTRAINT asset_objects_asset_brand_profile_fkey
        FOREIGN KEY (asset_id, brand_profile_id)
        REFERENCES assets(id, brand_profile_id) ON DELETE CASCADE,
    CONSTRAINT asset_objects_brand_profile_org_fkey
        FOREIGN KEY (brand_profile_id, org_id)
        REFERENCES brand_profiles(id, org_id) ON DELETE CASCADE
);

-- At most one live original and one live staging object per Asset; deleted
-- and superseded rows remain as history.
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_objects_live_original
    ON asset_objects(asset_id)
    WHERE kind = 'original' AND status IN ('writing', 'ready');
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_objects_live_staging
    ON asset_objects(asset_id)
    WHERE kind = 'staging' AND status IN ('writing', 'ready');
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_objects_live_rendition_profile
    ON asset_objects(asset_id, profile)
    WHERE kind = 'rendition' AND status IN ('writing', 'ready');
CREATE INDEX IF NOT EXISTS idx_asset_objects_asset_id
    ON asset_objects(asset_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_asset_objects_org_id
    ON asset_objects(org_id);
-- Bounded sweeps: stale in-flight writes and objects claimed for deletion.
CREATE INDEX IF NOT EXISTS idx_asset_objects_lifecycle_due
    ON asset_objects(status, updated_at, id)
    WHERE status IN ('writing', 'deleting');
CREATE INDEX IF NOT EXISTS idx_asset_objects_deleting
    ON asset_objects(status, id)
    WHERE status = 'deleting';
CREATE INDEX IF NOT EXISTS idx_asset_objects_rendition_profile
    ON asset_objects(asset_id, profile)
    WHERE kind = 'rendition' AND status <> 'deleted';

-- Deterministic rendition identity: one row per (asset, profile) so lease and
-- idempotency mechanisms can never multiply retained outputs. Profile values
-- are caller-derived names encoding the selected Platform capability, for
-- example 'image_webp_1080_long_edge' or 'video_h264_aac_1920x1080'; the
-- reserved value 'original' denotes the verified original accepted as a valid
-- rendition when optimization offers no improvement.
CREATE TABLE IF NOT EXISTS asset_renditions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    asset_id         UUID NOT NULL,
    brand_profile_id UUID NOT NULL,
    profile          TEXT NOT NULL,
    object_id        UUID REFERENCES asset_objects(id) ON DELETE SET NULL,
    status           TEXT NOT NULL DEFAULT 'processing',
    failure_code     TEXT,
    failure_message  TEXT,
    failure_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT asset_renditions_status_check
        CHECK (status IN ('processing', 'ready', 'failed', 'deleting', 'deleted')),
    CONSTRAINT asset_renditions_profile_check
        CHECK (profile ~ '^[a-z0-9_]{1,64}$'),
    CONSTRAINT asset_renditions_ready_object_check
        CHECK (status <> 'ready' OR object_id IS NOT NULL),
    CONSTRAINT asset_renditions_asset_profile_unique UNIQUE (asset_id, profile),
    CONSTRAINT asset_renditions_asset_brand_profile_fkey
        FOREIGN KEY (asset_id, brand_profile_id)
        REFERENCES assets(id, brand_profile_id) ON DELETE CASCADE,
    CONSTRAINT asset_renditions_brand_profile_org_fkey
        FOREIGN KEY (brand_profile_id, org_id)
        REFERENCES brand_profiles(id, org_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_asset_renditions_asset_id
    ON asset_renditions(asset_id, status, profile);
CREATE INDEX IF NOT EXISTS idx_asset_renditions_object_id
    ON asset_renditions(object_id)
    WHERE object_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_asset_renditions_org_id
    ON asset_renditions(org_id);
CREATE INDEX IF NOT EXISTS idx_asset_renditions_lifecycle_due
    ON asset_renditions(status, updated_at, id)
    WHERE status IN ('processing', 'deleting');

-- ---------------------------------------------------------------------------
-- Asset lifecycle columns: finalization, orphan grace, and promotion proof.
-- ---------------------------------------------------------------------------

ALTER TABLE assets ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS orphaned_at TIMESTAMPTZ;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS orphan_delete_after TIMESTAMPTZ;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS source_etag TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS source_sha256 TEXT;

-- ---------------------------------------------------------------------------
-- Distributions reference a Post, not a single Asset. Every existing
-- distribution row keeps its identity, outcome, comments, analytics, and
-- provider operation ledger; only its composition reference changes.
--
-- The old model cannot reveal whether two rows for one Asset were two
-- separately created publishing intents or one repeated attempt, so the
-- migration never merges them: a shared batch_id is one publication intent
-- (one Post with one Distribution per Channel), and rows without a batch_id
-- are grouped by (asset, channel, schedule) so distinct schedules stay
-- distinct Posts. A legacy Asset repeated across those groups becomes one
-- Post per group, and every group keeps its own attachment to that Asset.
-- ---------------------------------------------------------------------------

ALTER TABLE distributions DROP CONSTRAINT IF EXISTS distributions_asset_brand_profile_fkey;
DROP INDEX IF EXISTS idx_distributions_asset_id;

ALTER TABLE distributions ADD COLUMN IF NOT EXISTS attachment_ids UUID[];

-- Legacy publication groups. A shared batch_id is one publishing intent that
-- fans out to several Channels, so grouping is keyed on (asset, intent) and
-- not per Channel; without a batch_id each distinct schedule on one Channel is
-- its own intent. post_id is the id of the newest row in the intent, which is
-- deterministic and traceable back to the originating Asset.
CREATE TEMP TABLE distribution_group_003 AS
WITH intent AS (
    SELECT
        distribution.id AS distribution_id,
        distribution.asset_id,
        COALESCE(
            distribution.batch_id::text,
            'schedule:' || COALESCE(
                to_char(
                    distribution.scheduled_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS'
                ),
                'immediate'
            )
        ) AS intent_key
    FROM distributions AS distribution
)
SELECT
    intent.intent_key,
    intent.asset_id,
    max(intent.distribution_id::text)::uuid AS post_id
FROM intent
GROUP BY intent.intent_key, intent.asset_id;

-- The new invariant allows one Distribution per Post and Channel. A legacy
-- intent that somehow holds two rows for the same Channel keeps both rows as
-- history: the newest becomes the intent's Post and the older row keeps its
-- own identity as an independent Post, so no delivered outcome is discarded.
CREATE TEMP TABLE distribution_assignment_003 AS
WITH intent AS (
    SELECT
        distribution.id AS distribution_id,
        distribution.asset_id,
        COALESCE(
            distribution.batch_id::text,
            'schedule:' || COALESCE(
                to_char(
                    distribution.scheduled_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS'
                ),
                'immediate'
            )
        ) AS intent_key,
        row_number() OVER (
            PARTITION BY
                distribution.asset_id,
                distribution.platform_account_id,
                COALESCE(
                    distribution.batch_id::text,
                    'schedule:' || COALESCE(
                        to_char(
                            distribution.scheduled_at AT TIME ZONE 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS'
                        ),
                        'immediate'
                    )
                )
            ORDER BY distribution.event_at DESC, distribution.created_at DESC, distribution.id DESC
        ) AS channel_rank
    FROM distributions AS distribution
)
SELECT
    intent.distribution_id,
    legacy.asset_id,
    CASE
        WHEN intent.channel_rank = 1 THEN legacy.post_id
        ELSE intent.distribution_id
    END AS post_id
FROM intent
JOIN distribution_group_003 AS legacy
  ON legacy.intent_key = intent.intent_key
 AND legacy.asset_id = intent.asset_id;

CREATE UNIQUE INDEX distribution_assignment_003_distribution_id
    ON distribution_assignment_003(distribution_id);

-- One Post per legacy publishing intent plus one per text Asset draft. The
-- Post inherits the owning workspace and Brand Profile, the title, and the
-- caption text of the Asset that produced the intent, so nothing an existing
-- row displayed is lost by the cutover.
INSERT INTO posts (
    id, org_id, brand_profile_id, title, default_text, status, revision,
    created_at, updated_at
)
SELECT
    legacy.id,
    asset.org_id,
    asset.brand_profile_id,
    asset.title,
    COALESCE(asset.text_content, ''),
    'active',
    0,
    asset.created_at,
    asset.updated_at
FROM (
    -- Intents with at least one distribution row.
    SELECT assignment.post_id AS id, assignment.asset_id
    FROM distribution_assignment_003 AS assignment
    -- Text Asset drafts never carried a distribution.
    UNION ALL
    SELECT asset.id, asset.id
    FROM assets AS asset
    WHERE asset.asset_type = 'text'
) AS legacy
JOIN assets AS asset ON asset.id = legacy.asset_id
ON CONFLICT (id) DO NOTHING;

-- Reassign each legacy row to the Post created for its publication intent.
UPDATE distributions AS distribution
SET asset_id = assignment.post_id
FROM distribution_assignment_003 AS assignment
WHERE assignment.distribution_id = distribution.id;

ALTER TABLE distributions RENAME COLUMN asset_id TO post_id;
ALTER TABLE distributions
    ADD CONSTRAINT distributions_post_brand_profile_fkey
        FOREIGN KEY (post_id, brand_profile_id)
        REFERENCES posts(id, brand_profile_id) ON DELETE CASCADE;
ALTER TABLE distributions
    ADD CONSTRAINT distributions_post_platform_account_unique
        UNIQUE (post_id, platform_account_id);
CREATE INDEX IF NOT EXISTS idx_distributions_post_id ON distributions(post_id);
CREATE INDEX IF NOT EXISTS idx_distributions_post_brand_profile
    ON distributions(post_id, brand_profile_id);

-- ---------------------------------------------------------------------------
-- Provider attempt ledger: immutable publication snapshot plus a durable
-- media hold. The snapshot is written once at claim and never updated
-- afterwards, so later Post edits cannot mutate an in-flight or published
-- attempt.
-- ---------------------------------------------------------------------------

-- media_asset_ids is the indexed hold set for orphan sweeps: an attempt row
-- carries its ordered Asset ids alongside the immutable snapshot so cleanup
-- can probe retention without parsing JSON.
ALTER TABLE provider_operations ADD COLUMN IF NOT EXISTS publication_snapshot JSONB;
ALTER TABLE provider_operations ADD COLUMN IF NOT EXISTS media_hold_until TIMESTAMPTZ;
ALTER TABLE provider_operations
    ADD COLUMN IF NOT EXISTS media_asset_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE provider_operations
    ADD CONSTRAINT provider_operations_publication_snapshot_check
    CHECK (publication_snapshot IS NULL OR jsonb_typeof(publication_snapshot) = 'object');

-- Snapshot immutability is enforced by the database, not by caller
-- discipline: once claimed, a publication snapshot can never be replaced or
-- removed, so later Post edits cannot mutate an in-flight attempt or rewrite
-- published history.
CREATE OR REPLACE FUNCTION public.provider_operations_guard_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
    IF OLD.publication_snapshot IS NOT NULL
       AND NEW.publication_snapshot IS DISTINCT FROM OLD.publication_snapshot THEN
        RAISE EXCEPTION 'publication_snapshot of operation % is immutable', OLD.id
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER provider_operations_snapshot_immutable
BEFORE UPDATE OF publication_snapshot ON provider_operations
FOR EACH ROW EXECUTE FUNCTION public.provider_operations_guard_snapshot();

-- One row per ordered media object referenced by an attempt. Cleanup treats a
-- media object as held while the owning operation is running, awaiting
-- reconciliation, or inside its media hold window.
CREATE TABLE IF NOT EXISTS provider_operation_media (
    operation_id     UUID NOT NULL REFERENCES provider_operations(id) ON DELETE CASCADE,
    org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    distribution_id  UUID NOT NULL REFERENCES distributions(id) ON DELETE CASCADE,
    asset_id         UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    brand_profile_id UUID NOT NULL,
    rendition_id     UUID REFERENCES asset_renditions(id) ON DELETE SET NULL,
    object_id        UUID REFERENCES asset_objects(id) ON DELETE SET NULL,
    object_key       TEXT NOT NULL,
    position         INT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT provider_operation_media_position_check CHECK (position >= 0),
    CONSTRAINT provider_operation_media_pk PRIMARY KEY (operation_id, position),
    CONSTRAINT provider_operation_media_asset_brand_profile_fkey
        FOREIGN KEY (asset_id, brand_profile_id)
        REFERENCES assets(id, brand_profile_id) ON DELETE CASCADE,
    CONSTRAINT provider_operation_media_brand_profile_org_fkey
        FOREIGN KEY (brand_profile_id, org_id)
        REFERENCES brand_profiles(id, org_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_provider_operation_media_asset_id
    ON provider_operation_media(asset_id);
CREATE INDEX IF NOT EXISTS idx_provider_operation_media_distribution_id
    ON provider_operation_media(distribution_id);
CREATE INDEX IF NOT EXISTS idx_provider_operation_media_object_id
    ON provider_operation_media(object_id)
    WHERE object_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_provider_operation_media_operation_id
    ON provider_operation_media(operation_id);
CREATE INDEX IF NOT EXISTS idx_provider_operation_media_brand_profile_id
    ON provider_operation_media(brand_profile_id);

-- An upload session can be bound to the Post it is being composed for, so a
-- still-uploading Asset is already owned by a retained Post.
ALTER TABLE asset_upload_sessions ADD COLUMN IF NOT EXISTS post_id UUID;
ALTER TABLE asset_upload_sessions
    ADD CONSTRAINT asset_upload_sessions_post_org_fkey
        FOREIGN KEY (post_id, org_id)
        REFERENCES posts(id, org_id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_asset_upload_sessions_post_id
    ON asset_upload_sessions(post_id)
    WHERE post_id IS NOT NULL;

-- Attachments and saved target settings for the legacy publication groups.
-- Media Assets become ordered Post attachments (position 0 for the single
-- asset the old model could carry); text Assets are standalone Posts whose
-- text is the Post default_text and carry no attachment. One Asset may be
-- attached to several retained Posts, which is exactly what repeated legacy
-- groups on one Asset produce.
INSERT INTO post_attachments (post_id, asset_id, org_id, brand_profile_id, position, created_at)
SELECT
    legacy.post_id, legacy.asset_id, asset.org_id, asset.brand_profile_id, 0, asset.created_at
FROM distribution_group_003 AS legacy
JOIN assets AS asset ON asset.id = legacy.asset_id
WHERE asset.asset_type <> 'text'
ON CONFLICT (post_id, asset_id) DO NOTHING;

-- Saved per-Channel settings derived from the resolved overrides that the
-- asset-centric pipeline already stored on the Distribution.
INSERT INTO post_targets (
    post_id, platform_account_id, org_id, brand_profile_id, title_override,
    description_override, hashtags, provider_options, attachment_ids,
    created_at, updated_at
)
SELECT
    distribution.post_id,
    distribution.platform_account_id,
    distribution.org_id,
    distribution.brand_profile_id,
    distribution.title_override,
    distribution.description_override,
    distribution.hashtags,
    distribution.provider_options,
    NULL,
    distribution.created_at,
    distribution.updated_at
FROM distributions AS distribution
WHERE distribution.platform_account_id IS NOT NULL
ON CONFLICT (post_id, platform_account_id) DO NOTHING;

-- Text Assets were the pre-cutover draft storage; their content is preserved
-- in posts.default_text and the library no longer creates or lists them.
DELETE FROM assets WHERE asset_type = 'text';

-- Object inventory is copied out of the legacy key columns below before those
-- columns are removed.

-- Asset objects: completed uploads become staging objects, and any legacy
-- r2_key becomes the single live original with a deterministic 'original'
-- rendition row. Thumbnail bytes were never accounted separately, so the
-- legacy thumbnail object is recorded with zero charged bytes until a future
-- processing run re-verifies it.
INSERT INTO asset_objects (
    org_id, asset_id, brand_profile_id, kind, r2_key, bytes, reserved_bytes,
    content_type, width, height, duration_sec, status, created_at, updated_at
)
SELECT
    session.org_id, session.asset_id, asset.brand_profile_id, 'staging',
    session.object_key, NULL, session.file_size, session.content_type,
    NULL, NULL, NULL, 'ready', session.created_at, session.updated_at
FROM asset_upload_sessions AS session
JOIN assets AS asset ON asset.id = session.asset_id
WHERE session.status = 'completed'
ON CONFLICT (r2_key) DO NOTHING;

INSERT INTO asset_objects (
    org_id, asset_id, brand_profile_id, kind, r2_key, bytes, content_type,
    width, height, duration_sec, status, created_at, updated_at
)
SELECT
    asset.org_id, asset.id, asset.brand_profile_id, 'original', asset.r2_key,
    asset.file_size, asset.mime_type, asset.width, asset.height,
    asset.duration_sec, 'ready', asset.created_at, asset.updated_at
FROM assets AS asset
WHERE asset.r2_key IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM asset_objects AS object
      WHERE object.asset_id = asset.id
        AND object.kind = 'original'
        AND object.status IN ('writing', 'ready')
  );

INSERT INTO asset_objects (
    org_id, asset_id, brand_profile_id, kind, r2_key, bytes, content_type,
    status, created_at, updated_at
)
SELECT
    asset.org_id, asset.id, asset.brand_profile_id, 'thumbnail', asset.r2_thumbnail,
    0, asset.mime_type, 'ready', asset.created_at, asset.updated_at
FROM assets AS asset
WHERE asset.r2_thumbnail IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM asset_objects AS object
      WHERE object.asset_id = asset.id AND object.kind = 'thumbnail'
  );

INSERT INTO asset_renditions (
    id, org_id, asset_id, brand_profile_id, profile, object_id, status,
    created_at, updated_at
)
SELECT
    object.id, object.org_id, object.asset_id, object.brand_profile_id,
    'original', object.id, 'ready', object.created_at, object.updated_at
FROM asset_objects AS object
WHERE object.kind = 'original' AND object.status = 'ready'
ON CONFLICT (asset_id, profile) DO NOTHING;

-- The legacy key and copy columns are removed only now that every value has
-- been migrated into asset_objects, posts.default_text, or the Asset record.
ALTER TABLE assets DROP COLUMN IF EXISTS text_content;
ALTER TABLE assets DROP COLUMN IF EXISTS description;
ALTER TABLE assets DROP COLUMN IF EXISTS tags;
DROP INDEX IF EXISTS idx_assets_org_tags;
ALTER TABLE assets DROP COLUMN IF EXISTS r2_key;
ALTER TABLE assets DROP COLUMN IF EXISTS r2_thumbnail;

-- Finalization: a completed upload session is the proof of finalization.
UPDATE assets AS asset
SET finalized_at = session.completed_at
FROM asset_upload_sessions AS session
WHERE session.asset_id = asset.id
  AND session.status = 'completed'
  AND asset.finalized_at IS NULL;

-- An Asset that reached a terminal state while holding stored bytes but has
-- no completed session row is treated as finalized when it was created. This
-- covers failed uploads: their bytes are resident, so they must also become
-- reclaimable instead of leaking forever.
UPDATE assets AS asset
SET finalized_at = asset.created_at
WHERE asset.finalized_at IS NULL
  AND asset.status IN ('ready', 'failed', 'deleting', 'deleted')
  AND NOT EXISTS (
      SELECT 1 FROM asset_upload_sessions AS session
      WHERE session.asset_id = asset.id
  );

UPDATE assets AS asset
SET promoted_at = asset.finalized_at
WHERE asset.promoted_at IS NULL
  AND asset.finalized_at IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM asset_objects AS object
      WHERE object.asset_id = asset.id AND object.kind = 'original'
  );
-- Orphan grace: seven elapsed days from finalization for a completed upload
-- that was never attached, and a fresh seven days from detachment once the
-- last retained attachment is removed. Eligibility covers both ready media and
-- finalized failed uploads (an abandoned failed upload must not be exempt),
-- while a failed Asset that is still attached to a retained Post is never
-- swept: its error stays visible to the creator. Attached Assets hold NULL.
UPDATE assets AS asset
SET orphaned_at = COALESCE(asset.finalized_at, asset.created_at),
    orphan_delete_after = COALESCE(asset.finalized_at, asset.created_at)
                          + INTERVAL '7 days'
WHERE asset.status IN ('ready', 'failed')
  AND asset.finalized_at IS NOT NULL
  AND asset.deleted_at IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM post_attachments AS attachment
      WHERE attachment.asset_id = asset.id
  );

ALTER TABLE assets
    ADD CONSTRAINT assets_orphan_deadline_shape_check CHECK (
        (orphaned_at IS NULL AND orphan_delete_after IS NULL)
        OR (orphaned_at IS NOT NULL AND orphan_delete_after IS NOT NULL
            AND orphan_delete_after >= orphaned_at)
    ),
    ADD CONSTRAINT assets_orphan_unfinalized_check CHECK (
        orphaned_at IS NULL
        OR status NOT IN ('pending_upload', 'uploading', 'processing', 'deleting')
    );

CREATE INDEX IF NOT EXISTS idx_assets_orphan_due
    ON assets(orphan_delete_after, id)
    WHERE status IN ('ready', 'failed') AND orphan_delete_after IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_assets_finalized_at
    ON assets(finalized_at, id)
    WHERE finalized_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_assets_brand_profile_status
    ON assets(brand_profile_id, status, id);

-- ---------------------------------------------------------------------------
-- Ownership guards. Attachment creation, processing promotion, and deletion
-- claims serialize on the same Asset row so a reference can never be
-- committed to media already claimed for deletion.
-- ---------------------------------------------------------------------------

-- Seven elapsed days of orphan grace. A new Attachment claims the Asset
-- (clearing any orphan deadline) and detaching the last reference starts a
-- fresh window instead of deleting the bytes immediately.
CREATE OR REPLACE FUNCTION public.post_attachments_maintain_orphan_clock()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
    target assets;
    clock_now timestamptz := now();
BEGIN
    IF TG_OP = 'DELETE' THEN
        SELECT asset.* INTO target FROM assets AS asset WHERE asset.id = OLD.asset_id;
        IF FOUND
           AND target.status = 'ready'
           AND NOT EXISTS (
               SELECT 1 FROM post_attachments AS attachment
               WHERE attachment.asset_id = OLD.asset_id
           )
        THEN
            UPDATE assets
            SET orphaned_at = clock_now,
                orphan_delete_after = clock_now + INTERVAL '7 days',
                updated_at = clock_now
            WHERE id = OLD.asset_id;
        END IF;
        RETURN OLD;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM posts AS post WHERE post.id = NEW.post_id
    ) THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        -- Detaching the last reference starts a fresh grace window for both
        -- completed and failed uploads, so a recently detached older upload
        -- is never deleted immediately.
        SELECT asset.* INTO target FROM assets AS asset WHERE asset.id = OLD.asset_id;
        IF FOUND
           AND target.status IN ('ready', 'failed')
           AND NOT EXISTS (
               SELECT 1 FROM post_attachments AS attachment
               WHERE attachment.asset_id = OLD.asset_id
           )
        THEN
            UPDATE assets
            SET orphaned_at = clock_now,
                orphan_delete_after = clock_now + INTERVAL '7 days',
                updated_at = clock_now
            WHERE id = OLD.asset_id;
        END IF;
        RETURN OLD;
    END IF;

    -- Attach only to media the uploader still owns: a completed upload, an
    -- Asset being processed, an upload still in flight, or a failed Asset the
    -- creator is keeping as an actionable draft attachment. Only media already
    -- claimed for reclamation is rejected; readiness is a publication-time
    -- concern, not a draft-preservation concern.
    SELECT asset.* INTO target
    FROM assets AS asset
    WHERE asset.id = NEW.asset_id
    FOR UPDATE;
    IF NOT FOUND
       OR target.status IN ('deleting', 'deleted')
       OR (
           target.status IN ('pending_upload', 'uploading')
           AND NOT EXISTS (
               SELECT 1 FROM asset_upload_sessions AS session
               WHERE session.asset_id = NEW.asset_id
                 AND session.status IN ('created', 'uploading', 'completing')
                 AND session.expires_at > clock_now
           )
       )
    THEN
        RAISE EXCEPTION 'asset % is not attachable in status %', NEW.asset_id, target.status
            USING ERRCODE = '23514';
    END IF;
    UPDATE assets
    SET orphaned_at = NULL,
        orphan_delete_after = NULL,
        updated_at = clock_now
    WHERE id = NEW.asset_id
      AND (orphaned_at IS NOT NULL OR orphan_delete_after IS NOT NULL);
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER post_attachments_guard_attachable
BEFORE INSERT ON post_attachments
FOR EACH ROW EXECUTE FUNCTION public.post_attachments_maintain_orphan_clock();

CREATE TRIGGER post_attachments_release_orphan_clock
AFTER DELETE ON post_attachments
FOR EACH ROW EXECUTE FUNCTION public.post_attachments_maintain_orphan_clock();

-- Reclamation requires the absence of retained Post references and of live
-- processing, promotion, Provider retrieval, retry, or Reconciliation work.
CREATE OR REPLACE FUNCTION public.assets_guard_delete_claim()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
    IF NEW.status NOT IN ('deleting', 'deleted')
       OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;
    IF EXISTS (
        SELECT 1 FROM post_attachments AS attachment
        WHERE attachment.asset_id = NEW.id
    ) THEN
        RAISE EXCEPTION 'asset % still has retained post attachments', NEW.id
            USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM provider_operation_media AS media
        JOIN provider_operations AS operation ON operation.id = media.operation_id
        WHERE media.asset_id = NEW.id
          AND (
              operation.status IN ('started', 'needs_reconciliation')
              OR (
                  operation.media_hold_until IS NOT NULL
                  AND operation.media_hold_until > now()
              )
          )
    ) THEN
        RAISE EXCEPTION 'asset % is held by an active provider operation', NEW.id
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER assets_guard_delete_claim
BEFORE UPDATE OF status ON assets
FOR EACH ROW EXECUTE FUNCTION public.assets_guard_delete_claim();

-- ---------------------------------------------------------------------------
-- Row-level security for the new tables, matching the baseline convention:
-- members manage composition in their active workspace; storage inventory and
-- attempt media references are system-written and read-only for members.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_rls'
    ) THEN
        RAISE NOTICE 'meltiply_rls role unavailable; skipping RLS setup';
        RETURN;
    END IF;

    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE posts TO meltiply_rls';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE post_attachments TO meltiply_rls';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE post_targets TO meltiply_rls';
    EXECUTE 'GRANT SELECT ON TABLE asset_objects TO meltiply_rls';
    EXECUTE 'GRANT SELECT ON TABLE asset_renditions TO meltiply_rls';
    EXECUTE 'GRANT SELECT ON TABLE provider_operation_media TO meltiply_rls';

    EXECUTE 'ALTER TABLE posts ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE post_attachments ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE post_targets ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE asset_objects ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE asset_renditions ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE provider_operation_media ENABLE ROW LEVEL SECURITY';

    EXECUTE $policy$
        CREATE POLICY "Users can view posts in their active org"
        ON posts FOR SELECT TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
    $policy$;
    EXECUTE $policy$
        CREATE POLICY "Users can insert posts in their active org"
        ON posts FOR INSERT TO meltiply_rls
        WITH CHECK (org_id = (SELECT public.auth_active_org_id()))
    $policy$;
    EXECUTE $policy$
        CREATE POLICY "Users can update posts in their active org"
        ON posts FOR UPDATE TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
        WITH CHECK (org_id = (SELECT public.auth_active_org_id()))
    $policy$;
    EXECUTE $policy$
        CREATE POLICY "Users can delete posts in their active org"
        ON posts FOR DELETE TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
    $policy$;
    EXECUTE $policy$
        CREATE POLICY "Users can view post attachments in their active org"
        ON post_attachments FOR SELECT TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
    $policy$;
    EXECUTE $policy$
        CREATE POLICY "Users can insert post attachments in their active org"
        ON post_attachments FOR INSERT TO meltiply_rls
        WITH CHECK (org_id = (SELECT public.auth_active_org_id()))
    $policy$;
    EXECUTE $policy$
        CREATE POLICY "Users can update post attachments in their active org"
        ON post_attachments FOR UPDATE TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
        WITH CHECK (org_id = (SELECT public.auth_active_org_id()))
    $policy$;
    EXECUTE $policy$
        CREATE POLICY "Users can delete post attachments in their active org"
        ON post_attachments FOR DELETE TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
    $policy$;
    EXECUTE $policy$
        CREATE POLICY "Users can view post targets in their active org"
        ON post_targets FOR SELECT TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
    $policy$;
    EXECUTE $policy$
        CREATE POLICY "Users can insert post targets in their active org"
        ON post_targets FOR INSERT TO meltiply_rls
        WITH CHECK (org_id = (SELECT public.auth_active_org_id()))
    $policy$;
    EXECUTE $policy$
        CREATE POLICY "Users can update post targets in their active org"
        ON post_targets FOR UPDATE TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
        WITH CHECK (org_id = (SELECT public.auth_active_org_id()))
    $policy$;
    EXECUTE $policy$
        CREATE POLICY "Users can delete post targets in their active org"
        ON post_targets FOR DELETE TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
    $policy$;
    EXECUTE $policy$
        CREATE POLICY "Users can view asset objects in their active org"
        ON asset_objects FOR SELECT TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
    $policy$;
    EXECUTE $policy$
        CREATE POLICY "Users can view asset renditions in their active org"
        ON asset_renditions FOR SELECT TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
    $policy$;
    EXECUTE $policy$
        CREATE POLICY "Users can view provider operation media in their active org"
        ON provider_operation_media FOR SELECT TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
    $policy$;
END;
$$;

COMMIT;
