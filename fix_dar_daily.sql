-- Fix: daily DAR was reading agg_daily (hierarchical aggregate), whose
-- real-time union can lag/stall. Rebuild v_dar_daily directly on agg_15min,
-- which is proven live. Run once:
--   psql -U postgres -h localhost -d protogy -f fix_dar_daily.sql

DROP VIEW IF EXISTS v_dar_daily;
CREATE VIEW v_dar_daily AS
SELECT
    a.meter_id,
    m.feeder_name,
    time_bucket('1 day', a.bucket)               AS day,
    sum(a.received_count)                        AS received_count,
    (86400 / m.expected_interval_s)              AS expected_count,
    ROUND(LEAST(sum(a.received_count) * 100.0
          / (86400 / m.expected_interval_s), 100)::numeric, 2) AS dar_pct,
    sum(a.buffered_count)                        AS buffered_count,
    ROUND(avg(a.avg_latency_s)::numeric, 2)      AS avg_latency_s
FROM agg_15min a
JOIN meters m USING (meter_id)
WHERE m.status <> 'decommissioned'
GROUP BY a.meter_id, m.feeder_name, day, m.expected_interval_s;

GRANT SELECT ON v_dar_daily TO protogy_app;