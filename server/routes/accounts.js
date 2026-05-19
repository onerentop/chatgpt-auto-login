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
    const masked = accounts.map((acct) => ({
      ...acct,
      password: maskPassword(acct.password),
      loginType: detectLoginType(acct.email),
    }));
    res.json(masked);
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
 * POST /import — bulk import accounts from text body.
 *
 * Supports two formats:
 * 1. "----" separator format (one account per block, key=value lines)
 * 2. CSV format (email,password,totp_secret,client_id,refresh_token)
 *
 * Also accepts plain text with one "email,password" per line.
 */
router.post('/import', express.text({ type: '*/*' }), (req, res) => {
  try {
    let body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    // If we received JSON (e.g. { text: "..." }), unwrap it
    if (typeof req.body === 'object' && req.body !== null && req.body.text) {
      body = req.body.text;
    }

    if (!body || !body.trim()) {
      return res.status(400).json({ error: 'No data provided' });
    }

    const accounts = readAccounts();
    const existingEmails = new Set(accounts.map((a) => a.email.toLowerCase()));
    const newAccounts = [];
    let skipped = 0;

    const trimmedBody = body.trim();

    if (trimmedBody.includes('----')) {
      // ---- separator format
      const blocks = trimmedBody.split(/----+/).filter((b) => b.trim());
      for (const block of blocks) {
        const acct = parseBlock(block.trim());
        if (acct && acct.email) {
          if (existingEmails.has(acct.email.toLowerCase())) {
            skipped++;
          } else {
            existingEmails.add(acct.email.toLowerCase());
            newAccounts.push(acct);
          }
        }
      }
    } else {
      // CSV-like format: try to parse line by line
      const lines = trimmedBody.split('\n').filter((l) => l.trim());

      // Skip header line if it looks like one
      let startIdx = 0;
      if (lines.length > 0 && lines[0].toLowerCase().includes('email') && lines[0].toLowerCase().includes('password')) {
        startIdx = 1;
      }

      for (let i = startIdx; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const acct = parseCSVLine(line);
        if (acct && acct.email) {
          if (existingEmails.has(acct.email.toLowerCase())) {
            skipped++;
          } else {
            existingEmails.add(acct.email.toLowerCase());
            newAccounts.push(acct);
          }
        }
      }
    }

    if (newAccounts.length === 0) {
      return res.json({ message: 'No new accounts to import', added: 0, skipped });
    }

    const all = [...accounts, ...newAccounts];
    writeAccounts(all);

    res.json({
      message: `Imported ${newAccounts.length} account(s)`,
      added: newAccounts.length,
      skipped,
      total: all.length,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to import accounts', detail: err.message });
  }
});

/**
 * Parse a ---- separated block into an account object.
 * Auto-detects Outlook vs Gmail fields.
 */
function parseBlock(block) {
  const lines = block.split('\n').filter((l) => l.trim());
  const acct = { email: '', password: '', totp_secret: '', client_id: '', refresh_token: '' };

  for (const line of lines) {
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) {
      // Try comma-separated: email,password
      const parts = line.split(',');
      if (parts.length >= 2 && parts[0].includes('@')) {
        acct.email = parts[0].trim();
        acct.password = parts[1].trim();
        if (parts[2]) acct.totp_secret = parts[2].trim();
        if (parts[3]) acct.client_id = parts[3].trim();
        if (parts[4]) acct.refresh_token = parts[4].trim();
      }
      continue;
    }

    const key = line.slice(0, eqIdx).trim().toLowerCase();
    const value = line.slice(eqIdx + 1).trim();

    switch (key) {
      case 'email':
        acct.email = value;
        break;
      case 'password':
      case 'pass':
        acct.password = value;
        break;
      case 'totp_secret':
      case 'totp':
      case 'secret':
        acct.totp_secret = value;
        break;
      case 'client_id':
      case 'clientid':
        acct.client_id = value;
        break;
      case 'refresh_token':
      case 'refreshtoken':
      case 'token':
        acct.refresh_token = value;
        break;
    }
  }

  return acct.email ? acct : null;
}

/**
 * Parse a single CSV line into an account object.
 */
function parseCSVLine(line) {
  // Simple CSV parse (handles basic cases)
  const records = parse(line + '\n', {
    relax_column_count: true,
    skip_empty_lines: true,
  });

  if (records.length === 0 || records[0].length < 2) {
    // At minimum we need email and password
    return null;
  }

  const parts = records[0];
  return {
    email: (parts[0] || '').trim(),
    password: (parts[1] || '').trim(),
    totp_secret: (parts[2] || '').trim(),
    client_id: (parts[3] || '').trim(),
    refresh_token: (parts[4] || '').trim(),
  };
}

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
 * GET /export — download accounts.csv as file
 */
router.get('/export', (req, res) => {
  try {
    if (!fs.existsSync(CSV_PATH)) {
      fs.writeFileSync(CSV_PATH, CSV_HEADER, 'utf-8');
    }
    res.download(CSV_PATH, 'accounts.csv');
  } catch (err) {
    res.status(500).json({ error: 'Failed to export accounts', detail: err.message });
  }
});

module.exports = router;
