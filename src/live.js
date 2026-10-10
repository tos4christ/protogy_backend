// live.js - real-time push channel (WebSocket at /ws).
// Staff browsers connect with their JWT (?token=...); every ingested reading
// is broadcast so the UI updates the moment data arrives - no polling delay.
//
// Scoped per connection: a DisCo/State NERC account's browser must only
// receive readings for feeders inside its own scope - otherwise the REST API
// scoping (routes.js/nerc.js/scope.js) is pointless, since the same data
// would leak straight out over the WebSocket to anyone watching the Network
// tab. A small in-memory meter->{disco,state} cache avoids a DB round trip
// on every single reading (readings can arrive many times a second).
require('dotenv').config();
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const pool = require('./db');
const { scopeOf } = require('./scope');

const SECRET = process.env.JWT_SECRET;
let wss = null;

// meterId -> { disco, state }, refreshed periodically. A meter not yet in
// the cache (e.g. just onboarded) is withheld from scoped connections until
// the next refresh - fail closed, not leaked.
let meterScope = new Map();
async function refreshMeterScope() {
  try {
    const { rows } = await pool.query('SELECT meter_id, disco, state FROM meters');
    const next = new Map();
    rows.forEach((r) => next.set(r.meter_id, { disco: r.disco, state: r.state }));
    meterScope = next;
  } catch (e) {
    console.error('[live] meter scope cache refresh failed:', e.message);
  }
}

function allowed(connScope, meterId) {
  if (connScope.kind === 'full') return true;
  const m = meterScope.get(meterId);
  if (!m) return false; // unknown meter -> withhold from scoped connections
  if (connScope.kind === 'disco') return m.disco === connScope.disco;
  if (connScope.kind === 'state') return connScope.states.includes(m.state);
  return false;
}

function attach(server) {
  wss = new WebSocket.Server({ noServer: true });
  refreshMeterScope();
  setInterval(refreshMeterScope, 2 * 60 * 1000); // 2 min - new meters appear within this window

  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname !== '/ws') return socket.destroy();
      const token = url.searchParams.get('token') || '';
      const user = jwt.verify(token, SECRET); // staff token required; throws if invalid
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.isAlive = true;
        ws.scope = scopeOf(user); // resolved once per connection, not per message
        ws.on('pong', () => { ws.isAlive = true; });
        wss.emit('connection', ws, req);
      });
    } catch (e) {
      socket.destroy();
    }
  });

  // heartbeat: drop dead connections every 30s
  setInterval(() => {
    if (!wss) return;
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  console.log('[live] WebSocket hub attached at /ws');
}

function broadcast(obj) {
  if (!wss || wss.clients.size === 0) return;
  const msg = JSON.stringify(obj);
  const meterId = obj && obj.meterId;
  wss.clients.forEach((ws) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (meterId && !allowed(ws.scope || { kind: 'full' }, meterId)) return;
    ws.send(msg);
  });
}

module.exports = { attach, broadcast };
