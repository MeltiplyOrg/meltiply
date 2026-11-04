-- meltiply-release-phase: expand
-- Notification email is no longer locked to the Installation Owner. Each saved
-- row now names an explicit recipient array, so the owner can send alerts to a
-- team inbox or several operators without sharing a password.
--
-- Convert the previous boolean shape in place. An enabled channel keeps its
-- behavior by resolving the current Installation Owner address once; a disabled
-- channel keeps an empty recipient list. The API writes the object shape from
-- this release onward.
UPDATE publishing_preferences
SET notification_preferences = jsonb_set(
    notification_preferences,
    '{channels,email}',
    jsonb_build_object(
        'enabled',
        (notification_preferences #>> '{channels,email}')::boolean
        AND EXISTS (
            SELECT 1 FROM users
            WHERE installation_owner = true AND suspended_at IS NULL
        ),
        'recipients',
        COALESCE(
            (
                SELECT jsonb_agg(owner.email ORDER BY owner.created_at, owner.id)
                FROM users AS owner
                WHERE owner.installation_owner = true AND owner.suspended_at IS NULL
            ),
            '[]'::jsonb
        )
    )
)
WHERE jsonb_typeof(notification_preferences #> '{channels,email}') = 'boolean';

ALTER TABLE publishing_preferences
    ALTER COLUMN notification_preferences SET DEFAULT '{
        "events": {"publication_failed": false, "channel_disconnected": false},
        "channels": {"email": {"enabled": false, "recipients": []}}
    }'::jsonb;

-- A bounded recipient list is larger than the previous single boolean. Keep the
-- document guard, but allow twenty addresses within the same JSON object.
ALTER TABLE publishing_preferences
    DROP CONSTRAINT IF EXISTS publishing_preferences_notifications_check;
ALTER TABLE publishing_preferences
    ADD CONSTRAINT publishing_preferences_notifications_check CHECK (
        jsonb_typeof(notification_preferences) = 'object'
        AND octet_length(notification_preferences::text) <= 16384
    );
