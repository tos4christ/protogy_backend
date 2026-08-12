# PROTOGY PLATFORM — INTEGRATION PACK
## For: Partner company (Elastel EG324 gateway) — Test Onboarding

---

## PART A — YOUR STEPS (Protogy side, before sharing anything)

### 1. Choose the controller identity
Pick a permanent ID for their gateway, e.g. `CTRL-ACME-01` (one per physical
EG324). This ID becomes the certificate CN, the MQTT client id, and their
topic namespace. It can never be changed without re-issuing the cert.

### 2. Issue the certificate (on your server, in deploy\)
```powershell
.\issue-device.ps1 -MeterId "CTRL-ACME-01" -Controller -MeterCount 4
```
This creates `C:\protogy\certs\devices\CTRL-ACME-01\` containing:
- `ca.crt`            — your CA's public certificate (safe to share)
- `CTRL-ACME-01.crt`  — their client certificate (safe to share)
- `CTRL-ACME-01.key`  — their PRIVATE key (share ONLY with them, securely)

NEVER share `C:\protogy\certs\ca.key` with anyone. That is the root key that
mints certificates; it should not even be on the server day-to-day.

### 3. Deliver the pack securely
Zip the 3 files + Part B of this document. Send via a private channel
(password-protected zip with the password over a different channel, or a
one-time link). Email attachments in plain form are not appropriate for the
.key file.

### 4. When their data starts flowing
Each meter's DevEUI auto-registers on your dashboard as `auto_registered`.
Onboard each DevEUI (Onboard Meter tab: Meter ID = the DevEUI, plus feeder
name, Controller ID = CTRL-ACME-01, Reporting Interval = their full cycle
seconds). Nothing is lost if they stream before you onboard.

---

## PART B — PARTNER CONFIGURATION (share this section with the company)

### Connection details (EG324 → Protogy MQTT broker)

| Setting                | Value                                        |
|------------------------|----------------------------------------------|
| Broker host            | mqtt.protogyglobal.io                        |
| Port                   | 8883                                         |
| Protocol               | MQTT 3.1.1 or 5.0 over TLS                   |
| TLS mode               | Mutual TLS (client certificate REQUIRED)     |
| CA certificate         | `ca.crt` (validates our server to you)       |
| Client certificate     | `CTRL-ACME-01.crt`                           |
| Client private key     | `CTRL-ACME-01.key`                           |
| MQTT Client ID         | `CTRL-ACME-01`  (EXACTLY — must match cert)  |
| Username / password    | none (identity comes from the certificate)   |
| Publish topic          | `gw/CTRL-ACME-01/data`                       |
| QoS                    | 1                                            |
| Retain                 | false                                        |
| Clean session          | false                                        |
| Keepalive              | 60 s                                         |

On the EG324: add this as a NEW/second MQTT server profile (Data Management →
Cloud/MQTT). It runs alongside your existing MQTT connection — your current
topic and server are not affected. All meters publish to the ONE topic above.

### Publishing pattern
Publish ONE meter per message, cycling through the daisy-chained meters
(e.g. one message every 2 seconds until all meters are sent, then repeat the
cycle). Each message must contain the meter's **DevEUI** — that is how our
platform identifies the meter. Both of these JSON shapes are accepted:

Nested (preferred — matches typical EG324/LoRaWAN output):
```json
{
  "time": "2026-07-20T10:15:30+00:00",
  "DevEUI": "a84041291a5a0947",
  "data": {
    "timestamp": "2026-07-20T10:15:30+00:00",
    "V_L12": 413.2, "V_L23": 412.1, "V_L31": 411.7,
    "A_L1": 12.4, "A_L2": 11.9, "A_L3": 12.1,
    "Frequency_Avg": 49.98, "Power_Factor_Avg": 0.95,
    "Active_Power_Inst": 8123, "Reactive_Power_Inst": 2650,
    "Apparent_Power_Inst": 8540,
    "Active_energy_Tot": 123456, "Reactive_energy_Tot": 40321,
    "Apparent_Energy_Tot": 130000,
    "Status": 1, "EXTI_Trigger": "FALSE", "Payver": 1
  }
}
```

Flat (also accepted; DevEUI at top level):
```json
{
  "DevEUI": "a84041291a5a0947",
  "timestamp": "2026-07-20T10:15:30Z",
  "voltage_l1": 230.1, "voltage_l2": 229.8, "voltage_l3": 231.0,
  "current_l1": 12.4, "current_l2": 11.9, "current_l3": 12.1,
  "frequency": 50.02, "power_factor": 0.95,
  "active_power": 8123.5, "reactive_power": 2650.1, "apparent_power": 8540.0,
  "active_energy": 123456.7, "reactive_energy": 40321.2,
  "apparent_energy": 130000.1,
  "status": 1, "EXTI_Trigger": 0, "Payver": 2
}
```

Requirements:
- `timestamp` (or `time`) = when the METER measured the values, ISO-8601 with
  timezone. On network outages, buffer readings and resend them later WITH
  THEIR ORIGINAL TIMESTAMPS — our platform handles late data automatically
  and duplicates are ignored, so resending is always safe.
- Numbers as JSON numbers (strings are tolerated but numbers preferred).
- One meter per message. (A batch form `{"meters":[...]}` is also supported
  if the gateway can only publish once per cycle — ask us first.)

### What will NOT work (by design — security)
- Connecting without the client certificate/key → connection refused.
- A Client ID different from `CTRL-ACME-01` → connection/publish refused.
- Publishing to any topic outside `gw/CTRL-ACME-01/...` → message dropped.
So keep the Client ID and topic exactly as specified.

### Acceptance test
1. Configure the profile and confirm the EG324 shows the connection as
   established (TLS handshake OK).
2. Publish one cycle of live meter data.
3. Notify us — we will confirm the DevEUIs appeared on the dashboard and
   that values (voltages, currents, energies) match your local readings.
4. Then leave it streaming; we will monitor acquisition rate over 24–48 h,
   including at least one deliberate network interruption to verify the
   buffer-and-resend behaviour.

Support contact: <your name / email / phone>
