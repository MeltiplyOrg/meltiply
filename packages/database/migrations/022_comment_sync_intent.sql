-- meltiply-release-phase: expand
-- A deployment may stop recurring Comment collection without dropping an
-- authorized Inbox fetch, its cursor continuation, or transport-recovery retry.
-- Intent belongs to the durable claim, not a redeliverable Queue body.
ALTER TABLE distributions
  ADD COLUMN comments_sync_on_demand BOOLEAN NOT NULL DEFAULT false;
