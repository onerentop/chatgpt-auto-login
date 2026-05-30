// REST routes for GoPay Plus activation
const express = require('express');
const path = require('path');
const fs = require('fs');
const engine = require('../gopay-engine');

const router = express.Router();
const GOPAY_CONFIG = path.join(__dirname, '..', '..', 'gopay', 'config', 'config.json');

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
    const cfg = JSON.parse(fs.readFileSync(GOPAY_CONFIG, 'utf-8'));
    if (cfg.sms?.api_key) cfg.sms.api_key = cfg.sms.api_key.slice(0, 6) + '***';
    if (cfg.gopay?.register_proxy) {
      const p = cfg.gopay.register_proxy;
      const at = p.indexOf('@');
      if (at > 0) cfg.gopay.register_proxy = '***@' + p.slice(at + 1);
    }
    res.json(cfg);
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

// POST /api/gopay-activate/config — update gopay config
router.post('/config', (req, res) => {
  try {
    const dir = path.dirname(GOPAY_CONFIG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(GOPAY_CONFIG, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
