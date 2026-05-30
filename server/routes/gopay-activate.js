// REST routes for GoPay Plus activation
const express = require('express');
const path = require('path');
const fs = require('fs');
const engine = require('../gopay-engine');

const MAIN_CONFIG = path.join(__dirname, '..', '..', 'config.json');

module.exports = function gopayActivateRoutes(io) {
  const router = express.Router();

  // POST /api/gopay-activate/start — start activation for one account
  router.post('/start', (req, res) => {
    const { email, accessToken, planType } = req.body;
    if (!accessToken) return res.status(400).json({ error: 'accessToken required' });

    if (engine.state.running) {
      return res.status(409).json({ error: 'Engine already running' });
    }

    engine.runOne({ email, accessToken, access_token: accessToken, planType }).catch(() => {});
    res.json({ ok: true, message: 'Started' });
  });

  // POST /api/gopay-activate/stop — abort current run
  router.post('/stop', (_req, res) => {
    engine.stop();
    res.json({ ok: true, message: 'Stop signal sent' });
  });

  // GET /api/gopay-activate/status — engine state
  router.get('/status', (_req, res) => {
    res.json(engine.state);
  });

  // GET /api/gopay-activate/config — read gopay config (masked)
  router.get('/config', (_req, res) => {
    try {
      const cfg = JSON.parse(fs.readFileSync(MAIN_CONFIG, 'utf-8'));
      const result = {
        gopay: cfg.gopay || { defaultPin: '147258', smsProvider: 'smsbower' },
        smsbower: cfg.phonePool?.smsbower || {},
        smscloud: cfg.phonePool?.smscloud || {},
        idGopay: cfg.proxy?.idGopay || {},
      };
      if (result.smsbower.apiKey) result.smsbower.apiKey = result.smsbower.apiKey.slice(0, 6) + '***';
      if (result.smscloud.apiKey) result.smscloud.apiKey = result.smscloud.apiKey.slice(0, 6) + '***';
      const tpl = result.idGopay.proxyTemplate || '';
      if (tpl.includes('@')) result.idGopay.proxyTemplate = '***@' + tpl.split('@').pop();
      res.json(result);
    } catch (e) {
      res.status(404).json({ error: 'Config not found', detail: e.message });
    }
  });

  // POST /api/gopay-activate/rotate-ip — reload sing-box with new IPRoyal session
  router.post('/rotate-ip', async (_req, res) => {
    try {
      const proxyMgr = require('../proxy');
      await proxyMgr.regenerateAndReload();
      res.json({ ok: true, message: 'sing-box reloaded with new session' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/gopay-activate/config — update gopay config (merge into main config.json)
  router.post('/config', (req, res) => {
    try {
      const cfg = JSON.parse(fs.readFileSync(MAIN_CONFIG, 'utf-8'));
      if (req.body.gopay) cfg.gopay = { ...(cfg.gopay || {}), ...req.body.gopay };
      if (req.body.smsbower) cfg.phonePool = { ...(cfg.phonePool || {}), smsbower: { ...(cfg.phonePool?.smsbower || {}), ...req.body.smsbower } };
      if (req.body.idGopay) cfg.proxy = { ...(cfg.proxy || {}), idGopay: { ...(cfg.proxy?.idGopay || {}), ...req.body.idGopay } };
      fs.writeFileSync(MAIN_CONFIG, JSON.stringify(cfg, null, 2));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Wire step-status from the engine singleton to Socket.IO.
  // gopay-log / gopay-result are already forwarded in server/index.js (after mount);
  // only step-status is wired here to avoid double-binding the other events.
  engine.on('step-status', (d) => io.emit('step-status', d));

  return router;
};
