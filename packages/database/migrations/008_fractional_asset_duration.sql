-- Native decoding reports duration in fractional seconds (for example 2.4).
-- Keep the Asset summary as precise as asset_objects and the API's number
-- contract; integer storage rejects otherwise valid no-benefit and optimized
-- videos when processing commits their decoded facts.
ALTER TABLE assets
    ALTER COLUMN duration_sec TYPE NUMERIC USING duration_sec::numeric;
