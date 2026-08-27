-- NERC Review II, item vii: capture the feeder's tariff band (A-E) at
-- onboarding and surface it at feeder level everywhere a feeder is shown.
-- Run once: psql -U postgres -h localhost -d protogy -f add_tariff_band_support.sql

-- 1. Column on meters
ALTER TABLE meters ADD COLUMN IF NOT EXISTS tariff_band TEXT
      CHECK (tariff_band IN ('A','B','C','D','E'));

-- 2. onboard_meter: add p_tariff_band as a new, final parameter so existing
--    callers with fewer args still work against the old signature until the
--    app is redeployed; the app itself now always passes all 17.
DROP FUNCTION IF EXISTS onboard_meter(TEXT,TEXT,TEXT,INTEGER,TEXT,JSONB,TEXT,TEXT,DOUBLE PRECISION,DOUBLE PRECISION,TEXT,TEXT,TEXT,TEXT,TEXT,NUMERIC);
CREATE OR REPLACE FUNCTION onboard_meter(
    p_meter_id        TEXT,
    p_feeder_name     TEXT,
    p_location        TEXT     DEFAULT NULL,
    p_interval_s      INTEGER  DEFAULT 15,
    p_onboarded_by    TEXT     DEFAULT NULL,
    p_metadata        JSONB    DEFAULT '{}'::jsonb,
    p_controller_id   TEXT     DEFAULT NULL,
    p_disco           TEXT     DEFAULT NULL,
    p_latitude        DOUBLE PRECISION DEFAULT NULL,
    p_longitude       DOUBLE PRECISION DEFAULT NULL,
    p_station         TEXT     DEFAULT NULL,
    p_mother_feeder   TEXT     DEFAULT NULL,
    p_category        TEXT     DEFAULT NULL,
    p_state           TEXT     DEFAULT NULL,
    p_voltage_class   TEXT     DEFAULT NULL,
    p_nominal_voltage NUMERIC  DEFAULT NULL,
    p_tariff_band     TEXT     DEFAULT NULL
) RETURNS meters LANGUAGE plpgsql AS $$
DECLARE result meters;
BEGIN
    INSERT INTO meters (meter_id, feeder_name, location, expected_interval_s,
                        onboarded_by, metadata, controller_id, disco,
                        latitude, longitude, station, mother_feeder, category,
                        state, voltage_class, nominal_voltage, tariff_band, status)
    VALUES (p_meter_id, p_feeder_name, p_location, p_interval_s, p_onboarded_by,
            p_metadata, p_controller_id, p_disco, p_latitude, p_longitude,
            p_station, p_mother_feeder, p_category, p_state, p_voltage_class,
            p_nominal_voltage, p_tariff_band, 'active')
    ON CONFLICT (meter_id) DO UPDATE SET
        feeder_name         = EXCLUDED.feeder_name,
        location            = COALESCE(EXCLUDED.location, meters.location),
        expected_interval_s = EXCLUDED.expected_interval_s,
        onboarded_by        = COALESCE(EXCLUDED.onboarded_by, meters.onboarded_by),
        metadata            = meters.metadata || EXCLUDED.metadata,
        controller_id       = COALESCE(EXCLUDED.controller_id, meters.controller_id),
        disco               = COALESCE(EXCLUDED.disco, meters.disco),
        latitude            = COALESCE(EXCLUDED.latitude, meters.latitude),
        longitude           = COALESCE(EXCLUDED.longitude, meters.longitude),
        station             = COALESCE(EXCLUDED.station, meters.station),
        mother_feeder       = COALESCE(EXCLUDED.mother_feeder, meters.mother_feeder),
        category            = COALESCE(EXCLUDED.category, meters.category),
        state               = COALESCE(EXCLUDED.state, meters.state),
        voltage_class       = COALESCE(EXCLUDED.voltage_class, meters.voltage_class),
        nominal_voltage     = COALESCE(EXCLUDED.nominal_voltage, meters.nominal_voltage),
        tariff_band         = COALESCE(EXCLUDED.tariff_band, meters.tariff_band),
        status              = 'active'
    RETURNING * INTO result;
    RETURN result;
END $$;

-- 3. v_meter_status: add tariff_band so it flows through to every endpoint
--    that already does SELECT * FROM v_meter_status (status board, meter
--    explorer, NERC compliance/reports) with no other code changes needed.
DROP VIEW IF EXISTS v_meter_status;
CREATE VIEW v_meter_status AS
SELECT
    m.meter_id, m.feeder_name, m.disco, m.location, m.controller_id,
    m.latitude, m.longitude, m.station, m.mother_feeder, m.category,
    m.state, m.voltage_class, m.nominal_voltage, m.tariff_band,
    m.power_unit, m.energy_unit, m.expected_interval_s,
    m.status AS onboarding_status,
    lr.meter_ts AS last_reading_at, lr.received_ts AS last_received_at,
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
    SELECT * FROM readings r WHERE r.meter_id = m.meter_id
    ORDER BY r.meter_ts DESC LIMIT 1
) lr ON TRUE
WHERE m.status <> 'decommissioned';
GRANT SELECT ON v_meter_status TO protogy_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO protogy_app;
