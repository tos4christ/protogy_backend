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
});

pool.on('error', (err) => console.error('PG pool error:', err.message));

module.exports = pool;
