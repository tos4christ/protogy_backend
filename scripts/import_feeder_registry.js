// scripts/import_feeder_registry.js
// One-off (re-runnable) import of the Commission's NESI feeder database
// into the feeder_registry reference table (migrations/002_feeder_registry.sql
// must have been run first). Normalizes feeder_type/voltage per
// feederType.js's rule and upserts on (disco, feeder), so running this again
// against an updated file (e.g. the substation-mapped version NERC/Powertech
// are expecting) just refreshes the existing rows rather than duplicating them.
//
// Usage:
//   node scripts/import_feeder_registry.js /path/to/FEEDER_DATABASE.xlsx
//
// Expects the exact column headers from the sheet as shared:
//   FEEDER, DISCO, BAND, FEEDER LOCATION, MAJOR STREETS ON FEEDER,
//   FEEDER STATE, FEEDER REGULATOR, FEEDER VOLTAGE LEVEL,
//   NUMBER OF UNMETERED CUSTOMERS, NUMBER OF METERED CUSTOMERS, FEEDER TYPE
// (substation column is optional — not present in the first cut of the
// file; picked up automatically once the Commission's updated version adds
// a SUBSTATION column, under any of a few likely header spellings.)

require('dotenv').config();
const path = require('path');
const ExcelJS = require('exceljs');
const pool = require('../src/db');
const { normalizeFeederType } = require('../src/feederType');

const HEADER_MAP = {
  'FEEDER': 'feeder',
  'DISCO': 'disco',
  'BAND': 'band',
  'FEEDER LOCATION': 'location',
  'MAJOR STREETS ON FEEDER': 'major_streets',
  'FEEDER STATE': 'state',
  'FEEDER REGULATOR': 'regulator',
  'FEEDER VOLTAGE LEVEL': 'voltage_level',
  'NUMBER OF UNMETERED CUSTOMERS': 'unmetered_customers',
  'NUMBER OF METERED CUSTOMERS': 'metered_customers',
  'FEEDER TYPE': 'feeder_type',
  'SUBSTATION': 'substation',
  'FEEDER SUBSTATION': 'substation',
};

function normalizeVoltage(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // '11kV'/'11KV'/'11 KV' -> '11KV', matching the uppercase convention
  // already used throughout nerc.js/routes.js (voltage_class).
  return s.toUpperCase().replace(/\s+/g, '');
}

function cleanInt(raw) {
  if (raw == null || raw === '') return null;
  const n = +raw;
  return Number.isFinite(n) ? Math.round(n) : null;
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/import_feeder_registry.js /path/to/FEEDER_DATABASE.xlsx');
    process.exit(1);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve(file));
  const ws = wb.worksheets[0];

  const headerRow = ws.getRow(1).values; // 1-indexed, index 0 is empty
  const colIndex = {}; // field name -> 1-indexed column number
  headerRow.forEach((h, i) => {
    if (!h) return;
    const key = HEADER_MAP[String(h).trim().toUpperCase()];
    if (key) colIndex[key] = i;
  });

  const required = ['feeder', 'disco'];
  const missing = required.filter((k) => !colIndex[k]);
  if (missing.length) {
    console.error('Missing required column(s) in sheet:', missing.join(', '));
    console.error('Found headers:', headerRow.filter(Boolean));
    process.exit(1);
  }
  const hasSubstation = Boolean(colIndex.substation);
  console.log('Column mapping:', colIndex, hasSubstation ? '(substation column found)' : '(no substation column yet)');

  const rows = [];
  const unrecognizedTypes = new Map(); // raw label -> count, for review
  let skippedNoKey = 0;

  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const get = (field) => (colIndex[field] ? row.getCell(colIndex[field]).value : null);
    const feeder = get('feeder');
    const disco = get('disco');
    if (!feeder || !disco) { skippedNoKey++; return; }

    const rawType = get('feeder_type');
    const feederType = normalizeFeederType(rawType);
    if (rawType && feederType) {
      const parts = String(feederType).split('/');
      const knownCanon = new Set(['Public', 'Commercial', 'Dedicated', 'Virtual', 'Express']);
      if (parts.some((p) => !knownCanon.has(p))) {
        const raw = String(rawType).trim();
        unrecognizedTypes.set(raw, (unrecognizedTypes.get(raw) || 0) + 1);
      }
    }

    rows.push({
      feeder: String(feeder).trim(),
      disco: String(disco).trim(),
      band: get('band') ? String(get('band')).trim() : null,
      location: get('location') ? String(get('location')).trim() : null,
      major_streets: get('major_streets') ? String(get('major_streets')).trim() : null,
      state: get('state') ? String(get('state')).trim() : null,
      regulator: get('regulator') ? String(get('regulator')).trim() : null,
      voltage_level: normalizeVoltage(get('voltage_level')),
      unmetered_customers: cleanInt(get('unmetered_customers')),
      metered_customers: cleanInt(get('metered_customers')),
      feeder_type: feederType,
      substation: hasSubstation && get('substation') ? String(get('substation')).trim() : null,
    });
  });

  console.log(`Parsed ${rows.length} feeder rows (${skippedNoKey} skipped — missing feeder/disco).`);

  const client = await pool.connect();
  let upserted = 0;
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      await client.query(
        `INSERT INTO feeder_registry
           (disco, feeder, band, location, major_streets, state, regulator,
            voltage_level, unmetered_customers, metered_customers, feeder_type,
            substation, imported_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
         ON CONFLICT (disco, feeder) DO UPDATE SET
           band = $3, location = $4, major_streets = $5, state = $6, regulator = $7,
           voltage_level = $8, unmetered_customers = $9, metered_customers = $10,
           feeder_type = $11,
           -- never overwrite a previously-imported substation with NULL —
           -- only replace it when this import actually provides one.
           substation = COALESCE($12, feeder_registry.substation),
           imported_at = now()`,
        [r.disco, r.feeder, r.band, r.location, r.major_streets, r.state, r.regulator,
         r.voltage_level, r.unmetered_customers, r.metered_customers, r.feeder_type, r.substation]);
      upserted++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  console.log(`Upserted ${upserted} rows into feeder_registry.`);

  const { rows: typeCounts } = await pool.query(
    `SELECT feeder_type, count(*) AS n FROM feeder_registry GROUP BY feeder_type ORDER BY n DESC`);
  console.log('\nfeeder_type distribution after normalization:');
  typeCounts.forEach((r) => console.log(`  ${r.feeder_type || '(none)'}: ${r.n}`));

  if (unrecognizedTypes.size) {
    console.log('\nUnrecognized feeder_type label(s) — kept verbatim, review these:');
    for (const [raw, n] of unrecognizedTypes) console.log(`  "${raw}": ${n} row(s)`);
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
