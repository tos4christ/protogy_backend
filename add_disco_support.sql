-- Disco (distribution company) segmentation. Run once:
--   psql -U postgres -h localhost -d protogy -f add_disco_support.sql

ALTER TABLE meters ADD COLUMN IF NOT EXISTS disco TEXT;
CREATE INDEX IF NOT EXISTS ix_meters_disco ON meters (disco);

-- onboard_meter with disco parameter
DROP FUNCTION IF EXISTS onboard_meter(TEXT, TEXT, TEXT, INTEGER, TEXT, JSONB, TEXT);
CREATE OR REPLACE FUNCTION onboard_meter(
    p_meter_id      TEXT,
    p_feeder_name   TEXT,
    p_location      TEXT DEFAULT NULL,
    p_interval_s    INTEGER DEFAULT 15,
    p_onboarded_by  TEXT DEFAULT NULL,
    p_metadata      JSONB DEFAULT '{}'::jsonb,
    p_controller_id TEXT DEFAULT NULL,
    p_disco         TEXT DEFAULT NULL
) RETURNS meters LANGUAGE plpgsql AS $$
DECLARE result meters;
BEGIN
    INSERT INTO meters (meter_id, feeder_name, location, expected_interval_s,
                        onboarded_by, metadata, controller_id, disco, status)
    VALUES (p_meter_id, p_feeder_name, p_location, p_interval_s,
            p_onboarded_by, p_metadata, p_controller_id, p_disco, 'active')
    ON CONFLICT (meter_id) DO UPDATE
        SET feeder_name         = EXCLUDED.feeder_name,
            location            = COALESCE(EXCLUDED.location, meters.location),
            expected_interval_s = EXCLUDED.expected_interval_s,
            onboarded_by        = COALESCE(EXCLUDED.onboarded_by, meters.onboarded_by),
            metadata            = meters.metadata || EXCLUDED.metadata,
            controller_id       = COALESCE(EXCLUDED.controller_id, meters.controller_id),
            disco               = COALESCE(EXCLUDED.disco, meters.disco),
            status              = 'active'
    RETURNING * INTO result;
    RETURN result;
END $$;

-- v_meter_status including disco
DROP VIEW IF EXISTS v_meter_status;
CREATE VIEW v_meter_status AS
SELECT
    m.meter_id,
    m.feeder_name,
    m.disco,
    m.location,
    m.controller_id,
    m.status                        AS onboarding_status,
    lr.meter_ts                     AS last_reading_at,
    lr.received_ts                  AS last_received_at,
    lr.voltage_l1, lr.voltage_l2, lr.voltage_l3,
    lr.current_l1, lr.current_l2, lr.current_l3,
    lr.active_power, lr.reactive_power, lr.apparent_power,
    lr.power_factor, lr.frequency,
    lr.active_energy, lr.reactive_energy, lr.apparent_energy,
    CASE
        WHEN lr.meter_ts IS NULL THEN 'never_reported'
        WHEN now() - lr.received_ts <= (m.expected_interval_s * 3) * INTERVAL '1 second'
             THEN 'online'
        ELSE 'offline'
    END AS connectivity
FROM meters m
LEFT JOIN LATERAL (
    SELECT * FROM readings r
    WHERE r.meter_id = m.meter_id
    ORDER BY r.meter_ts DESC
    LIMIT 1
) lr ON TRUE
WHERE m.status <> 'decommissioned';

GRANT SELECT ON v_meter_status TO protogy_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO protogy_app;
