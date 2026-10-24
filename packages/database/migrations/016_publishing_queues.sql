-- meltiply-release-phase: expand
-- Publishing plans and their reservations are domain state, not transport queues.
CREATE TABLE publishing_queues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    brand_profile_id UUID NOT NULL,
    name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
    timezone TEXT NOT NULL CHECK (length(timezone) BETWEEN 1 AND 100),
    slots JSONB NOT NULL CHECK (jsonb_typeof(slots) = 'array' AND jsonb_array_length(slots) BETWEEN 1 AND 168),
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, org_id, brand_profile_id),
    FOREIGN KEY (brand_profile_id, org_id) REFERENCES brand_profiles(id, org_id) ON DELETE CASCADE
);
CREATE INDEX publishing_queues_profile ON publishing_queues(org_id, brand_profile_id, id) WHERE deleted_at IS NULL;

CREATE TABLE publishing_queue_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    brand_profile_id UUID NOT NULL,
    queue_id UUID NOT NULL,
    post_id UUID NOT NULL,
    queue_name TEXT NOT NULL,
    assigned_at TIMESTAMPTZ NOT NULL,
    released_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (queue_id, org_id, brand_profile_id) REFERENCES publishing_queues(id, org_id, brand_profile_id) ON DELETE CASCADE,
    FOREIGN KEY (post_id, org_id) REFERENCES posts(id, org_id) ON DELETE CASCADE,
    FOREIGN KEY (post_id, brand_profile_id) REFERENCES posts(id, brand_profile_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX publishing_queue_one_membership ON publishing_queue_memberships(post_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX publishing_queue_reserved_slot ON publishing_queue_memberships(queue_id, assigned_at) WHERE released_at IS NULL;
CREATE INDEX publishing_queue_membership_scope ON publishing_queue_memberships(org_id, brand_profile_id, queue_id, post_id) WHERE released_at IS NULL;

ALTER TABLE publishing_queues ENABLE ROW LEVEL SECURITY;
ALTER TABLE publishing_queues FORCE ROW LEVEL SECURITY;
ALTER TABLE publishing_queue_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE publishing_queue_memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY queue_read ON publishing_queues FOR SELECT TO meltiply_rls
    USING (org_id = (SELECT public.auth_active_org_id()));
CREATE POLICY queue_create ON publishing_queues FOR INSERT TO meltiply_rls
    WITH CHECK (org_id = (SELECT public.auth_active_org_id()) AND public.auth_active_org_role() = 'admin');
CREATE POLICY queue_edit ON publishing_queues FOR UPDATE TO meltiply_rls
    USING (org_id = (SELECT public.auth_active_org_id()) AND public.auth_active_org_role() = 'admin')
    WITH CHECK (org_id = (SELECT public.auth_active_org_id()) AND public.auth_active_org_role() = 'admin');
CREATE POLICY queue_membership_read ON publishing_queue_memberships FOR SELECT TO meltiply_rls
    USING (org_id = (SELECT public.auth_active_org_id()));
CREATE POLICY queue_membership_write ON publishing_queue_memberships FOR ALL TO meltiply_rls
    USING (org_id = (SELECT public.auth_active_org_id()) AND public.auth_active_org_role() IN ('admin', 'editor'))
    WITH CHECK (org_id = (SELECT public.auth_active_org_id()) AND public.auth_active_org_role() IN ('admin', 'editor'));
GRANT SELECT, INSERT, UPDATE ON publishing_queues TO meltiply_rls;
GRANT SELECT, INSERT, UPDATE ON publishing_queue_memberships TO meltiply_rls;
GRANT ALL ON publishing_queues, publishing_queue_memberships TO meltiply_system;
