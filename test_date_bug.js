// test_date_bug.js — run this BEFORE applying any fix, from inside
// protogy_backend/ so it picks up the same .env as the real app:
//   node test_date_bug.js
//
// It asks Postgres for the literal date 2026-08-27 and shows exactly what
// the pg driver hands back to your Node code, unmodified — no app logic,
// no fix applied. If the date has shifted, the bug is real on this server.
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: +(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'protogy',
  user: process.env.PGUSER || 'protogy_app',
  password: process.env.PGPASSWORD,
});

(async () => {
  console.log('--- Environment ---');
  console.log('Node resolved timezone:', Intl.DateTimeFormat().resolvedOptions().timeZone);
  console.log('process.env.TZ:', process.env.TZ || '(not set)');
  console.log();

  const { rows } = await pool.query("SELECT '2026-08-27'::date AS d");
  const d = rows[0].d;
  console.log('--- What Postgres sent for the date 2026-08-27 ---');
  console.log('typeof value:', typeof d);
  console.log('raw value:', d);

  if (d instanceof Date) {
    const shifted = d.toISOString().slice(0, 10);
    console.log('.toISOString().slice(0,10):', shifted);
    console.log();
    if (shifted !== '2026-08-27') {
      console.log('BUG CONFIRMED: Postgres sent 2026-08-27, but calling .toISOString()');
      console.log(`on it in Node produced "${shifted}" instead — a silent one-day shift.`);
      console.log('This is exactly what caused the SBT Scorecard (and other date-keyed');
      console.log('reports) to look up data under the wrong day and find nothing.');
    } else {
      console.log('No shift detected in this exact test. The specific reports may still');
      console.log('be affected under different conditions (e.g. near midnight), but this');
      console.log('server/driver combination is not showing the bug right now.');
    }
  } else {
    console.log();
    console.log('The value came back as a plain string already, not a Date object —');
    console.log('this means the type parser fix (or an equivalent) is already active,');
    console.log('and the bug described does not apply on this server.');
  }

  await pool.end();
})().catch((e) => { console.error('Error running test:', e.message); process.exit(1); });