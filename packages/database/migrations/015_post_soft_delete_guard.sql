-- meltiply-release-phase: expand

-- Extend the protected-history predicate to every state that represents a
-- provider attempt or retained publication outcome. The previous policy only
-- covered published and awaiting_provider, so an Editor could hard-delete a
-- Post whose Distribution was processing or awaiting reconciliation.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_rls') THEN
        RAISE NOTICE 'meltiply_rls role unavailable; skipping Post delete guard';
        RETURN;
    END IF;

    EXECUTE 'DROP POLICY IF EXISTS "Published Posts require admin deletion" ON posts';
    EXECUTE $policy$
        CREATE POLICY "Published Posts require admin deletion"
        ON posts AS RESTRICTIVE FOR DELETE TO meltiply_rls
        USING (
            public.auth_active_org_role() = 'admin'
            OR NOT EXISTS (
                SELECT 1
                FROM distributions
                WHERE distributions.post_id = posts.id
                  AND distributions.status IN (
                    'processing', 'awaiting_provider', 'published', 'needs_reconciliation'
                  )
            )
        )
    $policy$;

    -- Deletion is a soft delete, so the DELETE policy alone cannot protect
    -- published history. A column-specific trigger rejects only the transition
    -- that sets deleted_at; ordinary Editor edits to other Post columns remain
    -- allowed. System-role updates have no JWT role and are not restricted.
    EXECUTE $fn$
        CREATE OR REPLACE FUNCTION public.reject_protected_post_soft_delete()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $body$
        DECLARE
            active_role text;
        BEGIN
            active_role := public.auth_active_org_role();
            IF active_role IS NULL THEN
                RETURN NEW;
            END IF;
            IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
               AND NEW.deleted_at IS NOT NULL
               AND active_role IS DISTINCT FROM 'admin'
               AND EXISTS (
                   SELECT 1
                   FROM distributions
                   WHERE distributions.post_id = OLD.id
                     AND distributions.status IN (
                       'processing', 'awaiting_provider', 'published', 'needs_reconciliation'
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

    EXECUTE 'GRANT EXECUTE ON FUNCTION public.reject_protected_post_soft_delete() TO meltiply_rls';
    EXECUTE 'DROP TRIGGER IF EXISTS posts_reject_protected_soft_delete ON posts';
    EXECUTE 'CREATE TRIGGER posts_reject_protected_soft_delete
             BEFORE UPDATE OF deleted_at ON posts
             FOR EACH ROW
             EXECUTE FUNCTION public.reject_protected_post_soft_delete()';
END;
$$;
