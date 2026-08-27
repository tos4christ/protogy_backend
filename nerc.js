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

// Builds "AND alias.disco = $n AND alias.tariff_band = $m" (or WHERE variant),
// appending values to the given params array. Shared by every NERC endpoint
// so DisCo + Band always filter together, the same way, everywhere.
function filterCond(req, params, alias, keyword = 'AND') {
  const col = (name) => (alias ? `${alias}.${name}` : name);
  let cond = '';
  if (req.query.disco && req.query.disco !== 'all') {
    params.push(req.query.disco);
    cond += ` ${keyword} ${col('disco')} = $${params.length}`;
    keyword = 'AND';
  }
  if (req.query.band && req.query.band !== 'all') {
    params.push(req.query.band);
    cond += ` ${keyword} ${col('tariff_band')} = $${params.length}`;
  }
  return cond;
}

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
  const discoCond = filterCond(req, params, 's');

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
// GET /api/nerc/summary-table?date=YYYY-MM-DD&disco=  -> per-Disco executive table
// When ?disco= is set, the table narrows to that single Disco row so it stays
// in lockstep with the tiles above it and the feeder drill-down/reports below.
// ---------------------------------------------------------------------------
router.get('/summary-table', ah(async (req, res) => {
  const cfg = await getSettings();
  const date = isDate(req.query.date) ? req.query.date : null;
  const params = [date];
  const discoCond = filterCond(req, params, 's');
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
    WHERE s.disco IS NOT NULL ${discoCond}
    GROUP BY s.disco ORDER BY s.disco`, params);
  res.json({ date: date || new Date().toISOString().slice(0, 10), disco: req.query.disco || 'all', band: req.query.band || 'all', rows });
}));

// ---------------------------------------------------------------------------
// GET /api/nerc/compliance?date=YYYY-MM-DD&disco=
// Compliance level (current uptime / 24h) per FEEDER, plus per-Disco averages.
// This backs the feeder drill-down, so it honours the same ?disco= as the
// tiles and executive summary above it.
// ---------------------------------------------------------------------------
router.get('/compliance', ah(async (req, res) => {
  const cfg = await getSettings();
  const date = isDate(req.query.date) ? req.query.date : new Date().toISOString().slice(0, 10);
  const params = [date];
  const discoCond = filterCond(req, params, 's');
  const { rows } = await pool.query(`
    SELECT s.meter_id, s.feeder_name, s.disco, s.tariff_band,
      COALESCE(d.dar_pct, 0) AS dar_pct,
      LEAST(24, COALESCE(u.cur_on, 0) * s.expected_interval_s / 3600.0)  AS current_uptime_h,
      LEAST(24, COALESCE(u.volt_on, 0) * s.expected_interval_s / 3600.0) AS voltage_uptime_h
    FROM v_meter_status s
    LEFT JOIN v_dar_daily d ON d.meter_id = s.meter_id AND d.day = $1::date
    LEFT JOIN (
      SELECT meter_id, sum(current_on_count) cur_on, sum(voltage_on_count) volt_on
      FROM agg_nerc_15min
      WHERE bucket >= $1::date AND bucket < $1::date + interval '1 day'
      GROUP BY meter_id) u ON u.meter_id = s.meter_id
    WHERE 1=1 ${discoCond}
    ORDER BY s.disco NULLS LAST, s.feeder_name`, params);

  const feeders = rows.map((r) => {
    const compliance = +(+r.current_uptime_h / 24 * 100).toFixed(1);
    return {
      meterId: r.meter_id, feeder: r.feeder_name || r.meter_id, disco: r.disco,
      tariffBand: r.tariff_band,
      darPct: +(+r.dar_pct).toFixed(1),
      currentUptimeH: +(+r.current_uptime_h).toFixed(1),
      voltageUptimeH: +(+r.voltage_uptime_h).toFixed(1),
      compliancePct: compliance,
      status: compliance >= +cfg.compliance_met_pct ? 'Met' : 'Not Met',
    };
  });
  const byDisco = {};
  feeders.forEach((f) => {
    const k = f.disco || 'Unassigned';
    (byDisco[k] = byDisco[k] || []).push(f);
  });
  const discos = Object.entries(byDisco).map(([disco, list]) => ({
    disco,
    feeders: list.length,
    avgCompliancePct: +(list.reduce((a, f) => a + f.compliancePct, 0) / list.length).toFixed(1),
    avgDarPct: +(list.reduce((a, f) => a + f.darPct, 0) / list.length).toFixed(1),
    met: list.filter((f) => f.status === 'Met').length,
  }));
  res.json({ date, metThresholdPct: +cfg.compliance_met_pct, discos, feeders });
}));

// ---------------------------------------------------------------------------
// GET /api/nerc/sbt-scorecard?date=&disco=&band=
// Service-Based Tariff compliance: for each feeder, actual supply hours vs
// its Band's NERC-mandated minimum, consecutive shortfall days, and an
// early-warning flag matching NERC's own Band-A order (explanation due
// after N days, downgrade risk after M days). Also estimates revenue
// exposure from the shortfall using the feeder's OWN measured average load
// today (never a guessed customer count) times a configurable Band tariff.
// This is the core "regulator can't operate without this" feature: it
// turns raw telemetry into the exact compliance question NERC has to
// answer for every Band A feeder, automatically, every day.
// ---------------------------------------------------------------------------
router.get('/sbt-scorecard', ah(async (req, res) => {
  res.json(await computeSbtScorecard(req));
}));

async function computeSbtScorecard(req) {
  const cfg = await getSettings();
  const date = isDate(req.query.date) ? req.query.date : new Date().toISOString().slice(0, 10);
  const minHours = { A: +cfg.sbt_hours_band_a, B: +cfg.sbt_hours_band_b, C: +cfg.sbt_hours_band_c,
    D: +cfg.sbt_hours_band_d, E: +cfg.sbt_hours_band_e };
  const tariff = { A: +cfg.sbt_tariff_band_a, B: +cfg.sbt_tariff_band_b, C: +cfg.sbt_tariff_band_c,
    D: +cfg.sbt_tariff_band_d, E: +cfg.sbt_tariff_band_e };
  const explanationDays = +cfg.sbt_explanation_days;
  const downgradeDays = +cfg.sbt_downgrade_days;

  const params = [];
  const discoCond = filterCond(req, params, 's');
  const feedersRes = await pool.query(`
    SELECT s.meter_id, s.feeder_name, s.disco, s.tariff_band, s.expected_interval_s, s.power_unit
    FROM v_meter_status s
    WHERE s.tariff_band IS NOT NULL ${discoCond}
    ORDER BY s.disco NULLS LAST, s.feeder_name`, params);
  const feeders = feedersRes.rows;
  if (feeders.length === 0) {
    return { date, minHours, tariff, explanationDays, downgradeDays, discos: [], feeders: [] };
  }
  const meterIds = feeders.map((f) => f.meter_id);

  // 14 trailing days of uptime, to count consecutive shortfall days ending
  // at `date` without a separate query per feeder.
  const daily = await pool.query(`
    SELECT meter_id, time_bucket('1 day', bucket)::date AS day, sum(current_on_count) AS on_count
    FROM agg_nerc_15min
    WHERE meter_id = ANY($1) AND bucket >= $2::date - INTERVAL '13 days' AND bucket < $2::date + INTERVAL '1 day'
    GROUP BY meter_id, day`, [meterIds, date]);
  const byMeterDay = {};
  daily.rows.forEach((r) => {
    const k = r.meter_id;
    (byMeterDay[k] = byMeterDay[k] || {})[r.day.toISOString().slice(0, 10)] = +r.on_count;
  });

  // Today's average measured load — the real, defensible basis for the
  // revenue estimate (no assumed customer counts).
  const power = await pool.query(`
    SELECT meter_id, avg(avg_active_power) AS avg_power
    FROM agg_15min
    WHERE meter_id = ANY($1) AND bucket >= $2::date AND bucket < $2::date + interval '1 day'
      AND received_count > 0
    GROUP BY meter_id`, [meterIds, date]);
  const avgPowerByMeter = {};
  power.rows.forEach((r) => { avgPowerByMeter[r.meter_id] = +r.avg_power; });

  const dayList = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - i);
    dayList.push(d.toISOString().slice(0, 10));
  }

  const scored = feeders.map((f) => {
    const band = f.tariff_band;
    const need = minHours[band];
    const hoursFor = (day) => {
      const onCount = (byMeterDay[f.meter_id] || {})[day];
      if (onCount == null) return null;
      return Math.min(24, onCount * f.expected_interval_s / 3600);
    };
    const actualHours = +(hoursFor(date) || 0).toFixed(1);
    const shortfallHours = need != null ? +Math.max(0, need - actualHours).toFixed(1) : null;
    const met = need == null ? null : shortfallHours <= 0;

    // Walk backward from `date` counting consecutive days below that
    // Band's minimum; stops at the first compliant or data-less day.
    let consecutiveShortfallDays = 0;
    for (const day of dayList) {
      const h = hoursFor(day);
      if (h == null || need == null) break;
      if (h < need) consecutiveShortfallDays++;
      else break;
    }

    const avgPowerRaw = avgPowerByMeter[f.meter_id];
    const avgPowerKW = avgPowerRaw != null
      ? (f.power_unit === 'W' ? avgPowerRaw / 1000 : avgPowerRaw) : null;
    const rate = tariff[band];
    const revenueAtRiskNgn = (avgPowerKW != null && shortfallHours != null && rate != null)
      ? +(avgPowerKW * shortfallHours * rate).toFixed(0) : null;

    return {
      meterId: f.meter_id, feeder: f.feeder_name || f.meter_id, disco: f.disco, band,
      minHours: need, actualHours, shortfallHours, met,
      consecutiveShortfallDays,
      explanationDue: met === false && consecutiveShortfallDays >= explanationDays,
      downgradeRisk: met === false && consecutiveShortfallDays >= downgradeDays,
      avgLoadKW: avgPowerKW != null ? +avgPowerKW.toFixed(2) : null,
      revenueAtRiskNgn,
    };
  });

  const byDisco = {};
  scored.forEach((f) => { (byDisco[f.disco || 'Unassigned'] = byDisco[f.disco || 'Unassigned'] || []).push(f); });
  const discos = Object.entries(byDisco).map(([disco, list]) => ({
    disco,
    feeders: list.length,
    met: list.filter((f) => f.met).length,
    notMet: list.filter((f) => f.met === false).length,
    explanationDue: list.filter((f) => f.explanationDue).length,
    downgradeRisk: list.filter((f) => f.downgradeRisk).length,
    revenueAtRiskNgn: list.some((f) => f.revenueAtRiskNgn != null)
      ? list.reduce((a, f) => a + (f.revenueAtRiskNgn || 0), 0) : null,
  })).sort((a, b) => a.disco.localeCompare(b.disco));

  return { date, minHours, tariff, explanationDays, downgradeDays, discos, feeders: scored };
}

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
// GET /api/nerc/report/daily-compliant?date=YYYY-MM-DD&disco=   (.xlsx)
// ---------------------------------------------------------------------------
router.get('/report/daily-compliant', ah(async (req, res) => {
  const cfg = await getSettings();
  const date = isDate(req.query.date) ? req.query.date : new Date().toISOString().slice(0, 10);
  const params = [date];
  const discoCond = filterCond(req, params, 's');
  const { rows } = await pool.query(`
    SELECT s.disco, s.feeder_name, s.station, s.mother_feeder, s.tariff_band, s.expected_interval_s,
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
    WHERE 1=1 ${discoCond}
    ORDER BY s.disco NULLS LAST, s.feeder_name`, params);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  sheetHeader(ws, 'Compliant Feeders Report',
    `${date} 00:00 - 23:59` + (req.query.disco && req.query.disco !== 'all' ? ` (${req.query.disco})` : ' (All DisCos)')
      + (req.query.band && req.query.band !== 'all' ? ` — Band ${req.query.band}` : ''),
    ['S/N', 'Disco', 'Name', 'Station', 'Mother Feeder / Station', 'Tariff Band', 'Current Uptime (Hrs)',
     'Voltage Uptime (Hrs)', 'DAR (%)', 'Power (MW)', 'Consumption (KWh)',
     'Compliance (%)', 'Compliance Status']);
  rows.forEach((r, i) => {
    const kwh = r.energy_unit === 'Wh' ? +r.consumption_raw / 1000 : +r.consumption_raw;
    const curH = Math.min(24, +r.current_uptime_h);
    const compliance = +(curH / 24 * 100).toFixed(1);
    ws.addRow([i + 1, r.disco || 'N/A', r.feeder_name || r.meter_id, r.station || 'N/A',
      r.mother_feeder || 'N/A', r.tariff_band || 'N/A', +curH.toFixed(1),
      +Math.min(24, +r.voltage_uptime_h).toFixed(1), +(+r.dar_pct).toFixed(1),
      +(kwh / 24 / 1000).toFixed(2), Math.round(kwh), compliance,
      compliance >= +cfg.compliance_met_pct ? 'Met' : 'Not Met']);
  });
  ws.columns.forEach((c) => { c.width = 18; });
  await sendWb(res, wb, `Daily Compliant Feeders Report ${date}.xlsx`);
}));

// ---------------------------------------------------------------------------
// GET /api/nerc/report/data-acquisition?from=&to=&disco=   (.xlsx, per-day DAR)
// ---------------------------------------------------------------------------
router.get('/report/data-acquisition', ah(async (req, res) => {
  const { from, to } = req.query;
  if (!isDate(from) || !isDate(to)) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) required' });
  const params = [];
  const discoCond = filterCond(req, params, '', 'WHERE');
  const meters = await pool.query(`
    SELECT meter_id, disco, feeder_name, station, category, state, voltage_class, tariff_band
    FROM v_meter_status${discoCond} ORDER BY disco NULLS LAST, feeder_name`, params);
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
  sheetHeader(ws, 'Data Acquisition Report',
    `${from} - ${to}` + (req.query.disco && req.query.disco !== 'all' ? ` (${req.query.disco})` : ' (All DisCos)')
      + (req.query.band && req.query.band !== 'all' ? ` — Band ${req.query.band}` : ''),
    ['S/N', 'Disco', 'Feeder Name', 'Station', 'Feeder Category', 'State', 'Voltage Class', 'Tariff Band',
     ...days.map(fmtDay)]);
  meters.rows.forEach((m, i) => {
    ws.addRow([i + 1, m.disco || 'N/A', m.feeder_name || m.meter_id, m.station || 'N/A',
      m.category || 'N/A', m.state || 'N/A', m.voltage_class || 'N/A', m.tariff_band || 'N/A',
      ...days.map((d) => {
        const v = (byMeter[m.meter_id] || {})[d.toISOString().slice(0, 10)];
        return v === undefined ? 0 : +v.toFixed(1);
      })]);
  });
  ws.columns.forEach((c, i) => { c.width = i < 8 ? 20 : 9; });
  await sendWb(res, wb, `Data Acquisition Report ${from} to ${to}.xlsx`);
}));

// ---------------------------------------------------------------------------
// GET /api/nerc/report/month-to-date?month=YYYY-MM&disco=  (.xlsx, per-day current-uptime hours)
// ---------------------------------------------------------------------------
router.get('/report/month-to-date', ah(async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '')
    ? req.query.month : new Date().toISOString().slice(0, 7);
  const from = month + '-01';
  const params = [];
  const discoCond = filterCond(req, params, 's', 'WHERE');
  const meters = await pool.query(`
    SELECT s.meter_id, s.disco, s.feeder_name, s.category, s.mother_feeder, s.expected_interval_s, s.tariff_band
    FROM v_meter_status s${discoCond} ORDER BY s.disco NULLS LAST, s.feeder_name`, params);
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
  sheetHeader(ws, 'Month To Date Report',
    `${from} - ${last.toISOString().slice(0, 10)}` + (req.query.disco && req.query.disco !== 'all' ? ` (${req.query.disco})` : ' (All DisCos)')
      + (req.query.band && req.query.band !== 'all' ? ` — Band ${req.query.band}` : ''),
    ['S/N', 'Feeder Name', 'Category', 'Mother Feeder / Station', 'Disco', 'Tariff Band', ...days.map(fmtDay)]);
  meters.rows.forEach((m, i) => {
    ws.addRow([i + 1, m.feeder_name || m.meter_id, m.category || 'N/A',
      m.mother_feeder || 'N/A', m.disco || 'N/A', m.tariff_band || 'N/A',
      ...days.map((d) => {
        const c = (byMeter[m.meter_id] || {})[d.toISOString().slice(0, 10)] || 0;
        return Math.min(24, Math.round(c * m.expected_interval_s / 3600));
      })]);
  });
  ws.columns.forEach((c, i) => { c.width = i < 6 ? 20 : 8; });
  await sendWb(res, wb, `Month To Date Report ${month}.xlsx`);
}));

// ---------------------------------------------------------------------------
// GET /api/nerc/report/sbt-scorecard?date=&disco=&band=  (.xlsx)
// Downloadable version of the SBT Compliance Scorecard above, in the same
// regulator-report style as the other three exports.
// ---------------------------------------------------------------------------
router.get('/report/sbt-scorecard', ah(async (req, res) => {
  const result = await computeSbtScorecard(req);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  sheetHeader(ws, 'SBT Compliance Scorecard',
    `${result.date}` + (req.query.disco && req.query.disco !== 'all' ? ` (${req.query.disco})` : ' (All DisCos)')
      + (req.query.band && req.query.band !== 'all' ? ` — Band ${req.query.band}` : ''),
    ['S/N', 'Disco', 'Feeder Name', 'Band', 'Min Hours (NERC)', 'Actual Hours', 'Shortfall (Hrs)',
     'Status', 'Consecutive Shortfall Days', 'Explanation Due', 'Downgrade Risk',
     'Avg Load (kW)', 'Est. Revenue at Risk (NGN)']);
  result.feeders.forEach((f, i) => {
    ws.addRow([i + 1, f.disco || 'N/A', f.feeder, f.band, f.minHours, f.actualHours, f.shortfallHours,
      f.met ? 'Met' : 'Not Met', f.consecutiveShortfallDays,
      f.explanationDue ? 'YES' : '', f.downgradeRisk ? 'YES' : '',
      f.avgLoadKW != null ? f.avgLoadKW : 'N/A',
      f.revenueAtRiskNgn != null ? f.revenueAtRiskNgn : 'N/A']);
  });
  ws.columns.forEach((c, i) => { c.width = i < 3 ? 20 : 14; });
  await sendWb(res, wb, `SBT Compliance Scorecard ${result.date}.xlsx`);
}));

module.exports = router;
