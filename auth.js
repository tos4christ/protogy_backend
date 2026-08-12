// auth.js - JWT authentication + role middleware
require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./db');

const SECRET = process.env.JWT_SECRET;
if (!SECRET) { console.error('FATAL: JWT_SECRET not set in .env'); process.exit(1); }
const TOKEN_TTL = process.env.JWT_TTL || '12h';

const router = express.Router();

// POST /api/auth/login  { username, password } -> { token, role }
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const { rows } = await pool.query('SELECT * FROM app_users WHERE username = $1', [username]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    await pool.query('UPDATE app_users SET last_login_at = now() WHERE username = $1', [username]);
    const token = jwt.sign({ sub: user.username, role: user.role }, SECRET, { expiresIn: TOKEN_TTL });
    res.json({ token, username: user.username, role: user.role });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/users  (admin only) { username, password, role }
router.post('/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO app_users (username, password_hash, role) VALUES ($1,$2,$3)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, role = $3`,
      [username, hash, role === 'admin' ? 'admin' : 'user']);
    res.status(201).json({ username, role: role === 'admin' ? 'admin' : 'user' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Middleware: verify JWT from Authorization header or ?token= (for CSV download links)
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

// Middleware: admin-only actions (e.g. onboarding meters)
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator role required' });
  }
  next();
}


// GET /api/auth/users  (admin only) - list all users
router.get('/users', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT username, role, created_at, last_login_at FROM app_users ORDER BY username');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/auth/users/:username  (admin only)
// Guards: cannot delete yourself; cannot delete the last remaining admin.
router.delete('/users/:username', requireAuth, requireAdmin, async (req, res) => {
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
    res.json({ username: target, action: 'deleted' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, requireAuth, requireAdmin };
