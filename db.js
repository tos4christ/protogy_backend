// db.js - PostgreSQL connection pool
require('dotenv').config();
const { Pool } = require('pg');

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
