// routes.js - REST API for the Protogy dashboard
const express = require('express');
const Cursor = require('pg-cursor');
const pool = require('./db');

const { requireAdmin } = require('./auth');
const { getSettings } = require('./settings');
const router = express.Router();
const V_THR = +(process.env.VOLTAGE_PRESENT_THRESHOLD || 50);
const I_THR = +(process.env.CURRENT_PRESENT_THRESHOLD || 0.5);

const ah = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error('[api]', req.method, req.originalUrl, err.message);
  res.status(500).json({ error: err.message });
});

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

// ---------------------------------------------------------------------------
// FEATURE 1: Onboard a new meter (administrator)
// POST /api/meters  { meterId, feederName, location, intervalSeconds, user, metadata }
// Works before OR after the physical meter starts streaming; claims
// auto_registered meters.
// ---------------------------------------------------------------------------
router.post('/meters', requireAdmin, ah(async (req, res) => {
  const { meterId, feederName, location, intervalSeconds, user, metadata, controllerId, disco, latitude, longitude,
    station, motherFeeder, category, state, voltageClass, nominalVoltage, tariffBand } = req.body;
  if (!meterId || !feederName) {
    return res.status(400).json({ error: 'meterId and feederName are required' });
  }
  const { rows } = await pool.query(
    'SELECT * FROM onboard_meter($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',
    [meterId, feederName, location || null, intervalSeconds || 15, user || null,
     JSON.stringify(metadata || {}), controllerId || null, disco || null,
     latitude != null && latitude !== '' ? +latitude : null,
     longitude != null && longitude !== '' ? +longitude : null,
     station || null, motherFeeder || null, category || null, state || null,
     voltageClass || null,
     nominalVoltage != null && nominalVoltage !== '' ? +nominalVoltage : null,
     tariffBand || null]
  );
  res.status(201).json(rows[0]);
}));

// ---------------------------------------------------------------------------
// List all meters (for dropdowns)
// GET /api/meters
// ---------------------------------------------------------------------------
router.get('/meters', ah(async (req, res) => {
  const params = [];
  let where = "status <> 'decommissioned'";
  if (req.query.disco) { params.push(req.query.disco); where += ` AND disco = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT meter_id, feeder_name, disco, location, status, expected_interval_s, controller_id, onboarded_at
     FROM meters WHERE ${where} ORDER BY feeder_name NULLS LAST, meter_id`, params);
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// List of Discos in use (for filter dropdowns)
// GET /api/discos
// ---------------------------------------------------------------------------
router.get('/discos', ah(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT disco, count(*) AS feeders FROM meters
     WHERE disco IS NOT NULL AND status <> 'decommissioned'
     GROUP BY disco ORDER BY disco`);
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// List of Tariff Bands in use (for filter dropdowns)
// GET /api/bands
// ---------------------------------------------------------------------------
router.get('/bands', ah(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT tariff_band AS band, count(*) AS feeders FROM meters
     WHERE tariff_band IS NOT NULL AND status <> 'decommissioned'
     GROUP BY tariff_band ORDER BY tariff_band`);
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// FEATURE 4: Feeder status - all / online / offline, filterable by Disco and
// Band, paginated so a fleet of thousands of feeders stays fast and compact
// in the UI (page/limit query params; limit=all disables paging).
// GET /api/meters/status?filter=all|online|offline&disco=&band=&page=&limit=
// ---------------------------------------------------------------------------
router.get('/meters/status', ah(async (req, res) => {
  const filter = (req.query.filter || 'all').toLowerCase();
  const conds = [];
  const params = [];
  if (filter === 'online') conds.push("connectivity = 'online'");
  else if (filter === 'offline') conds.push("connectivity IN ('offline','never_reported')");
  if (req.query.disco) { params.push(req.query.disco); conds.push(`disco = $${params.length}`); }
  if (req.query.band) { params.push(req.query.band); conds.push(`tariff_band = $${params.length}`); }
  let sql = 'SELECT * FROM v_meter_status';
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY feeder_name NULLS LAST, meter_id';
  const { rows } = await pool.query(sql, params);
  const counts = { online: 0, offline: 0, never_reported: 0 };
  rows.forEach((r) => { counts[r.connectivity] = (counts[r.connectivity] || 0) + 1; });

  const total = rows.length;
  const limitRaw = (req.query.limit || '').toLowerCase();
  const limit = limitRaw === 'all' ? total : Math.min(1000, Math.max(1, +req.query.limit || 100));
  const page = Math.max(1, +req.query.page || 1);
  const totalPages = Math.max(1, Math.ceil(total / (limit || 1)));
  const start = (Math.min(page, totalPages) - 1) * limit;
  const pageRows = limitRaw === 'all' ? rows : rows.slice(start, start + limit);

  res.json({
    filter, count: total, counts,
    page: Math.min(page, totalPages), limit: limitRaw === 'all' ? 'all' : limit, totalPages, total,
    meters: pageRows,
  });
}));

// ---------------------------------------------------------------------------
// FEATURE 6: All details about a feeder (registry + latest reading + 24h stats)
// GET /api/meters/:id
// ---------------------------------------------------------------------------
router.get('/meters/:id', ah(async (req, res) => {
  const id = req.params.id;
  const meter = await pool.query('SELECT * FROM meters WHERE meter_id = $1', [id]);
  if (meter.rows.length === 0) return res.status(404).json({ error: 'meter not found' });
  const [status, today] = await Promise.all([
    pool.query('SELECT * FROM v_meter_status WHERE meter_id = $1', [id]),
    pool.query(
      `SELECT count(*) AS readings_24h,
              min(meter_ts) AS first_reading_24h,
              max(meter_ts) AS last_reading_24h,
              round(avg(EXTRACT(EPOCH FROM (received_ts - meter_ts)))::numeric, 2) AS avg_latency_s
       FROM readings WHERE meter_id = $1 AND meter_ts > now() - interval '24 hours'`, [id]),
  ]);
  res.json({ ...meter.rows[0], live: status.rows[0] || null, last24h: today.rows[0] });
}));

// ---------------------------------------------------------------------------
// FEATURE 2: Paginated readings for a selected date
// GET /api/meters/:id/readings?date=YYYY-MM-DD&page=1&limit=100&order=asc|desc
// ---------------------------------------------------------------------------
router.get('/meters/:id/readings', ah(async (req, res) => {
  const { id } = req.params;
  const { date } = req.query;
  if (!isDate(date)) return res.status(400).json({ error: 'date=YYYY-MM-DD is required' });
  const page = Math.max(1, +(req.query.page || 1));
  const limit = Math.min(1000, Math.max(1, +(req.query.limit || 100)));
  const order = req.query.order === 'desc' ? 'DESC' : 'ASC';
  const offset = (page - 1) * limit;

  const [data, total] = await Promise.all([
    pool.query(
      `SELECT meter_ts, received_ts,
              voltage_l1, voltage_l2, voltage_l3,
              current_l1, current_l2, current_l3,
              frequency, power_factor,
              active_power, reactive_power, apparent_power,
              active_energy, reactive_energy, apparent_energy,
              status, exti_trigger, payver,
              round(EXTRACT(EPOCH FROM (received_ts - meter_ts))::numeric, 1) AS latency_s
       FROM readings
       WHERE meter_id = $1 AND meter_ts >= $2::date AND meter_ts < $2::date + interval '1 day'
       ORDER BY meter_ts ${order} LIMIT $3 OFFSET $4`,
      [id, date, limit, offset]),
    pool.query(
      `SELECT count(*) AS n FROM readings
       WHERE meter_id = $1 AND meter_ts >= $2::date AND meter_ts < $2::date + interval '1 day'`,
      [id, date]),
  ]);
  const totalRows = +total.rows[0].n;
  res.json({
    meterId: id, date, page, limit,
    totalRows, totalPages: Math.max(1, Math.ceil(totalRows / limit)),
    rows: data.rows,
  });
}));

// ---------------------------------------------------------------------------
// FEATURE 3: D.A.R for a number of days or a date range
// GET /api/meters/:id/dar?days=7
// GET /api/meters/:id/dar?from=YYYY-MM-DD&to=YYYY-MM-DD
// GET /api/meters/:id/dar?date=YYYY-MM-DD&resolution=15min   (intra-day view)
// ---------------------------------------------------------------------------
router.get('/meters/:id/dar', ah(async (req, res) => {
  const { id } = req.params;
  const { from, to, days, date, resolution } = req.query;

  if (resolution === '15min') {
    if (!isDate(date)) return res.status(400).json({ error: 'date=YYYY-MM-DD required for 15min resolution' });
    const { rows } = await pool.query(
      `SELECT bucket, received_count, expected_count, dar_pct, buffered_count, avg_latency_s
       FROM v_dar_15min
       WHERE meter_id = $1 AND bucket >= $2::date AND bucket < $2::date + interval '1 day'
       ORDER BY bucket`, [id, date]);
    return res.json({ meterId: id, date, resolution: '15min', buckets: rows });
  }

  let fromD, toD;
  if (isDate(from) && isDate(to)) { fromD = from; toD = to; }
  else {
    const n = Math.min(366, Math.max(1, +(days || 7)));
    const r = await pool.query(
      `SELECT to_char(current_date - ($1 - 1) * interval '1 day', 'YYYY-MM-DD') AS f,
              to_char(current_date, 'YYYY-MM-DD') AS t`, [n]);
    fromD = r.rows[0].f;
    toD = r.rows[0].t;
  }
  const { rows } = await pool.query(
    `SELECT day::date AS day, received_count, expected_count, dar_pct, buffered_count, avg_latency_s
     FROM v_dar_daily
     WHERE meter_id = $1 AND day >= $2::date AND day <= $3::date
     ORDER BY day`, [id, fromD, toD]);
  const avg = rows.length
    ? +(rows.reduce((s, r) => s + +r.dar_pct, 0) / rows.length).toFixed(2) : 0;
  res.json({ meterId: id, from: fromD, to: toD, averageDarPct: avg, days: rows });
}));

// ---------------------------------------------------------------------------
// FEATURE 5 (part of 4 in your list): Uptime / downtime for a selected date
// GET /api/meters/:id/uptime?date=YYYY-MM-DD
// in_service      : voltage present AND current present  (feeder carrying load)
// out_of_service  : voltage present AND no current       (feeder open / no load)
// no_supply       : no voltage at all
// unaccounted     : intervals where no data arrived (gaps)
// All values in seconds; frontend converts to h/m/s.
// ---------------------------------------------------------------------------
router.get('/meters/:id/uptime', ah(async (req, res) => {
  const { id } = req.params;
  const { date } = req.query;
  if (!isDate(date)) return res.status(400).json({ error: 'date=YYYY-MM-DD is required' });
  const { rows } = await pool.query(
    `SELECT
        m.expected_interval_s,
        count(r.*) AS samples,
        count(*) FILTER (WHERE GREATEST(r.voltage_l1, r.voltage_l2, r.voltage_l3) > $3
                           AND GREATEST(r.current_l1, r.current_l2, r.current_l3) > $4)
          * m.expected_interval_s AS in_service_s,
        count(*) FILTER (WHERE GREATEST(r.voltage_l1, r.voltage_l2, r.voltage_l3) > $3
                           AND COALESCE(GREATEST(r.current_l1, r.current_l2, r.current_l3), 0) <= $4)
          * m.expected_interval_s AS out_of_service_s,
        count(*) FILTER (WHERE COALESCE(GREATEST(r.voltage_l1, r.voltage_l2, r.voltage_l3), 0) <= $3)
          * m.expected_interval_s AS no_supply_s
     FROM meters m
     LEFT JOIN readings r ON r.meter_id = m.meter_id
        AND r.meter_ts >= $2::date AND r.meter_ts < $2::date + interval '1 day'
     WHERE m.meter_id = $1
     GROUP BY m.expected_interval_s`, [id, date, V_THR, I_THR]);
  if (rows.length === 0) return res.status(404).json({ error: 'meter not found' });
  const r = rows[0];
  const daySeconds = 86400;
  const accounted = +r.in_service_s + +r.out_of_service_s + +r.no_supply_s;
  res.json({
    meterId: id, date,
    samples: +r.samples,
    expectedIntervalS: +r.expected_interval_s,
    inServiceS: +r.in_service_s,        // had voltage AND current
    outOfServiceS: +r.out_of_service_s, // voltage only, no current
    noSupplyS: +r.no_supply_s,          // no voltage
    unaccountedS: Math.max(0, daySeconds - accounted), // data gaps
    darPct: +((+r.samples * +r.expected_interval_s * 100) / daySeconds).toFixed(2),
    thresholds: { voltage: V_THR, current: I_THR },
  });
}));

// ---------------------------------------------------------------------------
// FEATURE 5: Gaps for a selected day - start, end, duration for every gap
// GET /api/meters/:id/gaps?date=YYYY-MM-DD
// A gap = no reading for more than 2x the expected interval. Includes edge
// gaps (midnight -> first reading, last reading -> end of day / now).
// ---------------------------------------------------------------------------
router.get('/meters/:id/gaps', ah(async (req, res) => {
  const { id } = req.params;
  const { date } = req.query;
  if (!isDate(date)) return res.status(400).json({ error: 'date=YYYY-MM-DD is required' });
  const { rows } = await pool.query(
    `WITH m AS (SELECT expected_interval_s FROM meters WHERE meter_id = $1),
     bounds AS (
       SELECT $2::date::timestamptz AS day_start,
              LEAST($2::date + interval '1 day', now()) AS day_end
     ),
     pts AS (
       SELECT meter_ts FROM readings
       WHERE meter_id = $1 AND meter_ts >= $2::date AND meter_ts < $2::date + interval '1 day'
       UNION ALL SELECT day_start FROM bounds
       UNION ALL SELECT day_end   FROM bounds
     ),
     ordered AS (
       SELECT meter_ts, LAG(meter_ts) OVER (ORDER BY meter_ts) AS prev_ts FROM pts
     )
     SELECT prev_ts AS gap_start,
            meter_ts AS gap_end,
            round(EXTRACT(EPOCH FROM (meter_ts - prev_ts))::numeric, 0) AS duration_s
     FROM ordered, m
     WHERE prev_ts IS NOT NULL
       AND meter_ts - prev_ts > (m.expected_interval_s * 2) * interval '1 second'
     ORDER BY prev_ts`, [id, date]);
  const totalGapS = rows.reduce((s, g) => s + +g.duration_s, 0);
  res.json({ meterId: id, date, gapCount: rows.length, totalGapS, gaps: rows });
}));

// ---------------------------------------------------------------------------
// FEATURE 7: Download readings as CSV for a selected duration (streamed)
// GET /api/meters/:id/download?from=YYYY-MM-DD&to=YYYY-MM-DD
// ---------------------------------------------------------------------------
router.get('/meters/:id/download', ah(async (req, res) => {
  const { id } = req.params;
  const { from, to } = req.query;
  if (!isDate(from) || !isDate(to)) {
    return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required' });
  }
  const cols = ['meter_ts', 'received_ts', 'voltage_l1', 'voltage_l2', 'voltage_l3',
    'current_l1', 'current_l2', 'current_l3', 'frequency', 'power_factor',
    'active_power', 'reactive_power', 'apparent_power',
    'active_energy', 'reactive_energy', 'apparent_energy',
    'status', 'exti_trigger', 'payver'];

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition',
    `attachment; filename="${id}_${from}_to_${to}.csv"`);
  res.write('meter_id,' + cols.join(',') + '\n');

  const client = await pool.connect();
  try {
    const cursor = client.query(new Cursor(
      `SELECT ${cols.join(',')} FROM readings
       WHERE meter_id = $1 AND meter_ts >= $2::date AND meter_ts < $3::date + interval '1 day'
       ORDER BY meter_ts`, [id, from, to]));
    const readBatch = () => new Promise((resolve, reject) =>
      cursor.read(5000, (err, rows) => (err ? reject(err) : resolve(rows))));
    let rows;
    while ((rows = await readBatch()).length > 0) {
      const chunk = rows.map((r) =>
        id + ',' + cols.map((c) => {
          const v = r[c];
          if (v === null || v === undefined) return '';
          if (v instanceof Date) return v.toISOString();
          return String(v);
        }).join(',')).join('\n') + '\n';
      if (!res.write(chunk)) await new Promise((rs) => res.once('drain', rs));
    }
    cursor.close(() => {});
    res.end();
  } finally {
    client.release();
  }
}));


// ---------------------------------------------------------------------------
// DASHBOARD OVERVIEW: fleet stats + today's DAR per feeder (for charts),
// filterable by Disco and Band, with a per-Band breakdown for grouped
// analysis, and paginated feeders so a fleet of thousands stays fast and
// the chart can be shown a compact page at a time.
// GET /api/dashboard/overview?disco=&band=&page=&limit=
// ---------------------------------------------------------------------------
router.get('/dashboard/overview', ah(async (req, res) => {
  const params = [];
  const conds = [];
  if (req.query.disco) { params.push(req.query.disco); conds.push(`s.disco = $${params.length}`); }
  if (req.query.band) { params.push(req.query.band); conds.push(`s.tariff_band = $${params.length}`); }
  const whereCond = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT s.meter_id, s.feeder_name, s.disco, s.tariff_band, s.connectivity, s.onboarding_status,
            s.last_reading_at, s.active_power, s.reactive_power, s.power_factor, s.frequency,
            s.power_unit,
            COALESCE(d.dar_pct, 0)        AS dar_today,
            COALESCE(d.received_count, 0) AS received_today,
            COALESCE(d.buffered_count, 0) AS buffered_today
     FROM v_meter_status s
     LEFT JOIN v_dar_daily d
       ON d.meter_id = s.meter_id AND d.day = current_date${whereCond}
     ORDER BY s.feeder_name NULLS LAST, s.meter_id`, params);
  const online = rows.filter((r) => r.connectivity === 'online').length;
  const offline = rows.filter((r) => r.connectivity === 'offline').length;
  const never = rows.filter((r) => r.connectivity === 'never_reported').length;
  const reporting = rows.filter((r) => +r.received_today > 0);
  const fleetAvgDar = reporting.length
    ? +(reporting.reduce((s2, r) => s2 + +r.dar_today, 0) / reporting.length).toFixed(2)
    : 0;

  // Per-Band roll-up, so the dashboard can group its analysis and chart by
  // Band (e.g. "average DAR for Band A") instead of only per-feeder.
  const byBand = {};
  rows.forEach((r) => {
    const k = r.tariff_band || 'Unassigned';
    (byBand[k] = byBand[k] || []).push(r);
  });
  const bandSummary = Object.entries(byBand).map(([band, list]) => {
    const rep = list.filter((r) => +r.received_today > 0);
    return {
      band,
      feeders: list.length,
      online: list.filter((r) => r.connectivity === 'online').length,
      offline: list.filter((r) => r.connectivity !== 'online').length,
      avgDarToday: rep.length
        ? +(rep.reduce((s2, r) => s2 + +r.dar_today, 0) / rep.length).toFixed(1) : 0,
    };
  }).sort((a, b) => a.band.localeCompare(b.band));

  // Paginate the per-feeder list that backs the chart/table, so thousands of
  // feeders render one compact page at a time instead of one giant chart.
  const total = rows.length;
  const limitRaw = (req.query.limit || '').toLowerCase();
  const limit = limitRaw === 'all' ? total : Math.min(500, Math.max(1, +req.query.limit || 50));
  const page = Math.max(1, +req.query.page || 1);
  const totalPages = Math.max(1, Math.ceil(total / (limit || 1)));
  const start = (Math.min(page, totalPages) - 1) * limit;
  const pageRows = limitRaw === 'all' ? rows : rows.slice(start, start + limit);

  res.json({
    generatedAt: new Date().toISOString(),
    totals: { feeders: total, online, offline, never_reported: never, fleetAvgDarToday: fleetAvgDar },
    bandSummary,
    page: Math.min(page, totalPages), limit: limitRaw === 'all' ? 'all' : limit, totalPages, total,
    feeders: pageRows,
  });
}));

// ---------------------------------------------------------------------------
// POWER QUALITY ANALYTICS: fleet-wide power factor distribution, worst-PF
// feeders, and phase current imbalance — real-time, computed from each
// feeder's latest live reading (not a daily rollup). Two distinct power-
// quality problems, neither visible from a simple online/offline view:
//   - Poor power factor: reactive load inefficiency, a real cost driver for
//     DisCos and a classic utility penalty metric.
//   - Phase current imbalance: one phase carrying meaningfully more load
//     than the others, an early indicator of wiring faults or an unevenly
//     distributed single-phase load — invisible unless you compare phases
//     directly, which no other screen in the app currently does.
// GET /api/dashboard/power-quality?disco=&band=
// ---------------------------------------------------------------------------
router.get('/dashboard/power-quality', ah(async (req, res) => {
  const cfg = await getSettings();
  const pfThreshold = +cfg.pf_poor_threshold;
  const imbalanceThreshold = +cfg.current_imbalance_pct_threshold;

  const params = [];
  const conds = ["s.connectivity = 'online'"];
  if (req.query.disco) { params.push(req.query.disco); conds.push(`s.disco = $${params.length}`); }
  if (req.query.band) { params.push(req.query.band); conds.push(`s.tariff_band = $${params.length}`); }
  const { rows } = await pool.query(`
    SELECT s.meter_id, s.feeder_name, s.disco, s.tariff_band,
           s.power_factor, s.current_l1, s.current_l2, s.current_l3
    FROM v_meter_status s
    WHERE ${conds.join(' AND ')}`, params);

  // Power factor distribution — bucketed for a fleet-wide histogram.
  const pfBuckets = [
    { range: '< 0.70 (poor)', min: -Infinity, max: 0.70, count: 0 },
    { range: '0.70 – 0.85', min: 0.70, max: 0.85, count: 0 },
    { range: '0.85 – 0.95', min: 0.85, max: 0.95, count: 0 },
    { range: '≥ 0.95 (good)', min: 0.95, max: Infinity, count: 0 },
  ];
  const withPf = rows.filter((r) => r.power_factor != null);
  withPf.forEach((r) => {
    const pf = Math.abs(+r.power_factor);
    const b = pfBuckets.find((x) => pf >= x.min && pf < x.max) || pfBuckets[pfBuckets.length - 1];
    b.count++;
  });
  const avgPf = withPf.length
    ? +(withPf.reduce((a, r) => a + Math.abs(+r.power_factor), 0) / withPf.length).toFixed(3) : null;

  const poorPf = withPf
    .filter((r) => Math.abs(+r.power_factor) < pfThreshold)
    .map((r) => ({ meterId: r.meter_id, feeder: r.feeder_name || r.meter_id, disco: r.disco,
      band: r.tariff_band, powerFactor: +Math.abs(+r.power_factor).toFixed(3) }))
    .sort((a, b) => a.powerFactor - b.powerFactor)
    .slice(0, 25);

  // Phase current imbalance — how far the most-loaded phase deviates from
  // the average of all three, as a percentage of that average.
  const withCurrent = rows.filter((r) => r.current_l1 != null && r.current_l2 != null && r.current_l3 != null);
  const imbalanceList = withCurrent.map((r) => {
    const i1 = +r.current_l1, i2 = +r.current_l2, i3 = +r.current_l3;
    const avg = (i1 + i2 + i3) / 3;
    const maxDev = Math.max(Math.abs(i1 - avg), Math.abs(i2 - avg), Math.abs(i3 - avg));
    const pct = avg > 0.1 ? +(maxDev / avg * 100).toFixed(1) : 0;
    return { meterId: r.meter_id, feeder: r.feeder_name || r.meter_id, disco: r.disco, band: r.tariff_band,
      current_l1: i1, current_l2: i2, current_l3: i3, imbalancePct: pct };
  });
  const avgImbalancePct = imbalanceList.length
    ? +(imbalanceList.reduce((a, r) => a + r.imbalancePct, 0) / imbalanceList.length).toFixed(1) : null;
  const worstImbalance = imbalanceList
    .filter((r) => r.imbalancePct >= imbalanceThreshold)
    .sort((a, b) => b.imbalancePct - a.imbalancePct)
    .slice(0, 25);

  res.json({
    generatedAt: new Date().toISOString(),
    feedersAnalyzed: rows.length,
    pfThreshold, imbalanceThreshold,
    pf: { avgPf, buckets: pfBuckets.map(({ range, count }) => ({ range, count })), poor: poorPf },
    imbalance: { avgImbalancePct, worst: worstImbalance },
  });
}));

// ---------------------------------------------------------------------------
// CHART SERIES: 15-min averaged electrical values for a date (from agg_15min)
// GET /api/meters/:id/series?date=YYYY-MM-DD
// ---------------------------------------------------------------------------
router.get('/meters/:id/series', ah(async (req, res) => {
  const { id } = req.params;
  const { date } = req.query;
  if (!isDate(date)) return res.status(400).json({ error: 'date=YYYY-MM-DD is required' });
  const meter = await pool.query('SELECT power_unit FROM meters WHERE meter_id = $1', [id]);
  const { rows } = await pool.query(
    `SELECT bucket,
            round(avg_voltage_l1::numeric,1) AS v1, round(avg_voltage_l2::numeric,1) AS v2,
            round(avg_voltage_l3::numeric,1) AS v3,
            round(avg_current_l1::numeric,2) AS i1, round(avg_current_l2::numeric,2) AS i2,
            round(avg_current_l3::numeric,2) AS i3,
            round(avg_frequency::numeric,2)  AS freq,
            round(avg_power_factor::numeric,3) AS pf,
            round(avg_active_power::numeric,1) AS p,
            received_count
     FROM agg_15min
     WHERE meter_id = $1 AND bucket >= $2::date AND bucket < $2::date + interval '1 day'
     ORDER BY bucket`, [id, date]);
  res.json({ meterId: id, date, powerUnit: meter.rows[0]?.power_unit || 'kW', points: rows });
}));

// ---------------------------------------------------------------------------
// DISABLE / ENABLE a meter temporarily (admin)
// PATCH /api/meters/:id/status  { status: "active" | "inactive" }
// Inactive meters stay in the DB, keep their history, and still ingest data,
// but are excluded from compliance views if you filter on status.
// ---------------------------------------------------------------------------
router.patch('/meters/:id/status', requireAdmin, ah(async (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'inactive'].includes(status)) {
    return res.status(400).json({ error: "status must be 'active' or 'inactive'" });
  }
  const { rows } = await pool.query(
    `UPDATE meters SET status = $2 WHERE meter_id = $1 AND status <> 'decommissioned'
     RETURNING meter_id, status`, [req.params.id, status]);
  if (rows.length === 0) return res.status(404).json({ error: 'meter not found (or decommissioned)' });
  res.json(rows[0]);
}));

// ---------------------------------------------------------------------------
// DELETE a meter (admin)
// DELETE /api/meters/:id            -> decommission (keeps all history)
// DELETE /api/meters/:id?purge=true -> hard delete meter + ALL its readings/events
// ---------------------------------------------------------------------------
router.delete('/meters/:id', requireAdmin, ah(async (req, res) => {
  const id = req.params.id;
  const purge = req.query.purge === 'true';
  const exists = await pool.query('SELECT 1 FROM meters WHERE meter_id = $1', [id]);
  if (exists.rows.length === 0) return res.status(404).json({ error: 'meter not found' });
  if (!purge) {
    await pool.query('SELECT decommission_meter($1)', [id]);
    return res.json({ meterId: id, action: 'decommissioned', note: 'history retained' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r1 = await client.query('DELETE FROM readings WHERE meter_id = $1', [id]);
    const r2 = await client.query('DELETE FROM meter_events WHERE meter_id = $1', [id]);
    await client.query('DELETE FROM meters WHERE meter_id = $1', [id]);
    await client.query('COMMIT');
    res.json({ meterId: id, action: 'purged', readingsDeleted: r1.rowCount, eventsDeleted: r2.rowCount });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

module.exports = router;
