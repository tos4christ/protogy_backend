// live.js - real-time push channel (WebSocket at /ws).
// Staff browsers connect with their JWT (?token=...); every ingested reading
// is broadcast so the UI updates the moment data arrives - no polling delay.
require('dotenv').config();
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
let wss = null;

function attach(server) {
  wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname !== '/ws') return socket.destroy();
      const token = url.searchParams.get('token') || '';
      jwt.verify(token, SECRET); // staff token required; throws if invalid
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.isAlive = true;
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
  wss.clients.forEach((ws) => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

module.exports = { attach, broadcast };
