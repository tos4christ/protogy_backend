-- Map support: expose coordinates in the live status view.
-- Run once: psql -U postgres -h localhost -d protogy -f add_map_support.sql
DROP VIEW IF EXISTS v_meter_status;
CREATE VIEW v_meter_status AS
SELECT
    m.meter_id, m.feeder_name, m.disco, m.location, m.controller_id,
    m.latitude, m.longitude,
    m.status AS onboarding_status,
    lr.meter_ts  AS last_reading_at,
    lr.received_ts AS last_received_at,
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
