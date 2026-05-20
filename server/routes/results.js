const express = require('express');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { statusDB, logsDB } = require('../db');

const router = express.Router();
const CPA_AUTH_DIR = path.join(__dirname, '..', '..', 'cpa-auth');

function emailToAuthFilename(email, format = 'cpa') {
  const sanitized = email.replace('@', '-at-').replace(/\./g, '-');
  return format === 'sub2api' ? `sub2api-${sanitized}.json` : `codex-${sanitized}.json`;
}

// GET / — list all account statuses
router.get('/', (req, res) => {
  try {
    const statuses = statusDB.list();
    const results = statuses.map(s => ({
      email: s.email,
      status: s.status,
      phase: s.phase,
      progress: s.progress,
      reason: s.reason,
      hasAuthFile: s.has_auth_file === 1 || fs.existsSync(path.join(CPA_AUTH_DIR, emailToAuthFilename(s.email, 'cpa'))) || fs.existsSync(path.join(CPA_AUTH_DIR, emailToAuthFilename(s.email, 'sub2api'))),
      updatedAt: s.updated_at,
    }));
    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /statuses — get all account statuses map
router.get('/statuses', (req, res) => {
  try {
    const statuses = statusDB.list();
    const map = {};
    for (const s of statuses) {
      map[s.email] = { email: s.email, status: s.status, phase: s.phase, progress: s.progress };
    }
    res.json(map);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /download-all — ZIP all auth files (?format=cpa|sub2api, MUST be before /:email routes)
router.get('/download-all', (req, res) => {
  if (!fs.existsSync(CPA_AUTH_DIR)) return res.status(404).json({ error: 'No auth files' });
  const format = req.query.format === 'sub2api' ? 'sub2api' : 'cpa';
  const { accountsDB } = require('../db');
  const accountEmails = new Set(accountsDB.list().map(a => a.email));
  const allFiles = fs.readdirSync(CPA_AUTH_DIR).filter(f => f.endsWith('.json'));
  const files = allFiles.filter(f => {
    for (const email of accountEmails) {
      if (f === emailToAuthFilename(email, format)) return true;
    }
    return false;
  });
  if (files.length === 0) return res.status(404).json({ error: `No ${format} auth files for current accounts` });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename=${format}-auth-files.zip`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  for (const f of files) archive.file(path.join(CPA_AUTH_DIR, f), { name: f });
  archive.finalize();
});

// GET /:email/logs — get logs for account
router.get('/:email/logs', (req, res) => {
  try {
    const logs = logsDB.getByEmail(decodeURIComponent(req.params.email));
    res.json(logs);
  } catch { res.json([]); }
});

// GET /:email/auth-file — download CPA or Sub2API auth JSON (?format=cpa|sub2api)
router.get('/:email/auth-file', (req, res) => {
  const format = req.query.format === 'sub2api' ? 'sub2api' : 'cpa';
  const filePath = path.resolve(CPA_AUTH_DIR, emailToAuthFilename(decodeURIComponent(req.params.email), format));
  // Prevent path traversal — resolved path must be inside CPA_AUTH_DIR
  if (!filePath.startsWith(path.resolve(CPA_AUTH_DIR) + path.sep)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.download(filePath);
});

// POST /:email/retry — get startFrom index for retry
router.post('/:email/retry', (req, res) => {
  try {
    const { accountsDB } = require('../db');
    const all = accountsDB.list();
    const idx = all.findIndex(a => a.email === decodeURIComponent(req.params.email));
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, startFrom: idx });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
