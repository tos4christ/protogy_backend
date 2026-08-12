/**
 * PROTOGY UNIVERSAL SIMULATOR — standalone meters & daisy-chain controllers,
 * flat & nested (vendor/DevEUI) payload formats. Connects over mutual TLS
 * exactly like real hardware.
 *
 * Prereq (once per identity, in deploy/):
 *   Standalone meter:  .\issue-device.ps1 -MeterId "SIM-001"
 *   Controller:        .\issue-device.ps1 -MeterId "CTRL-SIM01" -Controller -MeterCount 4
 *
 * Usage examples:
 *   # 1. Standalone meter, flat payload, every 15s  ->  meters/SIM-001/data
 *   node sim-controller.js --id SIM-001 --mode meter --format flat
 *
 *   # 2. Standalone meter, nested vendor payload
 *   node sim-controller.js --id SIM-001 --mode meter --format nested
 *
 *   # 3. Controller with 4 daisy-chained meters, nested payloads,
 *   #    one publish per meter 2s apart, full cycle 15s -> gw/CTRL-SIM01/data
 *   node sim-controller.js --id CTRL-SIM01 --mode controller --meters 4 --format nested
 *
 *   # 4. Controller with 10 meters, flat payloads, 3s spacing, 30s cycle, remote host
 *   node sim-controller.js --id CTRL-SIM01 --mode controller --meters 10 \
 *        --format flat --gap 3 --cycle 30 --host mqtt.protogyglobal.io
 *
 * Flags (all optional except --id):
 *   --id <clientId>      cert CN / MQTT client id            (required)
 *   --mode meter|controller                                  (default meter)
 *   --format flat|nested|mixed                               (default nested)
 *          mixed = alternates format per meter, proving both parse together
 *   --meters <n>         chain size in controller mode       (default 4)
 *   --gap <s>            seconds between meters in a cycle   (default 2)
 *   --cycle <s>          full cycle / meter interval         (default 15)
 *   --host <host>        broker                              (default localhost)
 *   --certdir <path>     cert folder (default C:\protogy\certs\devices\<id>)
 *
 * DevEUIs for controller meters are deterministic: a84041291a5a09<NN>,
 * so the same meters reappear across runs — onboard them by those DevEUIs.
 */

const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');

// ---- tiny arg parser --------------------------------------------------------
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}
const id = args.id;
if (!id) { console.error('Missing --id <clientId>. See header for usage.'); process.exit(1); }
const mode = (args.mode || 'meter').toLowerCase();
const format = (args.format || 'nested').toLowerCase();
const meterCount = Math.max(1, +(args.meters || 4));
const gapS = Math.max(1, +(args.gap || 2));
const cycleS = Math.max(gapS * (mode === 'controller' ? meterCount : 1), +(args.cycle || 15));
const host = args.host || 'localhost';
const certDir = args.certdir || `C:\\protogy\\certs\\devices\\${id}`;

// ---- meter fleet ------------------------------------------------------------
// Standalone mode: one meter whose id = client id.
// Controller mode: N meters with deterministic DevEUIs.
const meters = mode === 'controller'
  ? Array.from({ length: meterCount }, (_, i) => ({
      devEui: 'a84041291a5a09' + String(i + 1).padStart(2, '0'),
      energy: 100000 + i * 5000,
    }))
  : [{ devEui: id, energy: 123456 }];

function reading(m) {
  m.energy += (7 + Math.random()) * cycleS / 3600; // ~7.5 kWh/h drift
  return {
    ts: new Date().toISOString(),
    v1: +(230 + Math.random() * 4).toFixed(1),
    v2: +(229 + Math.random() * 4).toFixed(1),
    v3: +(231 + Math.random() * 4).toFixed(1),
    i1: +(10 + Math.random() * 3).toFixed(2),
    i2: +(11 + Math.random() * 3).toFixed(2),
    i3: +(9 + Math.random() * 3).toFixed(2),
    freq: +(49.9 + Math.random() * 0.2).toFixed(2),
    pf: +(0.9 + Math.random() * 0.08).toFixed(3),
    p: +(7500 + Math.random() * 800).toFixed(1),
    q: +(2400 + Math.random() * 300).toFixed(1),
    s: +(8000 + Math.random() * 700).toFixed(1),
    ea: +m.energy.toFixed(2),
    er: +(m.energy * 0.33).toFixed(2),
    es: +(m.energy * 1.05).toFixed(2),
  };
}

function flatPayload(m) {
  const r = reading(m);
  return {
    // flat format still carries the DevEUI so the controller topic can route it
    ...(mode === 'controller' ? { DevEUI: m.devEui } : {}),
    timestamp: r.ts,
    voltage_l1: r.v1, voltage_l2: r.v2, voltage_l3: r.v3,
    current_l1: r.i1, current_l2: r.i2, current_l3: r.i3,
    frequency: r.freq, power_factor: r.pf,
    active_power: r.p, reactive_power: r.q, apparent_power: r.s,
    active_energy: r.ea, reactive_energy: r.er, apparent_energy: r.es,
    status: 1, EXTI_Trigger: 0, Payver: 2,
  };
}

function nestedPayload(m) {
  const r = reading(m);
  return {
    time: r.ts, fcnt: Math.floor(Math.random() * 1000), fport: 2,
    DevEUI: m.devEui,
    data: {
      timestamp: r.ts,
      V_L12: r.v1, V_L23: r.v2, V_L31: r.v3,
      A_L1: r.i1, A_L2: r.i2, A_L3: r.i3,
      Frequency_Avg: r.freq, Power_Factor_Avg: r.pf,
      Active_Power_Inst: r.p, Reactive_Power_Inst: r.q, Apparent_Power_Inst: r.s,
      Active_energy_Tot: r.ea, Reactive_energy_Tot: r.er, Apparent_Energy_Tot: r.es,
      Status: 1, EXTI_Trigger: 'FALSE', Payver: 1,
    },
    provider_source: 'Protogy_Sim', ofln: '0',
  };
}

function buildPayload(m, index) {
  const fmt = format === 'mixed' ? (index % 2 === 0 ? 'nested' : 'flat') : format;
  return { fmt, body: fmt === 'flat' ? flatPayload(m) : nestedPayload(m) };
}

// ---- MQTT connection (mutual TLS, like real hardware) -----------------------
const client = mqtt.connect(`mqtts://${host}:8883`, {
  ca: fs.readFileSync(path.join(certDir, 'ca.crt')),
  cert: fs.readFileSync(path.join(certDir, `${id}.crt`)),
  key: fs.readFileSync(path.join(certDir, `${id}.key`)),
  clientId: id,
  rejectUnauthorized: host !== 'localhost',
  clean: false,
});

const topic = mode === 'controller' ? `gw/${id}/data` : `meters/${id}/data`;

let started = false; // guard: 'connect' fires again on every reconnect -
                     // without this, each reconnect stacked ANOTHER publish
                     // loop and multiplied the send rate (inflating DAR).
client.on('connect', () => {
  console.log(`[${id}] mTLS connected to ${host}:8883`);
  if (started) return; // reconnection: loop already running
  started = true;
  console.log(`[${id}] mode=${mode} format=${format} topic=${topic}`);
  if (mode === 'controller') {
    console.log(`[${id}] ${meterCount} meters, ${gapS}s apart, ${cycleS}s cycle`);
    console.log(`[${id}] DevEUIs: ${meters.map((m) => m.devEui).join(', ')}`);
    console.log(`[${id}] -> onboard each of those DevEUIs on the dashboard (interval ${cycleS}s)`);
    runCycle();
    setInterval(runCycle, cycleS * 1000);
  } else {
    console.log(`[${id}] publishing every ${cycleS}s`);
    publishOne(meters[0], 0);
    setInterval(() => publishOne(meters[0], 0), cycleS * 1000);
  }
});

function runCycle() {
  // transmission cycle: one meter every gapS seconds
  meters.forEach((m, i) => {
    setTimeout(() => publishOne(m, i), i * gapS * 1000);
  });
}

function publishOne(m, index) {
  const { fmt, body } = buildPayload(m, index);
  client.publish(topic, JSON.stringify(body), { qos: 1 });
  console.log(`[${id}] sent ${m.devEui} (${fmt}) ${body.timestamp || body.time}`);
}

client.on('error', (e) => console.error(`[${id}] error:`, e.message));
client.on('close', () => console.log(`[${id}] disconnected (retrying...)`));
