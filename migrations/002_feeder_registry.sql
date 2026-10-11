-- 002_feeder_registry.sql
-- NERC feeder-type taxonomy + the national feeder reference registry
-- (per the Commission's letter on resolving feeder-availability-evaluation
-- discrepancies: 5 feeder types, each with a prescribed availability
-- measurement method — see src/feederType.js for the full rule).
--
-- Safe to run multiple times (IF NOT EXISTS / idempotent).
--   psql -h <host> -U <user> -d protogy -f migrations/002_feeder_registry.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. New metadata columns on the live `meters` table.
--    feeder_type drives WHICH metric (current/load vs voltage) availability
--    is computed with — see feederType.js's availabilityMetricFor(). NULL
--    (not yet classified) falls back to the current/load-based calculation,
--    i.e. today's existing behavior — nothing changes for an unclassified
--    feeder until someone sets its type.
--    regulator is the feeder's actual state electricity regulatory
--    commission (LASERC, KERC, ANERC, ... or plain NERC, or a dual
--    "LASERC/NERC") — distinct from the `state` column, which is just the
--    state name. Reference metadata for now; does not change RBAC scoping
--    (scope.js still scopes state_nerc by `state`).
-- ---------------------------------------------------------------------------
ALTER TABLE meters ADD COLUMN IF NOT EXISTS feeder_type TEXT;
ALTER TABLE meters ADD COLUMN IF NOT EXISTS regulator   TEXT;

-- ---------------------------------------------------------------------------
-- 2. Feeder registry — the NESI-wide reference list from the Commission
--    (currently ~3,249 feeders across all 11 DisCos), kept SEPARATE from
--    `meters`: almost all of these feeders have no Protogy telemetry
--    installed, so they are reference/lookup data, never live meters.
--    Purpose: onboarding autofill (match a newly onboarded meter's feeder
--    name + disco against this table to pull Band/State/Regulator/
--    Voltage/FeederType instead of typing it blind) and validation.
--    The Commission has said an updated version mapping each feeder to its
--    substation is coming — this table is re-importable (upsert on
--    disco+feeder), so that update is a re-run of the same import script,
--    not a rebuild.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feeder_registry (
    id                   BIGSERIAL PRIMARY KEY,
    disco                TEXT NOT NULL,
    feeder                TEXT NOT NULL,
    band                 TEXT,
    location             TEXT,
    major_streets        TEXT,
    state                TEXT,
    regulator            TEXT,
    voltage_level        TEXT,
    unmetered_customers  INTEGER,
    metered_customers    INTEGER,
    feeder_type          TEXT,       -- normalized (Public/Commercial/Dedicated/Virtual/Express, or a "A/B" combo)
    substation           TEXT,       -- NULL until the Commission's substation-mapped update arrives
    imported_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (disco, feeder)
);

CREATE INDEX IF NOT EXISTS idx_feeder_registry_disco   ON feeder_registry (disco);
CREATE INDEX IF NOT EXISTS idx_feeder_registry_feeder  ON feeder_registry (feeder);

-- ---------------------------------------------------------------------------
-- 3. onboard_meter: add p_feeder_type and p_regulator as two new, final
--    parameters, following the exact pattern used when tariff_band was
--    added (add_tariff_band_support.sql) — old positional callers keep
--    working via the DEFAULT NULL until the app is redeployed; the app
--    itself now always passes all 19.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS onboard_meter(TEXT,TEXT,TEXT,INTEGER,TEXT,JSONB,TEXT,TEXT,DOUBLE PRECISION,DOUBLE PRECISION,TEXT,TEXT,TEXT,TEXT,TEXT,NUMERIC,TEXT);
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
    p_longitude        DOUBLE PRECISION DEFAULT NULL,
    p_station         TEXT     DEFAULT NULL,
    p_mother_feeder   TEXT     DEFAULT NULL,
    p_category        TEXT     DEFAULT NULL,
    p_state           TEXT     DEFAULT NULL,
    p_voltage_class   TEXT     DEFAULT NULL,
    p_nominal_voltage NUMERIC  DEFAULT NULL,
    p_tariff_band     TEXT     DEFAULT NULL,
    p_feeder_type     TEXT     DEFAULT NULL,
    p_regulator       TEXT     DEFAULT NULL
) RETURNS meters LANGUAGE plpgsql AS $$
DECLARE result meters;
BEGIN
    INSERT INTO meters (meter_id, feeder_name, location, expected_interval_s,
                        onboarded_by, metadata, controller_id, disco,
                        latitude, longitude, station, mother_feeder, category,
                        state, voltage_class, nominal_voltage, tariff_band,
                        feeder_type, regulator, status)
    VALUES (p_meter_id, p_feeder_name, p_location, p_interval_s, p_onboarded_by,
            p_metadata, p_controller_id, p_disco, p_latitude, p_longitude,
            p_station, p_mother_feeder, p_category, p_state, p_voltage_class,
            p_nominal_voltage, p_tariff_band, p_feeder_type, p_regulator, 'active')
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
        feeder_type         = COALESCE(EXCLUDED.feeder_type, meters.feeder_type),
        regulator           = COALESCE(EXCLUDED.regulator, meters.regulator),
        status              = 'active'
    RETURNING * INTO result;
    RETURN result;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO protogy_app;

-- ---------------------------------------------------------------------------
-- 4. Expose the two new meters columns on v_meter_status (used by every NERC
--    report/dashboard query) — same definition as nerc_module.sql's version,
--    with m.feeder_type / m.regulator added alongside m.category. Plain view,
--    no downstream migration needed for dependents.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_meter_status;
CREATE VIEW v_meter_status AS
SELECT
    m.meter_id, m.feeder_name, m.disco, m.location, m.controller_id,
    m.latitude, m.longitude, m.station, m.mother_feeder, m.category,
    m.feeder_type, m.regulator,
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

COMMIT;

-- ---------------------------------------------------------------------------
-- Verify after running:
--   SELECT count(*) FROM feeder_registry;
--   SELECT feeder_type, count(*) FROM feeder_registry GROUP BY feeder_type ORDER BY 2 DESC;
--   \d meters   -- confirm feeder_type / regulator columns present
-- ---------------------------------------------------------------------------
