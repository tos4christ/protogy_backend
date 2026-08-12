// nerc.js - NERC regulator module: live compliance summary, per-Disco table,
// and the three Excel reports in the regulator's expected format.
const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('./db');
const { requireAuth } = require('./auth');
const { getSettings } = require('./settings');

const router = express.Router();
router.use(requireAuth);

const ah = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error('[nerc]', req.method, req.originalUrl, err.message);
  res.status(500).json({ error: err.message });
});
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

// active_power normalised to kW using each meter's declared power_unit
const KW = "CASE WHEN s.power_unit = 'W' THEN s.active_power / 1000.0 ELSE s.active_power END";
// energy normalised to kWh
const KWH = (col) => `CASE WHEN m.energy_unit = 'Wh' THEN (${col}) / 1000.0 ELSE (${col}) END`;

// ---------------------------------------------------------------------------
// GET /api/nerc/summary?disco=   -> all 12 dashboard tiles (live + daily)
// ---------------------------------------------------------------------------
router.get('/summary', ah(async (req, res) => {
  const cfg = await getSettings();
  const params = [];
  let discoCond = '';
  if (req.query.disco && req.query.disco !== 'all') {
    params.push(req.query.disco); discoCond = ` AND s.disco = $${params.length}`;
  }

  // Live tile counts from latest readings
  const live = await pool.query(`
    SELECT count(*) AS total,
      count(*) FILTER (WHERE s.connectivity = 'online'
        AND GREATEST(s.current_l1,s.current_l2,s.current_l3) > ${+cfg.current_flow_threshold}) AS current_online,
      count(*) FILTER (WHERE s.connectivity = 'online'
        AND GREATEST(s.voltage_l1,s.voltage_l2,s.voltage_l3) > ${+cfg.voltage_present_threshold}) AS voltage_online,
      count(*) FILTER (WHERE s.connectivity = 'online'
        AND GREATEST(s.voltage_l1,s.voltage_l2,s.voltage_l3) > ${+cfg.voltage_present_threshold}
        AND (s.nominal_voltage IS NULL OR
             GREATEST(s.voltage_l1,s.voltage_l2,s.voltage_l3)
               BETWEEN s.nominal_voltage * (1 - ${+cfg.voltage_tolerance_pct}/100.0)
                   AND s.nominal_voltage * (1 + ${+cfg.voltage_tolerance_pct}/100.0)))
        AS voltage_compliant,
      COALESCE(sum(${KW}) FILTER (WHERE s.connectivity = 'online'), 0) AS total_kw
    FROM v_meter_status s WHERE 1=1 ${discoCond}`, params);

  // Today's DAR compliance
  const dar = await pool.query(`
    SELECT count(*) FILTER (WHERE d.dar_pct >= ${+cfg.dar_compliance_pct}) AS compliant
    FROM v_dar_daily d JOIN v_meter_status s USING (meter_id)
    WHERE d.day = current_date ${discoCond}`, params);

  // Today's consumption (sum of per-meter energy deltas, unit-normalised)
  const cons = await pool.query(`
    SELECT COALESCE(sum(${KWH('mx - mn')}), 0) AS kwh FROM (
      SELECT n.meter_id, max(n.energy_max) AS mx, min(n.energy_min) AS mn
      FROM agg_nerc_15min n
      WHERE n.bucket >= current_date AND n.bucket < current_date + interval '1 day'
      GROUP BY n.meter_id) x
    JOIN meters m ON m.meter_id = x.meter_id
    JOIN v_meter_status s ON s.meter_id = x.meter_id
    WHERE x.mx IS NOT NULL ${discoCond}`, params);

  // 2-day non-compliance (both of the last 2 completed days below threshold)
  const twoDay = await pool.query(`
    SELECT count(*) AS n FROM (
      SELECT d.meter_id FROM v_dar_daily d JOIN v_meter_status s USING (meter_id)
      WHERE d.day IN (current_date - 1, current_date - 2) ${discoCond}
      GROUP BY d.meter_id
      HAVING count(*) = 2 AND max(d.dar_pct) < ${+cfg.dar_compliance_pct}) t`, params);

  // 7-day moving average of DAR >= threshold
  const sevenDay = await pool.query(`
    SELECT count(*) AS n FROM (
      SELECT d.meter_id FROM v_dar_daily d JOIN v_meter_status s USING (meter_id)
      WHERE d.day >= current_date - 7 AND d.day < current_date ${discoCond}
      GROUP BY d.meter_id
      HAVING avg(d.dar_pct) >= ${+cfg.dar_compliance_pct}) t`, params);

  const L = live.rows[0];
  const total = +L.total, compliant = +dar.rows[0].compliant;
  res.json({
    generatedAt: new Date().toISOString(),
    thresholds: cfg,
    totalFeeders: total,
    compliantFeeders: compliant,
    nonCompliantFeeders: total - compliant,
    currentOnlineFeeders: +L.current_online,
    currentOfflineFeeders: total - +L.current_online,
    voltageOnlineFeeders: +L.voltage_online,
    voltageOfflineFeeders: total - +L.voltage_online,
    voltageCompliantFeeders: +L.voltage_compliant,
    voltageNonCompliantFeeders: +L.voltage_online - +L.voltage_compliant,
    totalInstantaneousPowerMW: +(+L.total_kw / 1000).toFixed(2),
    totalConsumptionTodayKWh: +(+cons.rows[0].kwh).toFixed(1),
    twoDayNonCompliance: +twoDay.rows[0].n,
    sevenDayMAcompliant: +sevenDay.rows[0].n,
  });
}));

// ---------------------------------------------------------------------------
// GET /api/nerc/summary-table?date=YYYY-MM-DD  -> per-Disco executive table
// ---------------------------------------------------------------------------
router.get('/summary-table', ah(async (req, res) => {
  const cfg = await getSettings();
  const date = isDate(req.query.date) ? req.query.date : null;
  const { rows } = await pool.query(`
    WITH days AS (
      SELECT COALESCE($1::date, current_date) AS d1,
             COALESCE($1::date, current_date) - 1 AS d0)
    SELECT s.disco,
      count(DISTINCT s.meter_id) AS feeders,
      round(100.0 * count(DISTINCT s.meter_id) FILTER (WHERE dd1.dar_pct >= ${+cfg.dar_compliance_pct})
        / NULLIF(count(DISTINCT s.meter_id),0), 1) AS compliant_pct_d1,
      round(100.0 * count(DISTINCT s.meter_id) FILTER (WHERE dd0.dar_pct >= ${+cfg.dar_compliance_pct})
        / NULLIF(count(DISTINCT s.meter_id),0), 1) AS compliant_pct_d0,
      count(DISTINCT s.meter_id) FILTER (WHERE dd1.dar_pct < ${+cfg.dar_compliance_pct}
        AND dd0.dar_pct < ${+cfg.dar_compliance_pct}) AS two_day_nc,
      round(avg(ma.ma7), 1) AS seven_day_ma
    FROM v_meter_status s
    CROSS JOIN days
    LEFT JOIN v_dar_daily dd1 ON dd1.meter_id = s.meter_id AND dd1.day = days.d1
    LEFT JOIN v_dar_daily dd0 ON dd0.meter_id = s.meter_id AND dd0.day = days.d0
    LEFT JOIN LATERAL (
      SELECT avg(d.dar_pct) AS ma7 FROM v_dar_daily d
      WHERE d.meter_id = s.meter_id AND d.day >= days.d1 - 6 AND d.day <= days.d1) ma ON TRUE
    WHERE s.disco IS NOT NULL
    GROUP BY s.disco ORDER BY s.disco`, [date]);
  res.json({ date: date || new Date().toISOString().slice(0, 10), rows });
}));

// ---------------------------------------------------------------------------
// Excel helpers
// ---------------------------------------------------------------------------
function sheetHeader(ws, title, rangeText, columns) {
  ws.mergeCells(1, 4, 1, 6);
  ws.getCell(1, 4).value = title;
  ws.getCell(1, 4).font = { bold: true, size: 14 };
  ws.getCell(2, 2).value = 'Date Range:';
  ws.getCell(2, 3).value = rangeText;
  ws.addRow([]);
  const hr = ws.getRow(3);
  columns.forEach((c, i) => {
    const cell = ws.getCell(3, i + 1);
    cell.value = c; cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3D61' } };
  });
  hr.commit && hr.commit();
}
async function sendWb(res, wb, filename) {
  res.setHeader('Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}
const fmtDay = (d) => {
  const n = d.getUTCDate();
  const suf = [1, 21, 31].includes(n) ? 'st' : [2, 22].includes(n) ? 'nd' : [3, 23].includes(n) ? 'rd' : 'th';
  return d.toLocaleString('en', { month: 'short', timeZone: 'UTC' }) + ' ' + n + suf;
};

// ---------------------------------------------------------------------------
// GET /api/nerc/report/daily-compliant?date=YYYY-MM-DD   (.xlsx)
// ---------------------------------------------------------------------------
router.get('/report/daily-compliant', ah(async (req, res) => {
  const cfg = await getSettings();
  const date = isDate(req.query.date) ? req.query.date : new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(`
    SELECT s.disco, s.feeder_name, s.station, s.mother_feeder, s.expected_interval_s,
      m.energy_unit,
      COALESCE(u.cur_on, 0) * s.expected_interval_s / 3600.0 AS current_uptime_h,
      COALESCE(u.volt_on, 0) * s.expected_interval_s / 3600.0 AS voltage_uptime_h,
      COALESCE(d.dar_pct, 0) AS dar_pct,
      COALESCE(u.mx - u.mn, 0) AS consumption_raw
    FROM v_meter_status s
    JOIN meters m USING (meter_id)
    LEFT JOIN v_dar_daily d ON d.meter_id = s.meter_id AND d.day = $1::date
    LEFT JOIN (
      SELECT meter_id, sum(current_on_count) cur_on, sum(voltage_on_count) volt_on,
             max(energy_max) mx, min(energy_min) mn
      FROM agg_nerc_15min
      WHERE bucket >= $1::date AND bucket < $1::date + interval '1 day'
      GROUP BY meter_id) u ON u.meter_id = s.meter_id
    ORDER BY s.disco NULLS LAST, s.feeder_name`, [date]);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  sheetHeader(ws, 'Compliant Feeders Report', `${date} 00:00 - 23:59`,
    ['S/N', 'Disco', 'Name', 'Station', 'Mother Feeder / Station', 'Current Uptime (Hrs)',
     'Voltage Uptime (Hrs)', 'DAR (%)', 'Power (MW)', 'Consumption (KWh)',
     'Compliance (%)', 'Compliance Status']);
  rows.forEach((r, i) => {
    const kwh = r.energy_unit === 'Wh' ? +r.consumption_raw / 1000 : +r.consumption_raw;
    const curH = Math.min(24, +r.current_uptime_h);
    const compliance = +(curH / 24 * 100).toFixed(1);
    ws.addRow([i + 1, r.disco || 'N/A', r.feeder_name || r.meter_id, r.station || 'N/A',
      r.mother_feeder || 'N/A', +curH.toFixed(1),
      +Math.min(24, +r.voltage_uptime_h).toFixed(1), +(+r.dar_pct).toFixed(1),
      +(kwh / 24 / 1000).toFixed(2), Math.round(kwh), compliance,
      compliance >= +cfg.compliance_met_pct ? 'Met' : 'Not Met']);
  });
  ws.columns.forEach((c) => { c.width = 18; });
  await sendWb(res, wb, `Daily Compliant Feeders Report ${date}.xlsx`);
}));

// ---------------------------------------------------------------------------
// GET /api/nerc/report/data-acquisition?from=&to=   (.xlsx, per-day DAR)
// ---------------------------------------------------------------------------
router.get('/report/data-acquisition', ah(async (req, res) => {
  const { from, to } = req.query;
  if (!isDate(from) || !isDate(to)) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) required' });
  const meters = await pool.query(`
    SELECT meter_id, disco, feeder_name, station, category, state, voltage_class
    FROM v_meter_status ORDER BY disco NULLS LAST, feeder_name`);
  const dar = await pool.query(`
    SELECT meter_id, day::date AS day, dar_pct FROM v_dar_daily
    WHERE day >= $1::date AND day <= $2::date`, [from, to]);
  const byMeter = {};
  dar.rows.forEach((r) => {
    (byMeter[r.meter_id] = byMeter[r.meter_id] || {})[r.day.toISOString().slice(0, 10)] = +r.dar_pct;
  });
  const days = [];
  for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z');
       d.setUTCDate(d.getUTCDate() + 1)) days.push(new Date(d));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  sheetHeader(ws, 'Data Acquisition Report', `${from} - ${to}`,
    ['S/N', 'Disco', 'Feeder Name', 'Station', 'Feeder Category', 'State', 'Voltage Class',
     ...days.map(fmtDay)]);
  meters.rows.forEach((m, i) => {
    ws.addRow([i + 1, m.disco || 'N/A', m.feeder_name || m.meter_id, m.station || 'N/A',
      m.category || 'N/A', m.state || 'N/A', m.voltage_class || 'N/A',
      ...days.map((d) => {
        const v = (byMeter[m.meter_id] || {})[d.toISOString().slice(0, 10)];
        return v === undefined ? 0 : +v.toFixed(1);
      })]);
  });
  ws.columns.forEach((c, i) => { c.width = i < 7 ? 20 : 9; });
  await sendWb(res, wb, `Data Acquisition Report ${from} to ${to}.xlsx`);
}));

// ---------------------------------------------------------------------------
// GET /api/nerc/report/month-to-date?month=YYYY-MM  (.xlsx, per-day current-uptime hours)
// ---------------------------------------------------------------------------
router.get('/report/month-to-date', ah(async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '')
    ? req.query.month : new Date().toISOString().slice(0, 7);
  const from = month + '-01';
  const meters = await pool.query(`
    SELECT s.meter_id, s.disco, s.feeder_name, s.category, s.mother_feeder, s.expected_interval_s
    FROM v_meter_status s ORDER BY s.disco NULLS LAST, s.feeder_name`);
  const up = await pool.query(`
    SELECT meter_id, time_bucket('1 day', bucket)::date AS day, sum(current_on_count) AS cur_on
    FROM agg_nerc_15min
    WHERE bucket >= $1::date AND bucket < ($1::date + interval '1 month')
    GROUP BY meter_id, 2`, [from]);
  const byMeter = {};
  up.rows.forEach((r) => {
    (byMeter[r.meter_id] = byMeter[r.meter_id] || {})[r.day.toISOString().slice(0, 10)] = +r.cur_on;
  });
  const last = new Date(Math.min(
    new Date(new Date(from + 'T00:00:00Z').setUTCMonth(new Date(from + 'T00:00:00Z').getUTCMonth() + 1) - 86400000),
    Date.now()));
  const days = [];
  for (let d = new Date(from + 'T00:00:00Z'); d <= last; d.setUTCDate(d.getUTCDate() + 1)) days.push(new Date(d));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  sheetHeader(ws, 'Month To Date Report', `${from} - ${last.toISOString().slice(0, 10)}`,
    ['S/N', 'Feeder Name', 'Category', 'Mother Feeder / Station', 'Disco', ...days.map(fmtDay)]);
  meters.rows.forEach((m, i) => {
    ws.addRow([i + 1, m.feeder_name || m.meter_id, m.category || 'N/A',
      m.mother_feeder || 'N/A', m.disco || 'N/A',
      ...days.map((d) => {
        const c = (byMeter[m.meter_id] || {})[d.toISOString().slice(0, 10)] || 0;
        return Math.min(24, Math.round(c * m.expected_interval_s / 3600));
      })]);
  });
  ws.columns.forEach((c, i) => { c.width = i < 5 ? 20 : 8; });
  await sendWb(res, wb, `Month To Date Report ${month}.xlsx`);
}));

module.exports = router;
