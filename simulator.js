// simulator.js - simulates a field meter over mutual TLS (like a real device).
// Prereq: .\issue-device.ps1 -MeterId "SIM-001"  (certs in C:\protogy\certs\devices\SIM-001)
// Usage:  node simulator.js SIM-001 localhost
//         node simulator.js SIM-001 mqtt.yourdomain.com
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');

const meterId = process.argv[2] || 'SIM-001';
const host = process.argv[3] || 'localhost';
const certDir = process.env.CERT_DIR || `C:\\protogy\\certs\\devices\\${meterId}`;

const client = mqtt.connect(`mqtts://${host}:8883`, {
  ca: fs.readFileSync(path.join(certDir, 'ca.crt')),
  cert: fs.readFileSync(path.join(certDir, `${meterId}.crt`)),
  key: fs.readFileSync(path.join(certDir, `${meterId}.key`)),
  clientId: meterId,
  rejectUnauthorized: host !== 'localhost', // cert CN is the DNS name, not "localhost"
  clean: false,
});

let energy = 123456.0;
client.on('connect', () => {
  console.log(`[${meterId}] connected over mTLS to ${host}:8883 - publishing every 15s`);
  setInterval(() => {
    energy += 0.03;
    const payload = {
      timestamp: new Date().toISOString(),
      voltage_l1: +(230 + Math.random() * 4).toFixed(1),
      voltage_l2: +(229 + Math.random() * 4).toFixed(1),
      voltage_l3: +(231 + Math.random() * 4).toFixed(1),
      current_l1: +(10 + Math.random() * 3).toFixed(2),
      current_l2: +(11 + Math.random() * 3).toFixed(2),
      current_l3: +(9 + Math.random() * 3).toFixed(2),
      frequency: +(49.9 + Math.random() * 0.2).toFixed(2),
      power_factor: 0.92,
      active_power: +(7500 + Math.random() * 500).toFixed(1),
      reactive_power: 2500, apparent_power: 8000,
      active_energy: +energy.toFixed(2),
      reactive_energy: 40000, apparent_energy: 130000,
      status: 1, EXTI_Trigger: 0, Payver: 2,
    };
    client.publish(`meters/${meterId}/data`, JSON.stringify(payload), { qos: 1 });
    console.log(`[${meterId}] sent`, payload.timestamp);
  }, 15000);
});
client.on('error', (e) => console.error(`[${meterId}] error:`, e.message));
