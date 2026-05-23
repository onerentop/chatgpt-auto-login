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

router.get('/nodes', (req, res) => {
  const state = proxy.getState();
  const allTags = state.allTags || [];
  const jpKddiTags = allTags.filter(t => /KDDI/i.test(t));
  const usTags = allTags.filter(t => proxy.US_PATTERNS.test(t));
  res.json({ nodeTags: allTags, total: allTags.length, jpKddiTags, usTags });
});

function buildBlacklistView(state) {
  const now = Date.now();
  const toRows = (badNodes) => Object.entries(badNodes || {}).map(([tag, entry]) => ({
    tag,
    expiresAt: entry.expiresAt,
    ttlRemainingMs: Math.max(0, entry.expiresAt - now),
    reason: entry.reason || '',
    source: entry.source || 'auto',
  }));
  return { main: toRows(state.badNodes), jp: toRows(state.jp?.badNodes) };
}

router.get('/blacklist', (req, res) => {
  res.json(buildBlacklistView(proxy.getState()));
});

router.post('/blacklist/add', (req, res) => {
  const { tag, channel, ttlMs, reason } = req.body || {};
  if (!tag || typeof tag !== 'string') return res.status(400).json({ error: 'tag required' });
  if (!['main', 'jp'].includes(channel)) return res.status(400).json({ error: "channel must be 'main' or 'jp'" });
  try {
    proxy.blacklistManually(tag, channel, ttlMs, reason);
    res.json(buildBlacklistView(proxy.getState()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/blacklist/remove', (req, res) => {
  const { tag, channel } = req.body || {};
  if (!tag || typeof tag !== 'string') return res.status(400).json({ error: 'tag required' });
  if (!['main', 'jp'].includes(channel)) return res.status(400).json({ error: "channel must be 'main' or 'jp'" });
  proxy.removeFromBlacklist(tag, channel);
  res.json(buildBlacklistView(proxy.getState()));
});

router.post('/blacklist/clear', (req, res) => {
  const { channel } = req.body || {};
  if (!['main', 'jp'].includes(channel)) return res.status(400).json({ error: "channel must be 'main' or 'jp'" });
  proxy.clearBlacklist(channel);
  res.json(buildBlacklistView(proxy.getState()));
});

module.exports = router;
