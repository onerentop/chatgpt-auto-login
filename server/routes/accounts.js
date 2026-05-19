const express = require('express');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const router = express.Router();

const CSV_PATH = path.join(__dirname, '..', '..', 'accounts.csv');
const CSV_HEADER = 'email,password,totp_secret,client_id,refresh_token\n';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse accounts.csv, returning an array of account objects.
 * Creates the file with headers if it does not exist.
 */
function readAccounts() {
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(CSV_PATH, CSV_HEADER, 'utf-8');
    return [];
  }

  const raw = fs.readFileSync(CSV_PATH, 'utf-8').trim();
  if (!raw) {
    fs.writeFileSync(CSV_PATH, CSV_HEADER, 'utf-8');
    return [];
  }

  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });

  return records;
}

/**
 * Write an array of account objects back to accounts.csv.
 */
function writeAccounts(accounts) {
  const fields = ['email', 'password', 'totp_secret', 'client_id', 'refresh_token'];
  let csv = fields.join(',') + '\n';

  for (const acct of accounts) {
    const row = fields.map((f) => {
      const val = (acct[f] || '').toString();
      // Escape fields that contain commas, quotes, or newlines
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return '"' + val.replace(/"/g, '""') + '"';
      }
      return val;
    });
    csv += row.join(',') + '\n';
  }

  fs.writeFileSync(CSV_PATH, csv, 'utf-8');
}

/**
 * Auto-detect loginType based on email domain.
 */
function detectLoginType(email) {
  if (!email) return 'unknown';
  const domain = email.split('@')[1] || '';
  const lower = domain.toLowerCase();
  if (lower === 'gmail.com' || lower.endsWith('.gmail.com')) return 'Google';
  if (lower === 'outlook.com' || lower === 'hotmail.com' || lower === 'live.com') return 'Outlook';
  return 'Other';
}

/**
 * Mask a password string for display.
 */
function maskPassword(pw) {
  if (!pw) return '';
  return '••••••';
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET / — list all accounts (passwords masked)
 */
router.get('/', (req, res) => {
  try {
    const accounts = readAccounts();
    const result = accounts.map((acct) => ({
      ...acct,
      loginType: detectLoginType(acct.email),
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read accounts', detail: err.message });
  }
});

/**
 * POST / — add a single account
 * Body: { email, password, totp_secret?, client_id?, refresh_token? }
 */
router.post('/', (req, res) => {
  try {
    const { email, password, totp_secret, client_id, refresh_token } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const accounts = readAccounts();

    // Check for duplicate email
    if (accounts.some((a) => a.email.toLowerCase() === email.toLowerCase())) {
      return res.status(409).json({ error: 'Account with this email already exists' });
    }

    accounts.push({
      email: email.trim(),
      password: password.trim(),
      totp_secret: (totp_secret || '').trim(),
      client_id: (client_id || '').trim(),
      refresh_token: (refresh_token || '').trim(),
    });

    writeAccounts(accounts);
    res.status(201).json({ message: 'Account added', count: accounts.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add account', detail: err.message });
  }
});

/**
 * POST /import — bulk import accounts.
 * Format: one account per line, fields separated by ----
 * email----password----2fa_or_clientId----refreshToken
 * Auto trims all whitespace from each field.
 */
router.post('/import', (req, res) => {
  try {
    const text = req.body.text || '';
    if (!text.trim()) return res.status(400).json({ error: 'No data provided' });

    const accounts = readAccounts();
    const existingEmails = new Set(accounts.map((a) => a.email.toLowerCase()));
    const newAccounts = [];
    let skipped = 0;

    const lines = text.trim().split('\n').filter((l) => l.trim());
    for (const line of lines) {
      const parts = line.split('----').map((p) => p.trim());
      const email = (parts[0] || '').replace(/\s+/g, '');
      const password = (parts[1] || '').trim();
      const thirdField = (parts[2] || '').replace(/\s+/g, '');
      const fourthField = (parts[3] || '').replace(/\s+/g, '');
      if (!email || !password) continue;
      if (existingEmails.has(email.toLowerCase())) { skipped++; continue; }

      const isOutlook = ['outlook.com', 'hotmail.com', 'live.com'].some((d) => email.toLowerCase().includes(d));
      existingEmails.add(email.toLowerCase());
      newAccounts.push({
        email,
        password,
        totp_secret: isOutlook ? '' : (thirdField || ''),
        client_id: isOutlook ? (thirdField || '') : '',
        refresh_token: isOutlook ? (fourthField || '') : '',
      });
    }

    if (newAccounts.length === 0) return res.json({ added: 0, skipped, total: accounts.length });
    const all = [...accounts, ...newAccounts];
    writeAccounts(all);
    res.json({ added: newAccounts.length, skipped, total: all.length });
  } catch (err) {
    res.status(500).json({ error: 'Import failed', detail: err.message });
  }
});

/**
 * PUT /:email — edit an account
 */
router.put('/:email', (req, res) => {
  try {
    const targetEmail = decodeURIComponent(req.params.email).toLowerCase();
    const accounts = readAccounts();
    const idx = accounts.findIndex((a) => a.email.toLowerCase() === targetEmail);
    if (idx === -1) return res.status(404).json({ error: 'Account not found' });

    const { email, password, totp_secret, client_id, refresh_token } = req.body;
    if (email) accounts[idx].email = email.trim();
    if (password) accounts[idx].password = password.trim();
    if (totp_secret !== undefined) accounts[idx].totp_secret = (totp_secret || '').trim();
    if (client_id !== undefined) accounts[idx].client_id = (client_id || '').trim();
    if (refresh_token !== undefined) accounts[idx].refresh_token = (refresh_token || '').trim();

    writeAccounts(accounts);
    res.json({ message: 'Account updated' });
  } catch (err) {
    res.status(500).json({ error: 'Update failed', detail: err.message });
  }
});

/**
 * DELETE /:email — delete an account by email
 */
router.delete('/:email', (req, res) => {
  try {
    const targetEmail = decodeURIComponent(req.params.email).toLowerCase();
    const accounts = readAccounts();
    const filtered = accounts.filter((a) => a.email.toLowerCase() !== targetEmail);

    if (filtered.length === accounts.length) {
      return res.status(404).json({ error: 'Account not found' });
    }

    writeAccounts(filtered);
    res.json({ message: 'Account deleted', remaining: filtered.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete account', detail: err.message });
  }
});

/**
 * GET /export — download accounts in ---- format (same as import)
 * Format: email----password----2fa_or_clientId----refreshToken
 */
router.get('/export', (req, res) => {
  try {
    const accounts = readAccounts();
    const lines = accounts.map((a) => {
      const isOutlook = ['outlook.com', 'hotmail.com', 'live.com'].some((d) => (a.email || '').toLowerCase().includes(d));
      const thirdField = isOutlook ? (a.client_id || '') : (a.totp_secret || '');
      const fourthField = isOutlook ? (a.refresh_token || '') : '';
      return [a.email, a.password, thirdField, fourthField].filter(Boolean).join('----');
    });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=accounts.txt');
    res.send(lines.join('\n'));
  } catch (err) {
    res.status(500).json({ error: 'Export failed', detail: err.message });
  }
});

module.exports = router;
