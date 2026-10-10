// auth.js - JWT authentication + role middleware + account management.
//
// Account model (NERC RBAC): account_type is one of
//   protogy_admin - full access + user management
//   protogy_user  - full view access, no user management
//   nerc          - full view access (national regulator), no admin
//   state_nerc    - view access scoped to one or more states
//   disco         - view access scoped to a single DisCo
// `role` ('admin'/'user') is kept alongside account_type purely so the
// existing requireAdmin()-gated routes elsewhere in the app (ami.js,
// routes.js onboarding/delete) keep working unchanged: only protogy_admin
// ever gets role='admin'.
require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./db');
const audit = require('./audit');

const SECRET = process.env.JWT_SECRET;
if (!SECRET) { console.error('FATAL: JWT_SECRET not set in .env'); process.exit(1); }
const TOKEN_TTL = process.env.JWT_TTL || '12h';

const router = express.Router();

const ACCOUNT_TYPES = ['protogy_admin', 'protogy_user', 'nerc', 'state_nerc', 'disco'];
const legacyRole = (accountType) => (accountType === 'protogy_admin' ? 'admin' : 'user');

// Middleware: verify JWT from Authorization header or ?token= (for CSV/xlsx
// download links), and reject a token belonging to a since-deactivated
// account even if the JWT itself hasn't expired yet.
// Declared here, ahead of every route below that uses it (requireAuth /
// requireAdmin are referenced as soon as the router.* calls run, not just
// when a request comes in - a `const` alias declared further down the file
// would still be in its temporal dead zone at that point).
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Middleware: Protogy Admin only (user management, meter onboarding/config,
// settings). Kept as `requireAdmin` for backward compatibility with every
// existing call site (ami.js, routes.js, settings.js); `requireProtogyAdmin`
// is the same function under its clearer RBAC-era name for new code.
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator role required' });
  }
  next();
}
const requireProtogyAdmin = requireAdmin;

// Validates { accountType, disco, states } together. Returns an error
// string, or null if valid. Centralized so create and update can't drift.
function validateAccountShape({ accountType, disco, states }) {
  if (!ACCOUNT_TYPES.includes(accountType)) {
    return `accountType must be one of: ${ACCOUNT_TYPES.join(', ')}`;
  }
  if (accountType === 'disco' && !disco) {
    return 'disco is required for a DisCo account';
  }
  if (accountType === 'state_nerc' && (!Array.isArray(states) || states.length === 0)) {
    return 'states (one or more) is required for a State NERC account';
  }
  return null;
}

// POST /api/auth/login  { username, password } -> { token, username, accountType, disco, states }
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const { rows } = await pool.query('SELECT * FROM app_users WHERE username = $1', [username]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      await audit.log(req, 'login_failed', { target: username });
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    if (!user.is_active) {
      await audit.log(req, 'login_failed', { target: username, detail: { reason: 'deactivated' } });
      return res.status(403).json({ error: 'This account has been deactivated' });
    }
    await pool.query('UPDATE app_users SET last_login_at = now() WHERE username = $1', [username]);
    const payload = {
      sub: user.username,
      role: user.role,                 // legacy, see header note
      accountType: user.account_type,
      disco: user.disco || null,
      states: user.states || null,
    };
    const token = jwt.sign(payload, SECRET, { expiresIn: TOKEN_TTL });
    req.user = payload; // so the audit log below attributes to this user, not null
    await audit.log(req, 'login_success');
    res.json({
      token,
      username: user.username,
      role: user.role,
      accountType: user.account_type,
      disco: user.disco || null,
      states: user.states || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/logout - client just discards the token; this only exists
// so a logout is captured in the audit trail.
router.post('/logout', requireAuth, async (req, res) => {
  await audit.log(req, 'logout');
  res.json({ ok: true });
});

// POST /api/auth/users  (Protogy Admin only) - create or update an account.
// { username, password, accountType, disco?, states?, fullName? }
router.post('/users', requireAuth, requireProtogyAdmin, async (req, res) => {
  try {
    const { username, password, accountType, disco, states, fullName } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const shapeErr = validateAccountShape({ accountType, disco, states });
    if (shapeErr) return res.status(400).json({ error: shapeErr });

    const { rows: existingRows } = await pool.query('SELECT username FROM app_users WHERE username = $1', [username]);
    const isUpdate = existingRows.length > 0;

    const hash = await bcrypt.hash(password, 10);
    const role = legacyRole(accountType);
    const discoVal = accountType === 'disco' ? disco : null;
    const statesVal = accountType === 'state_nerc' ? states : null;

    await pool.query(
      `INSERT INTO app_users (username, password_hash, role, account_type, disco, states, full_name, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true)
       ON CONFLICT (username) DO UPDATE SET
         password_hash = $2, role = $3, account_type = $4, disco = $5, states = $6, full_name = $7`,
      [username, hash, role, accountType, discoVal, statesVal, fullName || null]
    );
    await audit.log(req, isUpdate ? 'user_updated' : 'user_created', {
      target: username,
      detail: { accountType, disco: discoVal, states: statesVal },
    });
    res.status(201).json({ username, role, accountType, disco: discoVal, states: statesVal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/auth/users/:username/password  (Protogy Admin only) - reset a
// user's password without re-entering their other account details.
router.patch('/users/:username/password', requireAuth, requireProtogyAdmin, async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'password required' });
    const hash = await bcrypt.hash(password, 10);
    const { rowCount } = await pool.query(
      'UPDATE app_users SET password_hash = $1 WHERE username = $2', [hash, req.params.username]);
    if (rowCount === 0) return res.status(404).json({ error: 'user not found' });
    await audit.log(req, 'password_reset', { target: req.params.username });
    res.json({ username: req.params.username, action: 'password_reset' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/auth/me/password - any authenticated user changes their own
// password (self-service, per the NERC request's "password reset/change
// functionality where applicable" for DisCo users).
router.patch('/me/password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword required' });
    }
    const { rows } = await pool.query('SELECT * FROM app_users WHERE username = $1', [req.user.sub]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE app_users SET password_hash = $1 WHERE username = $2', [hash, req.user.sub]);
    await audit.log(req, 'password_reset', { target: req.user.sub, detail: { selfService: true } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/auth/users/:username/status  (Protogy Admin only) { active: true|false }
// Activate/deactivate without deleting - preserves history, NERC item 4.
router.patch('/users/:username/status', requireAuth, requireProtogyAdmin, async (req, res) => {
  try {
    const { active } = req.body || {};
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'active (boolean) required' });
    if (req.params.username === req.user.sub && active === false) {
      return res.status(400).json({ error: 'You cannot deactivate your own account' });
    }
    const { rowCount } = await pool.query(
      'UPDATE app_users SET is_active = $1 WHERE username = $2', [active, req.params.username]);
    if (rowCount === 0) return res.status(404).json({ error: 'user not found' });
    await audit.log(req, active ? 'user_reactivated' : 'user_deactivated', { target: req.params.username });
    res.json({ username: req.params.username, isActive: active });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/auth/users  (Protogy Admin only) - list all accounts
router.get('/users', requireAuth, requireProtogyAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT username, role, account_type, disco, states, full_name, is_active, created_at, last_login_at
       FROM app_users ORDER BY account_type, username`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/auth/audit-log  (Protogy Admin only) - recent audit trail.
// ?limit=200&username=&action=
router.get('/audit-log', requireAuth, requireProtogyAdmin, async (req, res) => {
  try {
    const limit = Math.min(1000, Math.max(1, +req.query.limit || 200));
    const conds = [];
    const params = [];
    if (req.query.username) { params.push(req.query.username); conds.push(`username = $${params.length}`); }
    if (req.query.action) { params.push(req.query.action); conds.push(`action = $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT * FROM audit_log ${where} ORDER BY at DESC LIMIT $${params.length}`, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/auth/users/:username  (Protogy Admin only)
// Guards: cannot delete yourself; cannot delete the last remaining Protogy Admin.
// Prefer deactivating (PATCH .../status) over deleting where possible, so the
// audit trail keeps a readable username on historical entries.
router.delete('/users/:username', requireAuth, requireProtogyAdmin, async (req, res) => {
  try {
    const target = req.params.username;
    if (target === req.user.sub) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }
    const t = await pool.query('SELECT role FROM app_users WHERE username = $1', [target]);
    if (t.rows.length === 0) return res.status(404).json({ error: 'user not found' });
    if (t.rows[0].role === 'admin') {
      const admins = await pool.query("SELECT count(*) AS n FROM app_users WHERE role = 'admin'");
      if (+admins.rows[0].n <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last administrator' });
      }
    }
    await pool.query('DELETE FROM app_users WHERE username = $1', [target]);
    await audit.log(req, 'user_deleted', { target });
    res.json({ username: target, action: 'deleted' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, requireAuth, requireAdmin, requireProtogyAdmin, ACCOUNT_TYPES };
