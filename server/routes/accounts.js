const express = require('express');
const { accountsDB } = require('../db');
const router = express.Router();

// GET / — list all accounts
router.get('/', (req, res) => {
  try {
    const accounts = accountsDB.list();
    res.json(accounts.map(a => ({ ...a, password: a.password ? '••••••' : '', loginType: a.login_type })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /raw — list with real passwords (for internal use)
router.get('/raw', (req, res) => {
  try {
    res.json(accountsDB.list().map(a => ({ ...a, loginType: a.login_type })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST / — add single account
router.post('/', (req, res) => {
  try {
    const { email, password, totp_secret, client_id, refresh_token } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    if (accountsDB.get(email)) return res.status(409).json({ error: 'Account exists' });
    accountsDB.add({ email: email.trim(), password: password.trim(), totp_secret, client_id, refresh_token });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /import — bulk import (---- format)
router.post('/import', (req, res) => {
  try {
    const text = req.body.text || '';
    if (!text.trim()) return res.status(400).json({ error: 'No data' });

    const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const existing = new Set(accountsDB.list().map(a => a.email.toLowerCase()));
    const toAdd = [];
    let skipped = 0;
    let invalid = 0;

    for (const line of text.trim().split('\n').filter(l => l.trim())) {
      const parts = line.split('----').map(p => p.trim());
      const email = (parts[0] || '').replace(/\s+/g, '');
      const password = (parts[1] || '').trim();
      const thirdField = (parts[2] || '').replace(/\s+/g, '');
      const fourthField = (parts[3] || '').replace(/\s+/g, '');
      if (!email || !password) { invalid++; continue; }
      if (!EMAIL_REGEX.test(email)) { invalid++; continue; }
      if (existing.has(email.toLowerCase())) { skipped++; continue; }
      existing.add(email.toLowerCase());
      const domain = (email.split('@')[1] || '').toLowerCase();
      const isOutlook = ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain);
      toAdd.push({
        email, password,
        totp_secret: isOutlook ? '' : thirdField,
        client_id: isOutlook ? thirdField : '',
        refresh_token: isOutlook ? fourthField : '',
      });
    }
    if (toAdd.length > 0) accountsDB.bulkAdd(toAdd);
    res.json({ added: toAdd.length, skipped, invalid, total: accountsDB.list().length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /:email — edit account
router.put('/:email', (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    if (!accountsDB.get(email)) return res.status(404).json({ error: 'Not found' });
    accountsDB.update(email, req.body);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /:email — delete account
router.delete('/:email', (req, res) => {
  try {
    accountsDB.delete(decodeURIComponent(req.params.email));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /batch-delete — delete N accounts in one round trip + one disk flush
// Body: { emails: string[] }
// Returns: { deleted: string[], notFound: string[] }
router.post('/batch-delete', (req, res) => {
  try {
    const { emails } = req.body || {};
    if (!Array.isArray(emails)) {
      return res.status(400).json({ error: 'emails must be an array' });
    }
    if (emails.length === 0) {
      return res.json({ deleted: [], notFound: [] });
    }
    const out = accountsDB.bulkDelete(emails);
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /export — export in ---- format
router.get('/export', (req, res) => {
  try {
    const accounts = accountsDB.list();
    const lines = accounts.map(a => {
      const isOutlook = a.login_type === 'outlook';
      const third = isOutlook ? (a.client_id || '') : (a.totp_secret || '');
      const fourth = isOutlook ? (a.refresh_token || '') : '';
      return [a.email, a.password, third, fourth].filter(Boolean).join('----');
    });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=accounts.txt');
    res.send(lines.join('\n'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
