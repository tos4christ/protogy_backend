// audit.js - append-only audit trail, per NERC item 6: user login/logout,
// failed logins, account create/modify/deactivate, data access, report
// generation, data download/export, role/permission changes, admin activity.
//
// Deliberately fire-and-forget: a logging failure must never block the
// actual request. Every call is wrapped so a DB hiccup here can't take down
// a login or a report download.

const pool = require('./db');

const ACTIONS = [
  'login_success', 'login_failed', 'logout',
  'user_created', 'user_updated', 'user_deactivated', 'user_reactivated', 'user_deleted',
  'password_reset', 'role_changed',
  'data_access', 'report_generated', 'data_download',
];

async function log(req, action, { target = null, detail = null } = {}) {
  try {
    const username = req?.user?.sub || (action === 'login_failed' ? (req?.body?.username || null) : null);
    const accountType = req?.user?.accountType || null;
    const ip = req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req?.socket?.remoteAddress || null;
    await pool.query(
      `INSERT INTO audit_log (username, account_type, action, target, detail, ip)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [username, accountType, action, target, detail ? JSON.stringify(detail) : null, ip]
    );
  } catch (e) {
    console.error('[audit] failed to write log entry:', e.message);
  }
}

module.exports = { log, ACTIONS };
