// db.js - PostgreSQL connection pool
require('dotenv').config();
const { Pool, types } = require('pg');

// CRITICAL: node-postgres parses SQL DATE columns (OID 1082) into JS Date
// objects using the SERVER PROCESS's local timezone, not UTC. Any later
// .toISOString() call on that Date silently shifts the day backward
// whenever the server isn't running in UTC — this caused the SBT
// Scorecard (and potentially other date-keyed reports/charts) to look up
// "today"/"yesterday" data under the wrong day and find nothing. Returning
// DATE columns as the raw 'YYYY-MM-DD' string Postgres already sends
// removes the ambiguity everywhere, for every query, including any future
// ones — no per-query casting needed.
types.setTypeParser(1082, (val) => val);

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: +(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'protogy',
  user: process.env.PGUSER || 'protogy_app',
  password: process.env.PGPASSWORD,
  max: 15,
  idleTimeoutMillis: 30000,
  // Fail fast instead of hanging forever when the pool is fully checked
  // out (e.g. a slow/abandoned CSV export holding a connection). Without
  // this, a caller waiting for a free connection -- including login --
  // queues with NO error and NO timeout, which is what caused the
  // 2026-10-31 "unauthorized"-looking outage (it wasn't auth; the login
  // query was just stuck waiting for a connection that never freed up).
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => console.error('PG pool error:', err.message));

// Separate, small pool for long-lived streaming routes (CSV/NERC data
// exports). Those hold a connection for as long as the HTTP response
// takes -- which depends on the client's network speed, not on us -- so
// giving them their own pool means a few slow or abandoned downloads can
// never again starve the main pool that login/dashboard/MQTT ingest
// depend on. See claude/incident-db-connection-pool-exhaustion.md.
const downloadPool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: +(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'protogy',
  user: process.env.PGUSER || 'protogy_app',
  password: process.env.PGPASSWORD,
  max: 4,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
downloadPool.on('error', (err) => console.error('PG download-pool error:', err.message));
pool.downloadPool = downloadPool;

// --- Lightweight, always-on connection-health watch ----------------------
// Automatically runs the same kind of check as the "Connections &
// sessions" section of the sysadmin command reference, every few
// minutes, instead of only after something has already broken.
// Cheap: the in-process pool counts are free (no DB round trip); the
// pg_stat_activity query is one simple query every 5 minutes. Never
// throws, never blocks a request.
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const WARN_BUSY_RATIO = 0.8; // warn once a pool is 80%+ checked out

pool.lastHealthCheck = null;

function snapshotPool(p, name) {
  const max = p.options.max || 10;
  const busy = p.totalCount - p.idleCount;
  const busyRatio = Math.round((busy / max) * 100) / 100;
  if (p.waitingCount > 0) {
    console.error(`[db-health] ${name} pool: ${p.waitingCount} request(s) already queued waiting for a free connection (max=${max}, busy=${busy})`);
  } else if (busyRatio >= WARN_BUSY_RATIO) {
    console.warn(`[db-health] ${name} pool: ${busy}/${max} connections busy (${Math.round(busyRatio * 100)}%)`);
  }
  return { name, max, total: p.totalCount, idle: p.idleCount, waiting: p.waitingCount, busyRatio };
}

async function checkConnectionHealth() {
  const snapshot = {
    checkedAt: new Date().toISOString(),
    pools: [snapshotPool(pool, 'main'), snapshotPool(downloadPool, 'download')],
    server: null,
  };
  try {
    const r = await pool.query(
      "SELECT state, count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() GROUP BY state ORDER BY 2 DESC"
    );
    snapshot.server = r.rows;
    const idleInTxn = r.rows.find((row) => row.state === 'idle in transaction');
    if (idleInTxn && idleInTxn.count > 0) {
      console.warn(`[db-health] ${idleInTxn.count} connection(s) idle in transaction on the server -- these hold locks and can starve the pool.`);
    }
    const total = r.rows.reduce((sum, row) => sum + row.count, 0);
    console.log(`[db-health] server connections: ${total} (${r.rows.map((row) => `${row.state || 'unknown'}=${row.count}`).join(', ')})`);
  } catch (e) {
    // A failed health check should never crash the app or hide the real
    // problem -- just log it and try again next interval.
    console.error('[db-health] pg_stat_activity check failed:', e.message);
    snapshot.serverError = e.message;
  }
  pool.lastHealthCheck = snapshot;
}

setInterval(() => { checkConnectionHealth().catch(() => {}); }, HEALTH_CHECK_INTERVAL_MS);
// Also run once shortly after startup rather than waiting a full interval.
setTimeout(() => { checkConnectionHealth().catch(() => {}); }, 15000);

module.exports = pool;
