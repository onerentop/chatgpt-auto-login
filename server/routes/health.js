/**
 * GET /api/health — minimal operational status.
 *
 * Returns 200 if the DB is reachable. Body includes the proxy state
 * summary and engine status so an external watcher can tell whether
 * the pipeline is idle / running / stopping and which proxy nodes
 * are active.
 *
 * Does NOT include any secrets (no token, no subscription URL, no
 * credentials). Safe to expose on a non-loopback HOST if the user
 * has opted in to remote access.
 */

const express = require('express');
const { getEngine } = require('../engine-singleton');

const router = express.Router();
const STARTED_AT = Date.now();

router.get('/', (req, res) => {
  // DB liveness — just try a no-op list.
  let dbOk = false;
  try {
    const { accountsDB } = require('../db');
    accountsDB.list();
    dbOk = true;
  } catch (e) {
    // Leave dbOk false; we don't expose the error detail.
  }

  // Proxy state — reuse the field-whitelisted getState() from PX-1 so we
  // automatically inherit redaction. Pick a tiny subset for /healthz.
  let proxy = null;
  try {
    const s = require('../proxy').getState();
    proxy = {
      enabled: s.enabled,
      currentNode: s.currentNode,
      available: s.available,
      jpEnabled: s.jp?.enabled,
      jpCurrentNode: s.jp?.currentNode,
      jpAvailable: s.jp?.available,
    };
  } catch (e) {
    // Proxy module may not be loaded yet; return null.
  }

  const engine = getEngine();
  const engineStatus = engine && typeof engine.getStatus === 'function' ? engine.getStatus() : 'idle';

  let version = 'unknown';
  try { version = require('../../package.json').version || 'unknown'; } catch {}

  res.status(dbOk ? 200 : 503).json({
    ok: dbOk,
    db: dbOk ? 'ok' : 'error',
    proxy,
    engine: engineStatus,
    uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
    version,
  });
});

module.exports = router;
