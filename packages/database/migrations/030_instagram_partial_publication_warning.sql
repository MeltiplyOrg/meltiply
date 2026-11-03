-- meltiply-release-phase: expand

-- A partial Instagram publication is already live. Retain a bounded, sanitized
-- warning alongside success rather than treating missing content as retryable.
ALTER TABLE distributions DROP CONSTRAINT distributions_provider_warnings_check;
ALTER TABLE distributions ADD CONSTRAINT distributions_provider_warnings_check
    CHECK (provider_warnings IN (
        '[]'::jsonb,
        '["instagram_crossshare_failed"]'::jsonb,
        '["instagram_publish_partial"]'::jsonb
    ));
