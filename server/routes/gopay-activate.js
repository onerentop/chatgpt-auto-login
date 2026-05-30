// REST routes for GoPay Plus activation
const express = require('express');
const path = require('path');
const fs = require('fs');
const engine = require('../gopay-engine');

const MAIN_CONFIG = path.join(__dirname, '..', '..', 'config.json');

module.exports = function gopayActivateRoutes(io) {
  const router = express.Router();

  // POST /api/gopay-activate/start — 批量激活选中账号（emails 省略=全部）
  router.post('/start', async (req, res) => {
    const { emails } = req.body || {};
    if (emails !== undefined && emails !== null) {
      if (!Array.isArray(emails)) return res.status(400).json({ error: 'emails must be an array or omitted' });
      for (const e of emails) {
        if (typeof e !== 'string' || !e.trim()) return res.status(400).json({ error: 'emails must contain non-empty strings' });
      }
    }
    // 互斥：主 Execute 引擎运行中 → 409
    try {
      const { getEngine } = require('../engine-singleton');
      const exec = getEngine();
      if (exec && exec.getStatus && exec.getStatus() !== 'idle') {
        return res.status(409).json({ error: '主激活(PayPal)正在运行，请先停止' });
      }
    } catch {}
    // 互斥：GoPay 自身运行中 → 409
    if (engine.state.running) return res.status(409).json({ error: 'GoPay 激活已在运行' });

    engine.start(0, emails || null).catch((err) => {
      io.emit('gopay-log', `Activation error: ${err.message}`);
      io.emit('execution-complete', { summary: { total: 0, success: 0, error: 1 } });
    });
    res.json({ ok: true, message: 'Started', accounts: emails ? emails.length : 'all' });
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

  // Wire engine events to Socket.IO — removeAllListeners first to avoid double-binding
  // (factory runs once per server start, but guard against future hot-reload scenarios).
  engine.removeAllListeners('step-status');
  engine.removeAllListeners('account-status');
  engine.removeAllListeners('complete');
  engine.removeAllListeners('log');
  engine.on('step-status', (d) => io.emit('step-status', d));
  engine.on('account-status', (d) => io.emit('account-status', d));
  engine.on('complete', (d) => io.emit('execution-complete', d));
  engine.on('log', (d) => io.emit('gopay-log', typeof d === 'string' ? d : (d.message || '')));

  return router;
};
