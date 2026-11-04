-- meltiply-release-phase: expand
-- Channel lists read the handle without detoasting provider metadata.
ALTER TABLE platform_accounts ADD COLUMN username TEXT;

UPDATE platform_accounts
SET username = metadata->>'username',
    metadata = metadata - 'username'
WHERE metadata ? 'username';
