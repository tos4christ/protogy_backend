// ============================================================================
// ami.js — PROTOGY AMI (prepaid customer) module. Place in backend\ami.js
// Mounted at /api/ami — completely separate from staff routes, so nothing
// existing changes. Three access levels:
//   1. Customers  — JWT with role 'customer' (own login endpoints)
//   2. Devices    — x-meter-key header (per-meter API key, REST not MQTT)
//   3. Staff admin— existing staff JWT (register meters/customers)
// ============================================================================
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./db');
const { requireAuth, requireAdmin } = require('./auth');

const SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = process.env.JWT_TTL || '12h';
const router = express.Router();

const ah = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error('[ami]', req.method, req.originalUrl, err.message);
  res.status(500).json({ error: err.message });
});

// ---------- middleware ------------------------------------------------------
function requireCustomer(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, SECRET);
    if (payload.role !== 'customer') return res.status(403).json({ error: 'Customer account required' });
    req.customer = payload; // { sub: customer_id, role, name }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function requireMeterKey(req, res, next) {
  const key = req.headers['x-meter-key'];
  if (!key) return res.status(401).json({ error: 'x-meter-key header required' });
  const { rows } = await pool.query(
    `SELECT meter_serial, status FROM prepaid_meters WHERE api_key = $1`, [key]);
  if (rows.length === 0) return res.status(401).json({ error: 'invalid meter key' });
  if (rows[0].status === 'decommissioned') return res.status(403).json({ error: 'meter decommissioned' });
  req.meterSerial = rows[0].meter_serial;
  next();
}

// Customer may only touch their own meters
async function ownMeter(req, res) {
  const { rows } = await pool.query(
    `SELECT * FROM prepaid_meters WHERE meter_serial = $1 AND customer_id = $2`,
    [req.params.serial, +req.customer.sub]);
  if (rows.length === 0) { res.status(404).json({ error: 'meter not found on your account' }); return null; }
  return rows[0];
}

const genToken = () => Array.from({ length: 20 }, () => crypto.randomInt(10)).join('');
const genApiKey = () => crypto.randomBytes(24).toString('hex');

// ============================================================================
// 1. CUSTOMER AUTH
// ============================================================================
// POST /api/ami/auth/login  { phone, password }
router.post('/auth/login', ah(async (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: 'phone and password required' });
  const { rows } = await pool.query('SELECT * FROM customers WHERE phone = $1', [phone]);
  const c = rows[0];
  if (!c || !(await bcrypt.compare(password, c.password_hash))) {
    return res.status(401).json({ error: 'Invalid phone number or password' });
  }
  await pool.query('UPDATE customers SET last_login_at = now() WHERE customer_id = $1', [c.customer_id]);
  const token = jwt.sign({ sub: String(c.customer_id), role: 'customer', name: c.full_name },
    SECRET, { expiresIn: TOKEN_TTL });
  res.json({ token, name: c.full_name, phone: c.phone });
}));

// POST /api/ami/auth/register  { fullName, phone, password, meterSerial }
// Self-service: works only if the meter exists and is not yet linked.
router.post('/auth/register', ah(async (req, res) => {
  const { fullName, phone, password, meterSerial } = req.body || {};
  if (!fullName || !phone || !password || !meterSerial) {
    return res.status(400).json({ error: 'fullName, phone, password, meterSerial required' });
  }
  if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
  const m = await pool.query('SELECT customer_id FROM prepaid_meters WHERE meter_serial = $1', [meterSerial]);
  if (m.rows.length === 0) return res.status(404).json({ error: 'meter serial not found — contact support' });
  if (m.rows[0].customer_id) return res.status(409).json({ error: 'meter already linked to an account' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hash = await bcrypt.hash(password, 10);
    const c = await client.query(
      `INSERT INTO customers (full_name, phone, password_hash) VALUES ($1,$2,$3)
       RETURNING customer_id, full_name, phone`, [fullName, phone, hash]);
    await client.query(
      `UPDATE prepaid_meters SET customer_id = $1 WHERE meter_serial = $2`,
      [c.rows[0].customer_id, meterSerial]);
    await client.query('COMMIT');
    const token = jwt.sign({ sub: String(c.rows[0].customer_id), role: 'customer', name: fullName },
      SECRET, { expiresIn: TOKEN_TTL });
    res.status(201).json({ token, name: fullName, phone });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'phone number already registered' });
    throw e;
  } finally { client.release(); }
}));

// ============================================================================
// 2. CUSTOMER PORTAL ENDPOINTS (JWT role customer)
// ============================================================================
// GET /api/ami/me — profile + meters + balances
router.get('/me', requireCustomer, ah(async (req, res) => {
  const cid = +req.customer.sub;
  const [c, m] = await Promise.all([
    pool.query('SELECT customer_id, full_name, phone, email, address, disco FROM customers WHERE customer_id = $1', [cid]),
    pool.query(
      `SELECT meter_serial, tariff_naira_kwh, balance_kwh, status, last_seen_at,
              CASE WHEN last_seen_at > now() - interval '10 minutes' THEN 'online' ELSE 'offline' END AS connectivity
       FROM prepaid_meters WHERE customer_id = $1 ORDER BY meter_serial`, [cid]),
  ]);
  res.json({ ...c.rows[0], meters: m.rows });
}));

// GET /api/ami/meters/:serial/usage?days=30 — daily kWh for charts
router.get('/meters/:serial/usage', requireCustomer, ah(async (req, res) => {
  const meter = await ownMeter(req, res); if (!meter) return;
  const days = Math.min(366, Math.max(1, +(req.query.days || 30)));
  const { rows } = await pool.query(
    `SELECT day::date AS day, round(kwh_used::numeric,3) AS kwh_used,
            round(avg_power_w::numeric,1) AS avg_power_w,
            round(avg_voltage::numeric,1) AS avg_voltage,
            round(end_balance_kwh::numeric,3) AS end_balance_kwh
     FROM ami_daily_usage
     WHERE meter_serial = $1 AND day >= current_date - $2::int
     ORDER BY day`, [meter.meter_serial, days]);
  const totalKwh = rows.reduce((s, r) => s + (+r.kwh_used || 0), 0);
  res.json({
    meterSerial: meter.meter_serial, days,
    totalKwh: +totalKwh.toFixed(3),
    estimatedCostNaira: +(totalKwh * +meter.tariff_naira_kwh).toFixed(2),
    tariffNairaPerKwh: +meter.tariff_naira_kwh,
    daily: rows,
  });
}));

// GET /api/ami/meters/:serial/transactions — billing/purchase history
router.get('/meters/:serial/transactions', requireCustomer, ah(async (req, res) => {
  const meter = await ownMeter(req, res); if (!meter) return;
  const { rows } = await pool.query(
    `SELECT txn_id, amount_naira, kwh, token, status, provider, created_at, applied_at
     FROM credit_transactions WHERE meter_serial = $1
     ORDER BY created_at DESC LIMIT 100`, [meter.meter_serial]);
  res.json({ meterSerial: meter.meter_serial, transactions: rows });
}));

// POST /api/ami/meters/:serial/purchase  { amountNaira }
// DEMO payment flow: records the purchase immediately as 'paid' and issues a
// token. To go live, integrate a gateway (e.g. Paystack): initialize payment
// here with status 'pending', then move to 'paid' in the gateway webhook.
router.post('/meters/:serial/purchase', requireCustomer, ah(async (req, res) => {
  const meter = await ownMeter(req, res); if (!meter) return;
  const amount = +(req.body || {}).amountNaira;
  if (!Number.isFinite(amount) || amount < 100) {
    return res.status(400).json({ error: 'amountNaira must be at least 100' });
  }
  const kwh = +(amount / +meter.tariff_naira_kwh).toFixed(3);
  const token = genToken();
  const { rows } = await pool.query(
    `INSERT INTO credit_transactions (meter_serial, customer_id, amount_naira, kwh, token, status)
     VALUES ($1,$2,$3,$4,$5,'paid') RETURNING txn_id, created_at`,
    [meter.meter_serial, +req.customer.sub, amount, kwh, token]);
  res.status(201).json({
    txnId: rows[0].txn_id, meterSerial: meter.meter_serial,
    amountNaira: amount, kwh, token,
    note: 'Credit will be applied automatically when the meter next syncs, or enter the token on the meter keypad.',
  });
}));

// POST /api/ami/meters/:serial/apply-token  { token }
// Customer manually applies a purchased token to their meter (simulates the
// meter keypad entry / meter sync). Only works on tokens bought for THIS
// meter that are still in 'paid' state; idempotent and safe to retry.
router.post('/meters/:serial/apply-token', requireCustomer, ah(async (req, res) => {
  const meter = await ownMeter(req, res); if (!meter) return;
  const token = String((req.body || {}).token || '').replace(/[^0-9]/g, '');
  if (token.length !== 20) return res.status(400).json({ error: 'Enter the full 20-digit token' });
  const { rows } = await pool.query(
    `UPDATE credit_transactions SET status = 'applied', applied_at = now()
     WHERE meter_serial = $1 AND token = $2 AND status = 'paid'
     RETURNING txn_id, kwh`, [meter.meter_serial, token]);
  if (rows.length === 0) {
    const dup = await pool.query(
      `SELECT status FROM credit_transactions WHERE meter_serial = $1 AND token = $2`,
      [meter.meter_serial, token]);
    if (dup.rows.length && dup.rows[0].status === 'applied') {
      return res.status(409).json({ error: 'This token has already been applied' });
    }
    return res.status(404).json({ error: 'Token not recognised for this meter' });
  }
  const upd = await pool.query(
    `UPDATE prepaid_meters SET balance_kwh = balance_kwh + $2
     WHERE meter_serial = $1 RETURNING balance_kwh`, [meter.meter_serial, rows[0].kwh]);
  res.json({ ok: true, txnId: rows[0].txn_id, kwhAdded: +rows[0].kwh,
             newBalanceKwh: +upd.rows[0].balance_kwh });
}));

// ============================================================================
// 3. DEVICE REST API (the prepaid meter talks to protogyglobal.io here)
//    Auth: header  x-meter-key: <api_key>
// ============================================================================
// POST /api/ami/device/reading
// { ts, energyKwh, powerW, voltage, balanceKwh }
router.post('/device/reading', requireMeterKey, ah(async (req, res) => {
  const b = req.body || {};
  const ts = b.ts ? new Date(b.ts) : new Date();
  await pool.query(
    `INSERT INTO prepaid_readings (meter_serial, ts, energy_kwh, power_w, voltage, balance_kwh)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (meter_serial, ts) DO NOTHING`,
    [req.meterSerial, ts.toISOString(), b.energyKwh ?? null, b.powerW ?? null,
     b.voltage ?? null, b.balanceKwh ?? null]);
  await pool.query(
    `UPDATE prepaid_meters SET last_seen_at = now(),
        balance_kwh = COALESCE($2, balance_kwh)
     WHERE meter_serial = $1`, [req.meterSerial, b.balanceKwh ?? null]);
  res.json({ ok: true });
}));

// GET /api/ami/device/credits — meter polls for unapplied credit tokens
router.get('/device/credits', requireMeterKey, ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT txn_id, kwh, token FROM credit_transactions
     WHERE meter_serial = $1 AND status = 'paid' ORDER BY created_at`, [req.meterSerial]);
  res.json({ meterSerial: req.meterSerial, pendingCredits: rows });
}));

// POST /api/ami/device/credits/:txnId/ack — meter confirms it loaded the credit
router.post('/device/credits/:txnId/ack', requireMeterKey, ah(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE credit_transactions SET status = 'applied', applied_at = now()
     WHERE txn_id = $1 AND meter_serial = $2 AND status = 'paid'
     RETURNING txn_id, kwh`, [+req.params.txnId, req.meterSerial]);
  if (rows.length === 0) return res.status(404).json({ error: 'transaction not found or already applied' });
  await pool.query(
    `UPDATE prepaid_meters SET balance_kwh = balance_kwh + $2 WHERE meter_serial = $1`,
    [req.meterSerial, rows[0].kwh]);
  res.json({ ok: true, applied: rows[0] });
}));

// ============================================================================
// 4. STAFF ADMIN (existing staff JWT + admin role)
// ============================================================================
// POST /api/ami/admin/meters { meterSerial, tariffNairaPerKwh }
// Registers a prepaid meter and returns its device api_key ONCE — flash it.
router.post('/admin/meters', requireAuth, requireAdmin, ah(async (req, res) => {
  const { meterSerial, tariffNairaPerKwh } = req.body || {};
  if (!meterSerial) return res.status(400).json({ error: 'meterSerial required' });
  const apiKey = genApiKey();
  const { rows } = await pool.query(
    `INSERT INTO prepaid_meters (meter_serial, api_key, tariff_naira_kwh)
     VALUES ($1,$2,COALESCE($3,68.00))
     ON CONFLICT (meter_serial) DO UPDATE SET tariff_naira_kwh = COALESCE($3, prepaid_meters.tariff_naira_kwh)
     RETURNING meter_serial, tariff_naira_kwh, registered_at,
       (api_key = $2) AS key_is_new`,
    [meterSerial, apiKey, tariffNairaPerKwh]);
  res.status(201).json({
    ...rows[0],
    apiKey: rows[0].key_is_new ? apiKey : undefined,
    note: rows[0].key_is_new ? 'Store this apiKey now — it is not shown again.'
                             : 'Existing meter updated; api key unchanged.',
  });
}));

// GET /api/ami/admin/meters — list prepaid meters with owners
router.get('/admin/meters', requireAuth, requireAdmin, ah(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT p.meter_serial, p.tariff_naira_kwh, p.balance_kwh, p.status, p.last_seen_at,
            c.full_name, c.phone
     FROM prepaid_meters p LEFT JOIN customers c USING (customer_id)
     ORDER BY p.meter_serial`);
  res.json(rows);
}));

// ============================================================================
// 5. PREPAID METER LIFECYCLE + BUILT-IN SIMULATOR (admin, no terminal needed)
// ============================================================================
// PATCH /api/ami/admin/meters/:serial/status  { status: "active"|"disconnected" }
router.patch('/admin/meters/:serial/status', requireAuth, requireAdmin, ah(async (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'disconnected'].includes(status)) {
    return res.status(400).json({ error: "status must be 'active' or 'disconnected'" });
  }
  const { rows } = await pool.query(
    `UPDATE prepaid_meters SET status = $2 WHERE meter_serial = $1
     RETURNING meter_serial, status`, [req.params.serial, status]);
  if (rows.length === 0) return res.status(404).json({ error: 'meter not found' });
  if (status === 'disconnected') stopSim(req.params.serial);
  res.json(rows[0]);
}));

// Server-side simulator: generates readings like a real meter so the portal
// (online status, usage chart, balance countdown) works with zero hardware.
const sims = new Map(); // serial -> interval handle

async function simTick(serial) {
  try {
    const m = await pool.query(
      `SELECT balance_kwh, status FROM prepaid_meters WHERE meter_serial = $1`, [serial]);
    if (m.rows.length === 0 || m.rows[0].status !== 'active') return stopSim(serial);
    const last = await pool.query(
      `SELECT energy_kwh FROM prepaid_readings WHERE meter_serial = $1
       ORDER BY ts DESC LIMIT 1`, [serial]);
    const prevEnergy = last.rows.length ? +last.rows[0].energy_kwh : 1000;
    const powerW = 600 + Math.random() * 900;              // typical household load
    const kwhUsed = powerW * 30 / 3600000;                 // 30s tick
    const newBalance = Math.max(0, +m.rows[0].balance_kwh - kwhUsed);
    const energy = +(prevEnergy + kwhUsed).toFixed(5);
    await pool.query(
      `INSERT INTO prepaid_readings (meter_serial, ts, energy_kwh, power_w, voltage, balance_kwh)
       VALUES ($1, now(), $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [serial, energy, +powerW.toFixed(1), +(228 + Math.random() * 6).toFixed(1),
       +newBalance.toFixed(3)]);
    await pool.query(
      `UPDATE prepaid_meters SET last_seen_at = now(), balance_kwh = $2
       WHERE meter_serial = $1`, [serial, +newBalance.toFixed(3)]);
  } catch (e) { console.error('[ami-sim]', serial, e.message); }
}

function stopSim(serial) {
  if (sims.has(serial)) { clearInterval(sims.get(serial)); sims.delete(serial); }
}

// POST /api/ami/admin/meters/:serial/simulate  { action: "start"|"stop"|"once" }
router.post('/admin/meters/:serial/simulate', requireAuth, requireAdmin, ah(async (req, res) => {
  const serial = req.params.serial;
  const action = (req.body || {}).action;
  const m = await pool.query('SELECT status FROM prepaid_meters WHERE meter_serial = $1', [serial]);
  if (m.rows.length === 0) return res.status(404).json({ error: 'meter not found' });
  if (action === 'start') {
    if (m.rows[0].status !== 'active') return res.status(400).json({ error: 'activate the meter first' });
    if (!sims.has(serial)) {
      await simTick(serial);
      sims.set(serial, setInterval(() => simTick(serial), 30000)); // every 30s
    }
    return res.json({ serial, simulating: true });
  }
  if (action === 'stop') { stopSim(serial); return res.json({ serial, simulating: false }); }
  if (action === 'once') { await simTick(serial); return res.json({ serial, sentOne: true }); }
  res.status(400).json({ error: "action must be 'start', 'stop' or 'once'" });
}));

// expose sim state on the admin list (monkey-patch style: separate endpoint)
router.get('/admin/meters/simulations', requireAuth, requireAdmin, (req, res) => {
  res.json({ simulating: Array.from(sims.keys()) });
});

module.exports = router;
