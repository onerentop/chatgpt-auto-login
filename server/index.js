const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db');

const configRoutes = require('./routes/config');

const app = express();
const server = http.createServer(app);

// Bind to loopback by default — the dashboard intentionally has no auth, so
// exposing it on 0.0.0.0 would let any LAN peer drive PayPal payments and
// read plaintext credentials via /api/accounts/raw. Users who knowingly want
// remote access can set HOST=0.0.0.0 (or a specific NIC IP).
const HOST = process.env.HOST || '127.0.0.1';
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  `http://${HOST}:3000`,
];

const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] },
});

// Socket.IO — no auth
io.use((socket, next) => next());

app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());

// Init DB then mount routes
initDB().then(() => {
  const accountsRoutes = require('./routes/accounts');
  const executeRoutes = require('./routes/execute');
  const resultsRoutes = require('./routes/results');
  const proxyRoutes = require('./routes/proxy');
  const livenessRoutes = require('./routes/liveness');
  const { createRunner } = require('./liveness/runner');
  const checker = require('./liveness/checker');
  const codexFile = require('./liveness/codex-file');
  const { lightLogin } = require('./liveness/light-login');
  const { accountsDB, statusDB, livenessLogsDB } = require('./db');
  const fs = require('fs');

  function readProtocolMode() {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8'));
      return Boolean(cfg.protocolMode);
    } catch { return true; }
  }

  // Lazy chromium import — only loaded if a re-login is actually triggered
  async function lazyChromiumConnect() {
    const { chromium } = require('playwright');
    return chromium.connectOverCDP('http://127.0.0.1:9222');
  }

  // OTP wrapper: try to use the existing login.fetchOtp if present; otherwise throw a clear error
  async function getOtp(account) {
    try {
      const login = require('../login');
      if (typeof login.fetchOtp === 'function') return await login.fetchOtp(account);
    } catch {}
    throw new Error('otp fetch not wired');
  }

  const livenessRunner = createRunner({
    io, statusDB, accountsDB, checker,
    lightLogin: (account, opts) => lightLogin(account, {
      ...opts,
      playwrightConnect: lazyChromiumConnect,
      getOtp,
    }),
    codexFile,
    config: { get protocolMode() { return readProtocolMode(); } },
    livenessLogsDB,
  });

  app.use('/api/accounts', accountsRoutes);
  app.use('/api/config', configRoutes);
  app.use('/api/execute', executeRoutes(io));
  app.use('/api/results', resultsRoutes);
  app.use('/api/proxy', proxyRoutes);
  app.use('/api/liveness', livenessRoutes(livenessRunner, accountsDB, livenessLogsDB));
  app.use('/api/health', require('./routes/health'));

  const distPath = path.join(__dirname, '..', 'web', 'dist');
  app.use(express.static(distPath));
  app.get(/^\/(?!api).*/, (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, HOST, () => {
    if (HOST === '127.0.0.1') {
      console.log(`Server running on http://127.0.0.1:${PORT} (local only — set HOST=0.0.0.0 for LAN access)`);
    } else {
      console.log(`Server running on http://${HOST}:${PORT}`);
      console.log('⚠ Listening on non-loopback host — the dashboard has NO authentication, anyone on this network can drive the pipeline and read credentials.');
    }

    // Auto-start proxy if config.proxy.enabled is true
    try {
      const fs = require('fs');
      const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8'));
      if (cfg.proxy?.enabled || cfg.proxy?.jpCheckout?.enabled) {
        const proxyMgr = require('./proxy');
        proxyMgr.refresh().then((n) => {
          console.log(`[Proxy] Auto-started: ${n} nodes, current: ${proxyMgr.getState().currentNode}`);
        }).catch((e) => {
          console.log(`[Proxy] Auto-start failed: ${e.message?.slice(0, 80)}`);
        });
      }
    } catch {}
  });
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

// Graceful shutdown — flush log buffers and the async save queue before
// exiting. Without this, Ctrl+C can lose the trailing 0-9 log entries that
// haven't crossed the 10-line save threshold yet.
let _shuttingDown = false;
async function gracefulShutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[shutdown] received ${signal}, flushing…`);
  // Hard timeout: never block exit longer than 5s on the queue. If the
  // disk is wedged, we'd rather lose the last write than hang forever.
  const HARD_DEADLINE_MS = 5000;
  const timer = setTimeout(() => {
    console.warn('[shutdown] flush did not complete within 5s — forcing exit');
    process.exit(1);
  }, HARD_DEADLINE_MS);
  timer.unref();
  try {
    const db = require('./db');
    if (db.logsDB?.flush) db.logsDB.flush();
    if (db.livenessLogsDB?.clear) {} // intentionally not clearing on shutdown
    if (db.save?.flush) await db.save.flush();
  } catch (e) {
    console.error('[shutdown] flush failed:', e.message);
  }
  clearTimeout(timer);
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
