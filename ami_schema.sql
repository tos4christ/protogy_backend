-- ============================================================================
-- PROTOGY AMI (PREPAID CUSTOMER) MODULE — isolated from feeder tables.
-- Nothing here touches meters/readings/aggregates, so existing features
-- are unaffected. Run once:
--   psql -U postgres -h localhost -d protogy -f ami_schema.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS customers (
    customer_id   SERIAL PRIMARY KEY,
    full_name     TEXT NOT NULL,
    phone         TEXT UNIQUE NOT NULL,      -- login identifier
    email         TEXT,
    password_hash TEXT NOT NULL,
    address       TEXT,
    disco         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS prepaid_meters (
    meter_serial     TEXT PRIMARY KEY,
    customer_id      INTEGER REFERENCES customers(customer_id),
    api_key          TEXT UNIQUE NOT NULL,   -- device REST authentication
    tariff_naira_kwh NUMERIC(10,2) NOT NULL DEFAULT 68.00,
    balance_kwh      NUMERIC(12,3) NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','disconnected','decommissioned')),
    last_seen_at     TIMESTAMPTZ,
    registered_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_pm_customer ON prepaid_meters (customer_id);

CREATE TABLE IF NOT EXISTS prepaid_readings (
    meter_serial  TEXT        NOT NULL,
    ts            TIMESTAMPTZ NOT NULL,
    received_ts   TIMESTAMPTZ NOT NULL DEFAULT now(),
    energy_kwh    NUMERIC(14,3),   -- cumulative register
    power_w       REAL,
    voltage       REAL,
    balance_kwh   NUMERIC(12,3),   -- credit remaining as reported by meter
    UNIQUE (meter_serial, ts)
);
SELECT create_hypertable('prepaid_readings', 'ts',
                         chunk_time_interval => INTERVAL '7 days',
                         if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS ix_pr_meter_time ON prepaid_readings (meter_serial, ts DESC);

CREATE TABLE IF NOT EXISTS credit_transactions (
    txn_id        SERIAL PRIMARY KEY,
    meter_serial  TEXT NOT NULL REFERENCES prepaid_meters(meter_serial),
    customer_id   INTEGER REFERENCES customers(customer_id),
    amount_naira  NUMERIC(12,2) NOT NULL,
    kwh           NUMERIC(12,3) NOT NULL,
    token         TEXT NOT NULL,             -- 20-digit vend token
    status        TEXT NOT NULL DEFAULT 'paid'
                  CHECK (status IN ('pending','paid','applied','failed')),
    provider      TEXT DEFAULT 'demo',       -- 'paystack' when gateway integrated
    provider_ref  TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_ct_meter ON credit_transactions (meter_serial, created_at DESC);

-- Daily usage rollup for customer charts
CREATE MATERIALIZED VIEW IF NOT EXISTS ami_daily_usage
WITH (timescaledb.continuous) AS
SELECT meter_serial,
       time_bucket('1 day', ts) AS day,
       max(energy_kwh) - min(energy_kwh) AS kwh_used,
       avg(power_w)  AS avg_power_w,
       avg(voltage)  AS avg_voltage,
       min(balance_kwh) AS end_balance_kwh
FROM prepaid_readings
GROUP BY meter_serial, day
WITH NO DATA;
SELECT add_continuous_aggregate_policy('ami_daily_usage',
    start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '30 minutes', if_not_exists => TRUE);
ALTER MATERIALIZED VIEW ami_daily_usage SET (timescaledb.materialized_only = false);

GRANT SELECT, INSERT, UPDATE ON customers, prepaid_meters, prepaid_readings, credit_transactions TO protogy_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO protogy_app;
GRANT SELECT ON ami_daily_usage TO protogy_app;
