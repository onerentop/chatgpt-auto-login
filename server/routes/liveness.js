// server/routes/liveness.js
// REST mount point for liveness runner. The factory takes the already-built
// runner (so index.js does the wiring) plus accountsDB for the 'all emails'
// case where the client omits `emails`.

const express = require('express');

module.exports = function livenessRoutes(runner, accountsDB, livenessLogsDB) {
  const router = express.Router();

  router.post('/start', (req, res) => {
    const incoming = Array.isArray(req.body?.emails) ? req.body.emails : null;
    const emails = incoming || (accountsDB.list().map((a) => a.email));
    if (emails.length === 0) return res.status(400).json({ error: 'no accounts to test' });
    try {
      const out = runner.start(emails);
      res.json({ ok: true, ...out });
    } catch (e) {
      if (/already running/i.test(e.message)) return res.status(409).json({ error: e.message });
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  router.post('/stop', (req, res) => {
    res.json({ ok: true, ...runner.stop() });
  });

  router.get('/status', (req, res) => {
    res.json(runner.status());
  });

  // Returns the last N persisted liveness logs in chronological order so the
  // UI panel can hydrate immediately on page load (otherwise the panel would
  // be empty after refresh — live socket events only fill new entries).
  router.get('/logs', (req, res) => {
    if (!livenessLogsDB) return res.json([]);
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 200, 1000));
    try {
      res.json(livenessLogsDB.recent(limit));
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  return router;
};
