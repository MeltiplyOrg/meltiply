-- meltiply-release-phase: expand
-- Owner-scoped publishing preferences, reusable signatures, frozen target
-- signatures, and durable notification delivery evidence.
--
-- The single-user installation shares one Workspace, so preferences live on
-- the Workspace rather than on an individual member. Timezone is nullable:
-- an untouched installation keeps the browser timezone. Signature templates
-- are ordered JSON records so a replacement save can create, edit, reorder,
-- delete, and select a default atomically.
CREATE TABLE IF NOT EXISTS publishing_preferences (
    org_id                  UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    timezone                TEXT,
    signature_templates     JSONB NOT NULL DEFAULT '[]'::jsonb,
    notification_preferences JSONB NOT NULL DEFAULT '{
        "events": {"publication_failed": false, "channel_disconnected": false},
        "channels": {"email": false}
    }'::jsonb,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT publishing_preferences_timezone_check
        CHECK (timezone IS NULL OR length(timezone) BETWEEN 1 AND 100),
    CONSTRAINT publishing_preferences_signatures_check CHECK (
        jsonb_typeof(signature_templates) = 'array'
        AND jsonb_array_length(signature_templates) <= 10
        AND octet_length(signature_templates::text) <= 65536
    ),
    CONSTRAINT publishing_preferences_notifications_check CHECK (
        jsonb_typeof(notification_preferences) = 'object'
        AND octet_length(notification_preferences::text) <= 4096
    )
);

-- A saved Post snapshots the signature it will append. Later template edits
-- therefore never rewrite an existing draft, queued, or published Post.
ALTER TABLE post_targets
    ADD COLUMN IF NOT EXISTS signature_text TEXT;
ALTER TABLE distributions
    ADD COLUMN IF NOT EXISTS signature_text TEXT;

ALTER TABLE post_targets
    ADD CONSTRAINT post_targets_signature_text_check
    CHECK (signature_text IS NULL OR length(signature_text) <= 1000);
ALTER TABLE distributions
    ADD CONSTRAINT distributions_signature_text_check
    CHECK (signature_text IS NULL OR length(signature_text) <= 1000);

-- Durable per-attempt delivery evidence for owner notifications. The outbox
-- carries the retry/lease/DLQ lifecycle; this row makes a redelivered message
-- idempotent and records whether the latest attempt skipped, delivered, or
-- failed. A recipient address is never stored here because the Worker resolves
-- the current Installation Owner at send time.
CREATE TABLE IF NOT EXISTS notification_deliveries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    dedupe_key      TEXT NOT NULL,
    kind            TEXT NOT NULL,
    aggregate_type  TEXT NOT NULL,
    aggregate_id    UUID NOT NULL,
    channel         TEXT NOT NULL DEFAULT 'email',
    state           TEXT NOT NULL DEFAULT 'pending',
    attempt_count   INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ,
    last_error      TEXT,
    delivered_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, dedupe_key),
    CONSTRAINT notification_deliveries_kind_check
        CHECK (kind IN ('publication_failed', 'channel_disconnected')),
    CONSTRAINT notification_deliveries_channel_check CHECK (channel IN ('email')),
    CONSTRAINT notification_deliveries_state_check
        CHECK (state IN ('pending', 'sending', 'delivered', 'skipped', 'failed', 'dead')),
    CONSTRAINT notification_deliveries_attempt_count_check CHECK (attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_due
    ON notification_deliveries(state, next_attempt_at, created_at)
    WHERE state IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_org
    ON notification_deliveries(org_id, created_at DESC);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_rls'
    ) THEN
        RAISE NOTICE 'meltiply_rls role unavailable; skipping preferences RLS setup';
        RETURN;
    END IF;

    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE publishing_preferences TO meltiply_rls';
    EXECUTE 'GRANT SELECT ON TABLE notification_deliveries TO meltiply_rls';
    EXECUTE 'ALTER TABLE publishing_preferences ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE publishing_preferences FORCE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE notification_deliveries FORCE ROW LEVEL SECURITY';

    -- Owners are the Installation Owner, and every owner holds the Admin role.
    -- Reading is open to every member so the composer can render the applied
    -- timezone and signature consistently; only admins may persist preferences.
    EXECUTE $policy$
        CREATE POLICY preferences_read
        ON publishing_preferences FOR SELECT TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
    $policy$;
    EXECUTE $policy$
        CREATE POLICY preferences_upsert
        ON publishing_preferences FOR INSERT TO meltiply_rls
        WITH CHECK (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() = 'admin'
        )
    $policy$;
    EXECUTE $policy$
        CREATE POLICY preferences_update
        ON publishing_preferences FOR UPDATE TO meltiply_rls
        USING (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() = 'admin'
        )
        WITH CHECK (
            org_id = (SELECT public.auth_active_org_id())
            AND public.auth_active_org_role() = 'admin'
        )
    $policy$;

    -- Delivery evidence is system-written and member-readable for support.
    EXECUTE $policy$
        CREATE POLICY notification_deliveries_read
        ON notification_deliveries FOR SELECT TO meltiply_rls
        USING (org_id = (SELECT public.auth_active_org_id()))
    $policy$;
END;
$$;

GRANT ALL ON publishing_preferences, notification_deliveries TO meltiply_system;

-- ---------------------------------------------------------------------------
-- Durable notification triggers. Writing the outbox row in the same
-- transaction as the domain transition means a lost Queue send never loses the
-- alert: the existing outbox relay retries it, and the consumer records its own
-- idempotent delivery evidence before submitting mail.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enqueue_publication_failure_notification()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
    IF NEW.status = 'failed'
       AND NEW.failure_retryable IS FALSE
       AND (OLD.status IS DISTINCT FROM NEW.status OR OLD.failure_code IS DISTINCT FROM NEW.failure_code)
    THEN
        INSERT INTO outbox_events
            (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
        VALUES (
            NEW.org_id,
            'notification.delivery.requested',
            'distribution',
            NEW.id,
            'publication_failed:' || NEW.id::text || ':' || COALESCE(NEW.failure_code, 'unknown') || ':' || NEW.attempt_count::text,
            jsonb_build_object(
                'version', 1,
                'kind', 'publication_failed',
                'delivery_key', 'publication_failed:' || NEW.id::text || ':' || COALESCE(NEW.failure_code, 'unknown') || ':' || NEW.attempt_count::text,
                'aggregate_id', NEW.id,
                'distribution_id', NEW.id,
                'post_id', NEW.post_id,
                'platform', NEW.platform
            )
        )
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS distributions_enqueue_failure_notification ON distributions;
CREATE TRIGGER distributions_enqueue_failure_notification
AFTER UPDATE OF status ON distributions
FOR EACH ROW EXECUTE FUNCTION public.enqueue_publication_failure_notification();

CREATE OR REPLACE FUNCTION public.enqueue_channel_disconnect_notification()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
    delivery_key TEXT;
    account_status TEXT;
    account_name TEXT;
BEGIN
    -- A direct channel disconnect is the creator action worth alerting. Cascaded
    -- deletes (Workspace or Brand Profile removal) run inside another trigger
    -- and must not enqueue alerts while their owner is disappearing.
    IF pg_trigger_depth() > 1 THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = OLD.org_id) THEN
            RETURN OLD;
        END IF;
    ELSE
        IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = NEW.org_id) THEN
            RETURN NEW;
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN
        delivery_key := 'channel_disconnected:' || OLD.id::text || ':deleted';
        account_status := 'revoked';
        account_name := OLD.display_name;
        INSERT INTO outbox_events
            (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
        VALUES (
            OLD.org_id,
            'notification.delivery.requested',
            'platform_account',
            OLD.id,
            delivery_key,
            jsonb_build_object(
                'version', 1,
                'kind', 'channel_disconnected',
                'delivery_key', delivery_key,
                'aggregate_id', OLD.id,
                'platform', OLD.platform,
                'brand_profile_id', OLD.brand_profile_id,
                'channel_name', account_name,
                'connection_status', account_status
            )
        )
        ON CONFLICT DO NOTHING;
        RETURN OLD;
    END IF;

    IF NEW.connection_status IN ('expired', 'reconnect_required')
       AND OLD.connection_status IS DISTINCT FROM NEW.connection_status
    THEN
        account_name := NEW.display_name;
        delivery_key := 'channel_disconnected:' || NEW.id::text || ':' || NEW.connection_status || ':' || extract(epoch FROM COALESCE(NEW.reconnect_notified_at, NEW.updated_at))::text;
        INSERT INTO outbox_events
            (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
        VALUES (
            NEW.org_id,
            'notification.delivery.requested',
            'platform_account',
            NEW.id,
            delivery_key,
            jsonb_build_object(
                'version', 1,
                'kind', 'channel_disconnected',
                'delivery_key', delivery_key,
                'aggregate_id', NEW.id,
                'platform', NEW.platform,
                'brand_profile_id', NEW.brand_profile_id,
                'channel_name', account_name,
                'connection_status', NEW.connection_status
            )
        )
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS platform_accounts_enqueue_disconnect_notification ON platform_accounts;
CREATE TRIGGER platform_accounts_enqueue_disconnect_notification
AFTER UPDATE OF connection_status ON platform_accounts
FOR EACH ROW EXECUTE FUNCTION public.enqueue_channel_disconnect_notification();

DROP TRIGGER IF EXISTS platform_accounts_deleted_disconnect_notification ON platform_accounts;
CREATE TRIGGER platform_accounts_deleted_disconnect_notification
AFTER DELETE ON platform_accounts
FOR EACH ROW EXECUTE FUNCTION public.enqueue_channel_disconnect_notification();
