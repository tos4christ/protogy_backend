// mqttIngest.js - Feature 1 & 8: auto-detect streaming meters and save data.
// Subscribes to meters/+/data. Any meter that streams is auto-registered by the
// DB trigger (fn_ensure_meter_exists) with status 'auto_registered'; when the
// administrator onboards it from the frontend, onboard_meter() "claims" it.
// Batches inserts (flush every 2s or 500 rows). ON CONFLICT DO NOTHING makes
// buffered resends idempotent.
require('dotenv').config();
const fs = require('fs');
const mqtt = require('mqtt');
const pool = require('./db');
const live = require('./live');

const COLS = [
  'meter_id', 'meter_ts', 'received_ts',
  'voltage_l1', 'voltage_l2', 'voltage_l3',
  'current_l1', 'current_l2', 'current_l3',
  'frequency', 'power_factor',
  'active_power', 'reactive_power', 'apparent_power',
  'active_energy', 'reactive_energy', 'apparent_energy',
  'status', 'exti_trigger', 'payver',
];


// ---------------------------------------------------------------------------
// Payload normalization - supports BOTH vendor formats:
// A) Flat format:   { timestamp, voltage_l1, current_l1, active_power, ... }
// B) Nested format: { time, DevEUI, data: { V_L12, A_L1, Active_Power_Inst,
//                     Frequency_Avg, ... }, provider_source, ... }
//    (LoRaWAN-style; line-to-line voltages V_L12/V_L23/V_L31 map to the
//     voltage_l1/l2/l3 columns; EXTI_Trigger arrives as "TRUE"/"FALSE".)
// Returns a flat object with canonical keys, or null if unrecognizable.
// ---------------------------------------------------------------------------
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function bool01(v) {
  if (typeof v === 'string') return v.trim().toUpperCase() === 'TRUE' ? 1 : 0;
  return v ? 1 : 0;
}
function normalizePayload(raw) {
  // Some vendors nest the readings under "params" (or "payload") instead of
  // "data" - alias them so every nested-format branch below applies unchanged.
  if (raw && !raw.data) {
    if (raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)) raw = { ...raw, data: raw.params };
    else if (raw.payload && typeof raw.payload === 'object') raw = { ...raw, data: raw.payload };
  }
  // Format C: nested "data" with space-separated keys, epoch-ms "ts", no DevEUI
  // e.g. { ts: 1784553165714, data: { "Active Power kW1": 661.29,
  //        "Current1": 158.96, "Voltage V23": 10.85,
  //        "True Power Factor PH1": 0.95, ... } }
  // Mapping: line-to-line voltages V12/V23/V31 -> voltage_l1/l2/l3;
  // Current1..3 -> currents; per-phase kW SUMMED -> active_power;
  // per-phase PF AVERAGED -> power_factor. Missing fields stay null.
  if (raw && typeof raw.data === 'object' && raw.data !== null
      && ('Current1' in raw.data || 'Active Power kW1' in raw.data
          || 'Voltage V23' in raw.data || 'True Power Factor PH1' in raw.data)) {
    const d = raw.data;
    const phases = (pfx) => [1, 2, 3].map((n) => num(d[pfx + n])).filter((v) => v !== null);
    const kw = phases('Active Power kW');
    const pf = phases('True Power Factor PH');
    let tsMs = num(raw.ts) ?? num(d.ts);
    // Guard: epoch SECONDS (10 digits) instead of milliseconds (13 digits)
    if (tsMs && tsMs < 1e12) tsMs *= 1000;
    // Guard: implausible clock (before 2020 or >1 day in the future) ->
    // fall back to server time so data still lands on the correct day.
    if (tsMs && (tsMs < 1577836800000 || tsMs > Date.now() + 86400000)) tsMs = Date.now();
    return {
      timestamp: tsMs ? new Date(tsMs).toISOString()
               : (d.timestamp || raw.time || new Date().toISOString()),
      voltage_l1: num(d['Voltage V12']), voltage_l2: num(d['Voltage V23']),
      voltage_l3: num(d['Voltage V31']),
      current_l1: num(d.Current1), current_l2: num(d.Current2), current_l3: num(d.Current3),
      frequency: num(d.Frequency) ?? num(d.FREQUENCY) ?? num(d['Frequency Hz']),
      power_factor: pf.length ? +(pf.reduce((a, b) => a + b, 0) / pf.length).toFixed(3) : null,
      active_power: kw.length ? +kw.reduce((a, b) => a + b, 0).toFixed(2) : num(d['Active Power kW']),
      reactive_power: num(d['Reactive Power kVAr']) ?? null,
      apparent_power: num(d['Apparent Power kVA']) ?? null,
      active_energy: num(d['Active Energy kWh']) ?? num(d['Energy kWh']) ?? null,
      reactive_energy: num(d['Reactive Energy kVArh']) ?? null,
      apparent_energy: num(d['Apparent Energy kVAh']) ?? null,
      status: num(d.Status) ?? null, exti_trigger: 0,
      payver: num(d.Payver) ?? 0,
    };
  }

  // Format B: nested "data" object
  if (raw && typeof raw.data === 'object' && raw.data !== null) {
    const d = raw.data;
    return {
      timestamp: d.timestamp || d.time || raw.time || new Date().toISOString(),
      voltage_l1: num(d.V_L12), voltage_l2: num(d.V_L23), voltage_l3: num(d.V_L31),
      current_l1: num(d.A_L1), current_l2: num(d.A_L2), current_l3: num(d.A_L3),
      frequency: num(d.Frequency_Avg), power_factor: num(d.Power_Factor_Avg),
      active_power: num(d.Active_Power_Inst),
      reactive_power: num(d.Reactive_Power_Inst),
      apparent_power: num(d.Apparent_Power_Inst),
      active_energy: num(d.Active_energy_Tot),
      reactive_energy: num(d.Reactive_energy_Tot),
      apparent_energy: num(d.Apparent_Energy_Tot),
      status: num(d.Status), exti_trigger: bool01(d.EXTI_Trigger),
      payver: num(d.Payver) ?? 0,
    };
  }
  // Format A: flat object
  if (raw && (raw.timestamp || raw.voltage_l1 !== undefined || raw.active_power !== undefined)) {
    return {
      timestamp: raw.timestamp || new Date().toISOString(),
      voltage_l1: num(raw.voltage_l1), voltage_l2: num(raw.voltage_l2), voltage_l3: num(raw.voltage_l3),
      current_l1: num(raw.current_l1), current_l2: num(raw.current_l2), current_l3: num(raw.current_l3),
      frequency: num(raw.frequency), power_factor: num(raw.power_factor),
      active_power: num(raw.active_power),
      reactive_power: num(raw.reactive_power),
      apparent_power: num(raw.apparent_power),
      active_energy: num(raw.active_energy),
      reactive_energy: num(raw.reactive_energy),
      apparent_energy: num(raw.apparent_energy),
      status: num(raw.status), exti_trigger: bool01(raw.EXTI_Trigger ?? raw.exti_trigger),
      payver: num(raw.Payver ?? raw.payver) ?? 0,
    };
  }
  return null;
}

let batch = [];
let stats = { received: 0, inserted: 0, badPayloads: 0, lastFlush: null };

// Rejected payloads are appended here for review (capped at ~5 MB).
// Review with:  Get-Content bad-payloads.log -Tail 50
const path = require('path');
const BAD_LOG = path.join(__dirname, 'bad-payloads.log');
function logBadPayload(topic, message, reason) {
  stats.badPayloads++;
  console.error('[mqtt] BAD PAYLOAD (' + reason + ') on', topic, '- captured to bad-payloads.log');
  try {
    if (fs.existsSync(BAD_LOG) && fs.statSync(BAD_LOG).size > 5 * 1024 * 1024) return;
    const body = typeof message === 'string' ? message : message.toString();
    fs.appendFileSync(BAD_LOG,
      new Date().toISOString() + ' | ' + reason + ' | ' + topic + '\n' +
      body.slice(0, 4000) + '\n---\n');
  } catch (e) { /* never let logging break ingestion */ }
}

function start() {
  const opts = {
    clientId: process.env.MQTT_CLIENT_ID || 'protogy-backend',
    clean: false,
    reconnectPeriod: 5000,
  };
  if (process.env.MQTT_CA_FILE) {
    opts.ca = fs.readFileSync(process.env.MQTT_CA_FILE);
    opts.cert = fs.readFileSync(process.env.MQTT_CERT_FILE);
    opts.key = fs.readFileSync(process.env.MQTT_KEY_FILE);
  }
  const client = mqtt.connect(process.env.MQTT_URL || 'mqtt://localhost:1883', opts);

  client.on('connect', () => {
    console.log('[mqtt] connected to', process.env.MQTT_URL);
    client.subscribe(process.env.MQTT_TOPIC || 'meters/+/data', { qos: 1 });
    client.subscribe('gw/+/+/data', { qos: 1 });  // controller per-meter topics
    client.subscribe('gw/+/data', { qos: 1 });    // controller batch topic
    client.subscribe('powertechfeeder/messagetopic', { qos: 1 });    // controller batch topic
  });
  client.on('error', (e) => console.error('[mqtt] error:', e.message));

  client.on('message', (topic, message) => {
    if(topic === 'powertechfeeder/messagetopic') {
      // console.log('[mqtt] received batch message on', topic, message.toString().slice(0, 200), '...');
    }
    stats.received++;
    try {
      const parts = topic.split('/');
      
      const raw = JSON.parse(message.toString());
      const receivedTs = new Date().toISOString();

      // Route by topic shape:
      //   meters/<meter_id>/data          -> single reading, standalone meter
      //   gw/<controller>/<meter_id>/data -> single reading via controller
      //   gw/<controller>/data            -> BATCH: readings for many meters
      //   powertechfeeder/messagetopic    -> BATCH: readings for many meters

      if (parts[0] === 'powertechfeeder' && parts[1] === 'messagetopic') {        
          
        if (raw && raw.DevEUI) {
          enqueue(raw.DevEUI, raw.DevEUI, raw, receivedTs, topic);
        } else {
          logBadPayload(topic, JSON.stringify(raw), 'batch missing DevEUI');
        }
      }
      if (parts[0] === 'meters' && parts.length === 3) {
        enqueue(parts[1], null, raw, receivedTs, topic);
      } else if (parts[0] === 'gw' && parts.length === 4) {
        enqueue(parts[2], parts[1], raw, receivedTs, topic);
      } else if (parts[0] === 'gw' && parts.length === 3) {
        const controllerId = parts[1];
        // Accept {meters:[...]}, {data:[...]} or a bare array. Each entry must
        // identify its meter: meter_id | meterId | id | serial | DevEUI.
        const list = Array.isArray(raw) ? raw
          : Array.isArray(raw.meters) ? raw.meters
          : Array.isArray(raw.params) ? raw.params
          : Array.isArray(raw.data) ? raw.data : null;
        if (list) {
          // batch style: many meters in one publish
          for (const entry of list) {
            const mid = entry.DevEUI || entry.device_id || entry.deviceId
              || entry.meter_id || entry.meterId || entry.id || entry.serial;
            if (!mid) { logBadPayload(topic, JSON.stringify(entry), 'batch entry missing meter id'); continue; }
            const hasOwnTs = entry.ts || entry.time || entry.timestamp
              || (entry.data && (entry.data.ts || entry.data.timestamp));
            const withTs = hasOwnTs ? entry : { ...entry, ts: raw.ts || raw.time };
            enqueue(String(mid), controllerId, withTs, receivedTs, topic);
          }
        } else {
          // sequential style: ONE meter payload per publish (transmission cycle,
          // e.g. every 2s). DevEUI identifies the meter and becomes meter_id.
          const mid = raw.DevEUI || (raw.data && raw.data.DevEUI)
            || raw.device_id || raw.deviceId
            || raw.meter_id || raw.meterId || raw.id || raw.serial
            || controllerId; // no id in payload -> single-meter gateway: use controller id
          enqueue(String(mid), controllerId, raw, receivedTs, topic);
        }
      }
      // if(topic === 'powertechfeeder/messagetopic' && raw && raw.DevEUI == 'a8404170b45a0ac5') {
      //   console.log(batch, '  batch after enqueue for  ', topic, raw.DevEUI);
      // }
      if (batch.length >= 500) flush(topic, raw);
    } catch (err) {
      stats.badPayloads++;
      console.error('[mqtt] bad payload on', topic, err.message);
    }
  });

  setInterval(flush, 2000);
}


const seenControllerPairs = new Set();
function enqueue(meterId, controllerId, raw, receivedTs, topic) {
  const p = normalizePayload(raw);
  if (topic === 'powertechfeeder/messagetopic' && raw && meterId == 'a8404170b45a0ac5') {
    console.log('[mqtt] enqueue for  ', topic, meterId, ' normalized to ', p);
  }
  if (!p) { return logBadPayload(topic, JSON.stringify(raw), 'unrecognized shape'); }
  live.broadcast({ type: 'reading', meterId, controllerId, receivedTs, data: p });
  batch.push([
    meterId,
    p.timestamp,
    receivedTs,
    p.voltage_l1, p.voltage_l2, p.voltage_l3,
    p.current_l1, p.current_l2, p.current_l3,
    p.frequency, p.power_factor,
    p.active_power, p.reactive_power, p.apparent_power,
    p.active_energy, p.reactive_energy, p.apparent_energy,
    p.status, p.exti_trigger, p.payver,
  ]);
  // Tag the meter with its controller once per process lifetime (fills
  // controller_id on auto-registered meters; never overwrites an existing tag).
  if (controllerId) {
    const key = controllerId + '|' + meterId;
    if (!seenControllerPairs.has(key)) {
      seenControllerPairs.add(key);
      pool.query(
        `UPDATE meters SET controller_id = COALESCE(controller_id, $2) WHERE meter_id = $1`,
        [meterId, controllerId]
      ).catch(() => seenControllerPairs.delete(key)); // retry on next message
    }
  }
}

async function flush(topic, raw) {
  if (batch.length === 0) return;
  const rows = batch;
  batch = [];
  const values = [];
  const params = [];
  rows.forEach((row, i) => {
    const base = i * COLS.length;
    values.push(`(${COLS.map((_, j) => `$${base + j + 1}`).join(',')})`);
    params.push(...row);
  });
  const sql = `INSERT INTO readings (${COLS.join(',')})
               VALUES ${values.join(',')}
               ON CONFLICT (meter_id, meter_ts) DO NOTHING`;
  try {
    
    const r = await pool.query(sql, params);

    // if(topic === 'powertechfeeder/messagetopic' && raw && raw.DevEUI == 'a8404170b45a0ac5') {
    //   console.log(sql, params, " then finally ", r);
    // }

    stats.inserted += r.rowCount;
    stats.lastFlush = new Date().toISOString();
  } catch (err) {
    console.error('[ingest] insert failed, re-queueing', rows.length, 'rows:', err.message);
    batch = rows.concat(batch);
  }
}

module.exports = { start, stats: () => stats, normalizePayload };
