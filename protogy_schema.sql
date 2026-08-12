-- ============================================================================
-- PROTOGY IoT PLATFORM - DATABASE SCHEMA
-- PostgreSQL 17 + TimescaleDB 2.28
-- Run with:
--   psql -U postgres -h localhost -d protogy -f protogy_schema.sql
-- (database must exist:  CREATE DATABASE protogy;  and extension enabled below)
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ============================================================================
-- 1. METERS REGISTRY  (onboarding happens here)
--    Frontend onboarding = INSERT INTO meters (...)
-- ============================================================================
CREATE TABLE IF NOT EXISTS meters (
    meter_id            TEXT PRIMARY KEY,          -- must equal cert CN / MQTT client id
    feeder_name         TEXT,
    business_unit       TEXT,
    location            TEXT,
    latitude            DOUBLE PRECISION,
    longitude           DOUBLE PRECISION,
    expected_interval_s INTEGER NOT NULL DEFAULT 15,   -- reporting interval in seconds
    status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','inactive','decommissioned','auto_registered')),
    onboarded_by        TEXT,
    onboarded_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    cert_serial         TEXT,                      -- TLS cert serial for revocation tracking
    cert_expires_at     TIMESTAMPTZ,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ============================================================================
-- 2. READINGS HYPERTABLE  (your payload schema)
--    meter_ts    = timestamp measured by the device (from payload)
--    received_ts = when the server received it (set by ingestion service)
--    UNIQUE(meter_id, meter_ts) makes buffered resends idempotent
-- ============================================================================
CREATE TABLE IF NOT EXISTS readings (
    meter_id        TEXT             NOT NULL,
    meter_ts        TIMESTAMPTZ      NOT NULL,
    received_ts     TIMESTAMPTZ      NOT NULL DEFAULT now(),
    voltage_l1      REAL,
    voltage_l2      REAL,
    voltage_l3      REAL,
    current_l1      REAL,
    current_l2      REAL,
    current_l3      REAL,
    frequency       REAL,
    power_factor    REAL,
    active_power    REAL,
    reactive_power  REAL,
    apparent_power  REAL,
    active_energy   REAL,
    reactive_energy REAL,
    apparent_energy REAL,
    status          INTEGER,
    exti_trigger    INTEGER DEFAULT 0,
    payver          INTEGER DEFAULT 0,
    UNIQUE (meter_id, meter_ts)
);

SELECT create_hypertable('readings', 'meter_ts',
                         chunk_time_interval => INTERVAL '1 day',
                         if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS ix_readings_meter_time
    ON readings (meter_id, meter_ts DESC);

-- ============================================================================
-- 3. AUTO-ONBOARDING TRIGGER
--    If a meter streams before being onboarded on the frontend, register it
--    automatically with status 'auto_registered' so no data is lost.
--    The frontend can later "claim" it: UPDATE meters SET status='active', ...
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_ensure_meter_exists()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO meters (meter_id, status)
    VALUES (NEW.meter_id, 'auto_registered')
    ON CONFLICT (meter_id) DO NOTHING;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ensure_meter ON readings;
CREATE TRIGGER trg_ensure_meter
    BEFORE INSERT ON readings
    FOR EACH ROW EXECUTE FUNCTION fn_ensure_meter_exists();

-- ============================================================================
-- 4. CONNECTION EVENTS (fed by EMQX webhook / your MQTT service)
--    Lets the dashboard distinguish "meter offline" from "network gap"
-- ============================================================================
CREATE TABLE IF NOT EXISTS meter_events (
    meter_id  TEXT        NOT NULL,
    event_ts  TIMESTAMPTZ NOT NULL DEFAULT now(),
    event     TEXT        NOT NULL CHECK (event IN ('connected','disconnected')),
    detail    JSONB       NOT NULL DEFAULT '{}'::jsonb
);
SELECT create_hypertable('meter_events', 'event_ts',
                         chunk_time_interval => INTERVAL '7 days',
                         if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS ix_events_meter_time ON meter_events (meter_id, event_ts DESC);

-- ============================================================================
-- 5. CONTINUOUS AGGREGATES (the real-time computation engine)
--    15-minute rollup: reading counts (for DAR), electrical averages,
--    ingest latency, buffered-resend counts.
-- ============================================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS agg_15min
WITH (timescaledb.continuous) AS
SELECT
    meter_id,
    time_bucket('15 minutes', meter_ts)                    AS bucket,
    count(*)                                               AS received_count,
    avg(voltage_l1)   AS avg_voltage_l1,
    avg(voltage_l2)   AS avg_voltage_l2,
    avg(voltage_l3)   AS avg_voltage_l3,
    avg(current_l1)   AS avg_current_l1,
    avg(current_l2)   AS avg_current_l2,
    avg(current_l3)   AS avg_current_l3,
    avg(frequency)    AS avg_frequency,
    avg(power_factor) AS avg_power_factor,
    avg(active_power) AS avg_active_power,
    max(active_energy)   AS max_active_energy,     -- cumulative registers
    max(reactive_energy) AS max_reactive_energy,
    max(apparent_energy) AS max_apparent_energy,
    avg(EXTRACT(EPOCH FROM (received_ts - meter_ts)))      AS avg_latency_s,
    max(EXTRACT(EPOCH FROM (received_ts - meter_ts)))      AS max_latency_s,
    count(*) FILTER (WHERE received_ts - meter_ts > INTERVAL '60 seconds')
                                                           AS buffered_count
FROM readings
GROUP BY meter_id, bucket
WITH NO DATA;

-- Refresh every 5 min; 3-day window so late buffered resends still get counted
SELECT add_continuous_aggregate_policy('agg_15min',
    start_offset      => INTERVAL '3 days',
    end_offset        => INTERVAL '15 minutes',
    schedule_interval => INTERVAL '5 minutes',
    if_not_exists     => TRUE);

-- Daily rollup built on top of the 15-min aggregate (hierarchical)
CREATE MATERIALIZED VIEW IF NOT EXISTS agg_daily
WITH (timescaledb.continuous) AS
SELECT
    meter_id,
    time_bucket('1 day', bucket)  AS day,
    sum(received_count)           AS received_count,
    avg(avg_voltage_l1)           AS avg_voltage_l1,
    avg(avg_voltage_l2)           AS avg_voltage_l2,
    avg(avg_voltage_l3)           AS avg_voltage_l3,
    avg(avg_frequency)            AS avg_frequency,
    avg(avg_power_factor)         AS avg_power_factor,
    avg(avg_active_power)         AS avg_active_power,
    max(max_active_energy)        AS max_active_energy,
    avg(avg_latency_s)            AS avg_latency_s,
    sum(buffered_count)           AS buffered_count
FROM agg_15min
GROUP BY meter_id, day
WITH NO DATA;

SELECT add_continuous_aggregate_policy('agg_daily',
    start_offset      => INTERVAL '7 days',
    end_offset        => INTERVAL '1 day',
    schedule_interval => INTERVAL '30 minutes',
    if_not_exists     => TRUE);

-- Real-time aggregation: views also include not-yet-materialized raw data,
-- so today's partial DAR shows live instead of waiting for refresh jobs.
ALTER MATERIALIZED VIEW agg_15min SET (timescaledb.materialized_only = false);
ALTER MATERIALIZED VIEW agg_daily SET (timescaledb.materialized_only = false);

-- ============================================================================
-- 6. DAR (DATA ACQUISITION RATE) VIEWS
--    expected per 15-min bucket = 900 / expected_interval_s  (60 at 15s)
-- ============================================================================
CREATE OR REPLACE VIEW v_dar_15min AS
SELECT
    a.meter_id,
    m.feeder_name,
    a.bucket,
    a.received_count,
    (900 / m.expected_interval_s)                                   AS expected_count,
    ROUND(LEAST(a.received_count * 100.0 / (900 / m.expected_interval_s), 100)::numeric, 2)
                                                                    AS dar_pct,
    a.buffered_count,
    ROUND(a.avg_latency_s::numeric, 2)                              AS avg_latency_s
FROM agg_15min a
JOIN meters m USING (meter_id)
WHERE m.status <> 'decommissioned';

CREATE OR REPLACE VIEW v_dar_daily AS
SELECT
    a.meter_id,
    m.feeder_name,
    a.day,
    a.received_count,
    (86400 / m.expected_interval_s)                                 AS expected_count,
    ROUND(LEAST(a.received_count * 100.0 / (86400 / m.expected_interval_s), 100)::numeric, 2)
                                                                    AS dar_pct,
    a.buffered_count,
    ROUND(a.avg_latency_s::numeric, 2)                              AS avg_latency_s
FROM agg_daily a
JOIN meters m USING (meter_id)
WHERE m.status <> 'decommissioned';

-- ============================================================================
-- 7. GAP DETECTION FUNCTION
--    Lists every 15-min interval with missing data for a meter in a range.
--    SELECT * FROM meter_gaps('METER123', now() - interval '1 day', now());
-- ============================================================================
CREATE OR REPLACE FUNCTION meter_gaps(
    p_meter_id TEXT,
    p_from     TIMESTAMPTZ,
    p_to       TIMESTAMPTZ
) RETURNS TABLE (
    bucket         TIMESTAMPTZ,
    received_count BIGINT,
    expected_count INTEGER,
    missing_count  BIGINT
) LANGUAGE sql STABLE AS $$
    SELECT
        gf.bucket,
        COALESCE(gf.received, 0)                  AS received_count,
        (900 / m.expected_interval_s)             AS expected_count,
        (900 / m.expected_interval_s) - COALESCE(gf.received, 0) AS missing_count
    FROM meters m
    CROSS JOIN LATERAL (
        SELECT time_bucket_gapfill('15 minutes', meter_ts, p_from, p_to) AS bucket,
               count(*) AS received
        FROM readings
        WHERE meter_id = p_meter_id AND meter_ts >= p_from AND meter_ts < p_to
        GROUP BY 1
    ) gf
    WHERE m.meter_id = p_meter_id
      AND COALESCE(gf.received, 0) < (900 / m.expected_interval_s);
$$;

-- ============================================================================
-- 8. LIVE METER STATUS VIEW (dashboard home page)
--    online  = last reading within 3x expected interval
-- ============================================================================
CREATE OR REPLACE VIEW v_meter_status AS
SELECT
    m.meter_id,
    m.feeder_name,
    m.location,
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

-- ============================================================================
-- 9. ONBOARDING / DECOMMISSION FUNCTIONS (called by your Node.js API)
-- ============================================================================
CREATE OR REPLACE FUNCTION onboard_meter(
    p_meter_id     TEXT,
    p_feeder_name  TEXT,
    p_location     TEXT DEFAULT NULL,
    p_interval_s   INTEGER DEFAULT 15,
    p_onboarded_by TEXT DEFAULT NULL,
    p_metadata     JSONB DEFAULT '{}'::jsonb
) RETURNS meters LANGUAGE plpgsql AS $$
DECLARE result meters;
BEGIN
    INSERT INTO meters (meter_id, feeder_name, location, expected_interval_s,
                        onboarded_by, metadata, status)
    VALUES (p_meter_id, p_feeder_name, p_location, p_interval_s,
            p_onboarded_by, p_metadata, 'active')
    ON CONFLICT (meter_id) DO UPDATE
        SET feeder_name         = EXCLUDED.feeder_name,
            location            = COALESCE(EXCLUDED.location, meters.location),
            expected_interval_s = EXCLUDED.expected_interval_s,
            onboarded_by        = COALESCE(EXCLUDED.onboarded_by, meters.onboarded_by),
            metadata            = meters.metadata || EXCLUDED.metadata,
            status              = 'active'          -- claims auto_registered meters
    RETURNING * INTO result;
    RETURN result;
END $$;

CREATE OR REPLACE FUNCTION decommission_meter(p_meter_id TEXT)
RETURNS void LANGUAGE sql AS $$
    UPDATE meters SET status = 'decommissioned' WHERE meter_id = p_meter_id;
$$;

-- ============================================================================
-- 10. COMPRESSION & RETENTION POLICIES
-- ============================================================================
ALTER TABLE readings SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'meter_id',
    timescaledb.compress_orderby   = 'meter_ts DESC'
);
SELECT add_compression_policy('readings', INTERVAL '7 days', if_not_exists => TRUE);

-- Optional: drop raw readings older than 2 years (aggregates are kept).
-- Uncomment when you have a retention decision from regulators:
-- SELECT add_retention_policy('readings', INTERVAL '2 years', if_not_exists => TRUE);

-- ============================================================================
-- 11. APPLICATION DB USER for Node.js (do not connect as postgres superuser)
--     CHANGE THE PASSWORD before running.
-- ============================================================================
DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'protogy_app') THEN
        CREATE ROLE protogy_app LOGIN PASSWORD 'CHANGE_ME_STRONG_PASSWORD';
    END IF;
END $$;
GRANT CONNECT ON DATABASE protogy TO protogy_app;
GRANT USAGE ON SCHEMA public TO protogy_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO protogy_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO protogy_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE ON TABLES TO protogy_app;

-- ============================================================================
-- DONE. Quick sanity checks:
--   SELECT * FROM onboard_meter('TEST-METER-01','Feeder A','Lagos',15,'tosin');
--   INSERT INTO readings (meter_id, meter_ts, voltage_l1) VALUES ('TEST-METER-01', now(), 230.1);
--   CALL refresh_continuous_aggregate('agg_15min', NULL, NULL);
--   SELECT * FROM v_dar_15min;
--   SELECT * FROM v_meter_status;
--   SELECT * FROM meter_gaps('TEST-METER-01', now() - interval '1 hour', now());
-- ============================================================================
