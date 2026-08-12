// settings.js - platform settings (app_settings table) + REST endpoints.
const express = require('express');
const pool = require('./db');
const { requireAuth, requireAdmin } = require('./auth');

const router = express.Router();
const DEFAULTS = {
  dar_compliance_pct: 95, compliance_met_pct: 95, voltage_tolerance_pct: 10,
  current_flow_threshold: 0.5, voltage_present_threshold: 50,
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
