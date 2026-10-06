// hooks.js - receives EMQX webhook events (client.connected / client.disconnected)
// and stores them in meter_events for connectivity auditing.
// Protected by a shared secret header, NOT by JWT (EMQX is the caller).
require('dotenv').config();
const express = require('express');
const pool = require('./db');

const router = express.Router();
const SECRET = process.env.EMQX_WEBHOOK_SECRET || '';

router.post('/emqx', async (req, res) => {
  if (SECRET && req.headers['x-webhook-secret'] !== SECRET) {
    return res.status(401).json({ error: 'bad webhook secret' });
  }
  try {
    const e = req.body || {};
    const event = e.event === 'client.connected' ? 'connected'
                : e.event === 'client.disconnected' ? 'disconnected' : null;
    const clientId = e.clientid;
    if (event && clientId && clientId.indexOf('protogy-') !== 0) {
      await pool.query(
        `INSERT INTO meter_events (meter_id, event, detail) VALUES ($1,$2,$3)`,
        [clientId, event, JSON.stringify({ reason: e.reason || null, node: e.node || null })]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
