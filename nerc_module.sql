-- ============================================================================
-- NERC MODULE + ONBOARDING FIX  — run once:
--   psql -U postgres -h localhost -d protogy -f nerc_module.sql
-- Fixes the "function onboard_meter(...) unknown" error by dropping ALL old
-- signatures and creating one canonical function (now including coordinates),
-- adds NERC report fields, a settings table, and the NERC uptime aggregate.
-- ============================================================================

-- 1. Meter fields needed by NERC reports
ALTER TABLE meters ADD COLUMN IF NOT EXISTS station         TEXT;
ALTER TABLE meters ADD COLUMN IF NOT EXISTS mother_feeder   TEXT;
ALTER TABLE meters ADD COLUMN IF NOT EXISTS category        TEXT;   -- Commercial/Industrial/Residential
ALTER TABLE meters ADD COLUMN IF NOT EXISTS state           TEXT;
ALTER TABLE meters ADD COLUMN IF NOT EXISTS voltage_class   TEXT;   -- e.g. '11Kv Feeder', '33Kv Feeder'
ALTER TABLE meters ADD COLUMN IF NOT EXISTS nominal_voltage NUMERIC;-- in the meter's own units
ALTER TABLE meters ADD COLUMN IF NOT EXISTS power_unit      TEXT NOT NULL DEFAULT 'kW'
      CHECK (power_unit IN ('W','kW'));
ALTER TABLE meters ADD COLUMN IF NOT EXISTS energy_unit     TEXT NOT NULL DEFAULT 'kWh'
      CHECK (energy_unit IN ('Wh','kWh'));

-- 2. Platform settings (editable from the new Settings tab)
CREATE TABLE IF NOT EXISTS app_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    description TEXT
);
INSERT INTO app_settings (key, value, description) VALUES
 ('dar_compliance_pct',      '95',  'DAR %% at/above which a feeder day is COMPLIANT'),
 ('compliance_met_pct',      '95',  'Compliance %% (current uptime/24h) at/above which status is Met'),
 ('voltage_tolerance_pct',   '10',  'Voltage compliant when within ± this %% of the meter''s nominal voltage'),
 ('current_flow_threshold',  '0.5', 'Amps above which current is considered flowing'),
 ('voltage_present_threshold','50', 'Volts above which voltage is considered present')
ON CONFLICT (key) DO NOTHING;
GRANT SELECT, UPDATE, INSERT ON app_settings TO protogy_app;

-- 3. THE ONBOARDING FIX: drop every historical signature, create the one true function
DROP FUNCTION IF EXISTS onboard_meter(TEXT,TEXT,TEXT,INTEGER,TEXT,JSONB);
DROP FUNCTION IF EXISTS onboard_meter(TEXT,TEXT,TEXT,INTEGER,TEXT,JSONB,TEXT);
DROP FUNCTION IF EXISTS onboard_meter(TEXT,TEXT,TEXT,INTEGER,TEXT,JSONB,TEXT,TEXT);
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
    p_nominal_voltage NUMERIC  DEFAULT NULL
) RETURNS meters LANGUAGE plpgsql AS $$
DECLARE result meters;
BEGIN
    INSERT INTO meters (meter_id, feeder_name, location, expected_interval_s,
                        onboarded_by, metadata, controller_id, disco,
                        latitude, longitude, station, mother_feeder, category,
                        state, voltage_class, nominal_voltage, status)
    VALUES (p_meter_id, p_feeder_name, p_location, p_interval_s, p_onboarded_by,
            p_metadata, p_controller_id, p_disco, p_latitude, p_longitude,
            p_station, p_mother_feeder, p_category, p_state, p_voltage_class,
            p_nominal_voltage, 'active')
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
        status              = 'active'
    RETURNING * INTO result;
    RETURN result;
END $$;

-- 4. Status view incl. all NERC + map fields (drop/create: columns reordered)
DROP VIEW IF EXISTS v_meter_status;
CREATE VIEW v_meter_status AS
SELECT
    m.meter_id, m.feeder_name, m.disco, m.location, m.controller_id,
    m.latitude, m.longitude, m.station, m.mother_feeder, m.category,
    m.state, m.voltage_class, m.nominal_voltage, m.power_unit, m.energy_unit,
    m.expected_interval_s,
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

-- 5. NERC uptime/consumption aggregate (current-on & voltage-on time, energy)
CREATE MATERIALIZED VIEW IF NOT EXISTS agg_nerc_15min
WITH (timescaledb.continuous) AS
SELECT meter_id,
       time_bucket('15 minutes', meter_ts) AS bucket,
       count(*)                                                            AS total_count,
       count(*) FILTER (WHERE GREATEST(current_l1,current_l2,current_l3) > 0.5)  AS current_on_count,
       count(*) FILTER (WHERE GREATEST(voltage_l1,voltage_l2,voltage_l3) > 50)   AS voltage_on_count,
       max(active_energy) AS energy_max,
       min(active_energy) AS energy_min
FROM readings
GROUP BY meter_id, bucket
WITH NO DATA;
SELECT add_continuous_aggregate_policy('agg_nerc_15min',
    start_offset => INTERVAL '3 days', end_offset => INTERVAL '15 minutes',
    schedule_interval => INTERVAL '5 minutes', if_not_exists => TRUE);
ALTER MATERIALIZED VIEW agg_nerc_15min SET (timescaledb.materialized_only = false);
CALL refresh_continuous_aggregate('agg_nerc_15min', NULL, NULL);
GRANT SELECT ON agg_nerc_15min TO protogy_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO protogy_app;
