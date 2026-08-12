-- Run once: psql -U postgres -h localhost -d protogy -f add_controller_support.sql
ALTER TABLE meters ADD COLUMN IF NOT EXISTS controller_id TEXT;
CREATE INDEX IF NOT EXISTS ix_meters_controller ON meters (controller_id);

-- Replace onboarding function with controller support
DROP FUNCTION IF EXISTS onboard_meter(TEXT, TEXT, TEXT, INTEGER, TEXT, JSONB);
CREATE OR REPLACE FUNCTION onboard_meter(
    p_meter_id      TEXT,
    p_feeder_name   TEXT,
    p_location      TEXT DEFAULT NULL,
    p_interval_s    INTEGER DEFAULT 15,
    p_onboarded_by  TEXT DEFAULT NULL,
    p_metadata      JSONB DEFAULT '{}'::jsonb,
    p_controller_id TEXT DEFAULT NULL
) RETURNS meters LANGUAGE plpgsql AS $$
DECLARE result meters;
BEGIN
    INSERT INTO meters (meter_id, feeder_name, location, expected_interval_s,
                        onboarded_by, metadata, controller_id, status)
    VALUES (p_meter_id, p_feeder_name, p_location, p_interval_s,
            p_onboarded_by, p_metadata, p_controller_id, 'active')
    ON CONFLICT (meter_id) DO UPDATE
        SET feeder_name         = EXCLUDED.feeder_name,
            location            = COALESCE(EXCLUDED.location, meters.location),
            expected_interval_s = EXCLUDED.expected_interval_s,
            onboarded_by        = COALESCE(EXCLUDED.onboarded_by, meters.onboarded_by),
            metadata            = meters.metadata || EXCLUDED.metadata,
            controller_id       = COALESCE(EXCLUDED.controller_id, meters.controller_id),
            status              = 'active'
    RETURNING * INTO result;
    RETURN result;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO protogy_app;
