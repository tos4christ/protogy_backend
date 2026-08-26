// server.js - Protogy backend entry point
// REST API (JWT) + MQTT ingestion + EMQX webhooks + React static build.
// If SSL_CERT_FILE/SSL_KEY_FILE are set, serves HTTPS (and redirects HTTP).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const cors = require('cors');
const routes = require('./routes');
const hooks = require('./hooks');
const { router: authRoutes, requireAuth } = require('./auth');
const amiRoutes = require('./ami');
const nercRoutes = require('./nerc');
const { router: settingsRoutes } = require('./settings');
const ingest = require('./mqttIngest');
const live = require('./live');
const pool = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, _res, next) => { console.log(req.method, req.url); next(); });

// public endpoints
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'up', ingest: ingest.stats() });
  } catch (e) { res.status(500).json({ ok: false, db: e.message }); }
});
app.use('/api/auth', authRoutes);
app.use('/api/hooks', hooks);
// SSL provider domain-validation file — intentionally public, no auth.
app.use('/.well-known', express.static(path.join(__dirname, '.well-known')));

// protected API
app.use('/api/ami', amiRoutes);
app.use('/api/nerc', nercRoutes);      // regulator dashboard + Excel reports
app.use('/api/settings', settingsRoutes);   // customer portal + prepaid device REST API
app.use('/api', requireAuth, routes);

// Optional SECOND frontend (a parallel UI) served under /v2.
// Place its production build at  ..\frontend-v2\build  and it appears at
// https://<host>/v2/  alongside the main app. Both share the same /api.

// const buildDirV2 = path.join(__dirname, '..', 'frontend-v2', 'build');
const buildDirV2 = path.join(__dirname, 'build-v2');
if (fs.existsSync(buildDirV2)) {
  app.use('/v2', express.static(buildDirV2));
  app.get('/v2/*', (_req, res) => res.sendFile(path.join(buildDirV2, 'index.html')));
  console.log('Serving second frontend from', buildDirV2, 'at /v2');
}

// serve the React production build (npm run build in frontend/)
// const buildDir = path.join(__dirname, '..', 'frontend', 'build');
const buildDir = path.join(__dirname, 'build');
if (fs.existsSync(buildDir)) {
  app.use(express.static(buildDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(buildDir, 'index.html'));
  });
  console.log('Serving frontend from', buildDir);
}

const port = +(process.env.PORT || 3000);
const certFile = process.env.SSL_CERT_FILE;
const keyFile = process.env.SSL_KEY_FILE;

if (certFile && keyFile) {
  const httpsPort = +(process.env.HTTPS_PORT || 443);
  const httpsServer = https.createServer({
    cert: fs.readFileSync(certFile),
    key: fs.readFileSync(keyFile),
  }, app);
  live.attach(httpsServer);
  httpsServer.listen(httpsPort, () => console.log(`HTTPS on :${httpsPort}`));
  // redirect plain HTTP -> HTTPS
  http.createServer((req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    res.writeHead(301, { Location: `https://${host}${req.url}` });
    res.end();
  }).listen(+(process.env.HTTP_REDIRECT_PORT || 80),
    () => console.log('HTTP->HTTPS redirect on :80'));
} else {
  const httpServer = app.listen(port, () => console.log(`Protogy backend (HTTP) listening on :${port}`));
  live.attach(httpServer);
}

ingest.start();
