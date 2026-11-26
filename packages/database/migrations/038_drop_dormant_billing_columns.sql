-- meltiply-release-phase: expand
-- Retires dormant billing columns and constraints on organizations that no application code reads or writes.

DROP INDEX IF EXISTS idx_organizations_billing_customer_id;

ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_billing_status_check,
  DROP CONSTRAINT IF EXISTS organizations_billing_customer_id_check,
  DROP COLUMN IF EXISTS plan,
  DROP COLUMN IF EXISTS billing_status,
  DROP COLUMN IF EXISTS billing_customer_id,
  DROP COLUMN IF EXISTS renews_at,
  DROP COLUMN IF EXISTS cancel_at,
  DROP COLUMN IF EXISTS billing_event_at;
