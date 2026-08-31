// settings.js - platform settings (app_settings table) + REST endpoints.
const express = require('express');
const pool = require('./db');
const { requireAuth, requireAdmin } = require('./auth');

const router = express.Router();
const DEFAULTS = {
  dar_compliance_pct: 95, compliance_met_pct: 95, voltage_tolerance_pct: 10,
  current_flow_threshold: 0.5,
  // Originally 50 (intended as 50 raw Volts) — but voltage_l1/l2/l3 are
  // stored in kV across every payload format (see mqttIngest.js), so the
  // threshold must be expressed in kV too: 0.05 kV = 50V, preserving the
  // original real-world meaning correctly in the unit actually stored.
  voltage_present_threshold: 0.05,
  // Service-Based Tariff (SBT) minimum daily supply hours per NERC Band
  // (NERC Order, effective 3 Apr 2024): A=20h, B=16h, C=12h, D=8h, E=4h.
  sbt_hours_band_a: 20, sbt_hours_band_b: 16, sbt_hours_band_c: 12,
  sbt_hours_band_d: 8, sbt_hours_band_e: 4,
  // Estimated tariff (NGN/kWh) per Band, used ONLY to estimate revenue
  // exposure from a supply shortfall. These vary by DisCo and month under
  // NERC's monthly tariff review — treat as a rough planning figure, not an
  // official rate, and update here to match your DisCo's current order.
  sbt_tariff_band_a: 209.5, sbt_tariff_band_b: 180, sbt_tariff_band_c: 150,
  sbt_tariff_band_d: 80, sbt_tariff_band_e: 40,
  // NERC's Band A order: DisCo must publish an explanation after this many
  // consecutive non-performing days, and the feeder is auto-downgraded
  // after this many. Applied fleet-wide here as an early-warning signal.
  sbt_explanation_days: 2, sbt_downgrade_days: 7,
  // DAR Anomaly Detection thresholds — flags statistically suspicious
  // reporting rather than genuine compliance. Real telemetry over
  // cellular/radio links essentially never sits at exactly 100% for many
  // days straight, jumps by huge margins overnight, or repeats an
  // identical value for a long stretch — these patterns suggest a
  // reporting/integrity issue worth investigating, not a real result.
  anomaly_window_days: 21, anomaly_perfect_days: 10, anomaly_jump_pp: 50, anomaly_flatline_days: 7,
  // Power Quality Analytics — a poor power factor below this is flagged as
  // inefficient (typical utility penalty threshold is 0.85-0.90); a phase
  // current imbalance above this % is flagged as an unbalanced load, both
  // of which are early indicators of equipment stress or wiring faults
  // distinct from simple online/offline connectivity.
  pf_poor_threshold: 0.85, current_imbalance_pct_threshold: 10,
};

async function getSettings() {
  const out = { ...DEFAULTS };
  try {
    const { rows } = await pool.query('SELECT key, value FROM app_settings');
    rows.forEach((r) => { out[r.key] = isNaN(+r.value) ? r.value : +r.value; });
  } catch (e) { /* table absent: defaults */ }
  return out;
}

router.get('/', requireAuth, async (_req, res) => res.json(await getSettings()));

router.put('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    for (const [k, v] of Object.entries(body)) {
      if (!/^[a-z0-9_]+$/.test(k)) continue;
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ($1,$2)
         ON CONFLICT (key) DO UPDATE SET value = $2`, [k, String(v)]);
    }
    res.json(await getSettings());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, getSettings };
