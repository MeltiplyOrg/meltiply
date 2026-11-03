-- meltiply-release-phase: expand

-- Publishing methods carry link carousels and long-form text, not just small
-- audience toggles. Keep a bounded object while allowing the validated options
-- accepted by the public Post and Distribution contracts to round-trip.
ALTER TABLE post_targets DROP CONSTRAINT post_targets_provider_options_check;
ALTER TABLE post_targets ADD CONSTRAINT post_targets_provider_options_check
    CHECK (jsonb_typeof(provider_options) = 'object'
           AND octet_length(provider_options::text) <= 131072);

ALTER TABLE distributions DROP CONSTRAINT distributions_provider_options_check;
ALTER TABLE distributions ADD CONSTRAINT distributions_provider_options_check
    CHECK (jsonb_typeof(provider_options) = 'object'
           AND octet_length(provider_options::text) <= 131072);

-- Partial secondary delivery must never erase success on the primary Provider.
ALTER TABLE distributions ADD COLUMN provider_warnings jsonb NOT NULL DEFAULT '[]'
    CHECK (provider_warnings IN ('[]'::jsonb, '["instagram_crossshare_failed"]'::jsonb));

-- A native draft/inbox/experiment handoff is terminal but is not Published.
ALTER TABLE distributions DROP CONSTRAINT distributions_status_check;
ALTER TABLE distributions ADD CONSTRAINT distributions_status_check
    CHECK (status IN (
        'scheduled', 'queued', 'processing', 'awaiting_provider', 'delivered',
        'published', 'failed', 'cancel_requested', 'cancelled', 'needs_reconciliation'
    ));

-- Delivered content is already Provider-owned and may be published natively.
-- Protect that remote history through both hard and soft Post deletion.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_rls') THEN
        RETURN;
    END IF;
    EXECUTE 'DROP POLICY IF EXISTS "Published Posts require admin deletion" ON posts';
    EXECUTE $policy$
        CREATE POLICY "Published Posts require admin deletion"
        ON posts AS RESTRICTIVE FOR DELETE TO meltiply_rls
        USING (
            public.auth_active_org_role() = 'admin'
            OR NOT EXISTS (
                SELECT 1 FROM distributions
                WHERE distributions.post_id = posts.id
                  AND distributions.status IN (
                    'processing', 'awaiting_provider', 'delivered', 'published', 'needs_reconciliation'
                  )
            )
        )
    $policy$;
    EXECUTE $fn$
        CREATE OR REPLACE FUNCTION public.reject_protected_post_soft_delete()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $body$
        DECLARE active_role text;
        BEGIN
            active_role := public.auth_active_org_role();
            IF active_role IS NOT NULL
               AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
               AND NEW.deleted_at IS NOT NULL
               AND active_role IS DISTINCT FROM 'admin'
               AND EXISTS (
                   SELECT 1 FROM distributions
                   WHERE distributions.post_id = OLD.id
                     AND distributions.status IN (
                       'processing', 'awaiting_provider', 'delivered', 'published', 'needs_reconciliation'
                     )
               )
            THEN
                RAISE EXCEPTION
                    'Only a workspace admin can delete a post with published distributions'
                    USING ERRCODE = '42501';
            END IF;
            RETURN NEW;
        END;
        $body$
    $fn$;
END;
$$;
