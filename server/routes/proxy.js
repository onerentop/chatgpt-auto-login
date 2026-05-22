const express = require('express');
const proxy = require('../proxy');

const router = express.Router();

router.get('/status', (req, res) => {
  res.json(proxy.getState());
});

router.post('/refresh', async (req, res) => {
  try {
    const count = await proxy.refresh();
    res.json({ ok: true, nodes: count, ...proxy.getState() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/stop', async (req, res) => {
  try { await proxy.stop(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/rotate', async (req, res) => {
  try { const node = await proxy.rotate(); res.json({ ok: true, currentNode: node }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/switch', async (req, res) => {
  try {
    const { node } = req.body || {};
    if (!node || typeof node !== 'string') return res.status(400).json({ error: 'node required' });
    await proxy.switchTo(node);
    res.json({ ok: true, currentNode: node });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/detect-exit', async (req, res) => {
  try { const ip = await proxy.detectExit(); res.json({ ok: true, exitIp: ip }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/mark-bad', (req, res) => {
  const { node, ttlMs } = req.body || {};
  if (!node || typeof node !== 'string') return res.status(400).json({ error: 'node required' });
  proxy.markBad(node, ttlMs);
  res.json({ ok: true, node, badNodes: proxy.getState().badNodes });
});

router.post('/jp/rotate', async (req, res) => {
  try { const node = await proxy.rotateJp(); res.json({ ok: true, currentNode: node }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/jp/detect-exit', async (req, res) => {
  try { const ip = await proxy.detectJpExit(); res.json({ ok: true, exitIp: ip }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/jp/mark-bad', (req, res) => {
  const { node, ttlMs } = req.body || {};
  if (!node || typeof node !== 'string') return res.status(400).json({ error: 'node required' });
  proxy.markJpBad(node, ttlMs);
  res.json({ ok: true, node, jpBadNodes: proxy.getState().jp.badNodes });
});

module.exports = router;
