const express = require('express');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const router = express.Router();

// Root paths
const DISCORD_RESULTS = path.join(__dirname, '..', '..', 'discord-results.json');
const SESSIONS_DIR = path.join(__dirname, '..', '..', 'sessions');
const CPA_AUTH_DIR = path.join(__dirname, '..', '..', 'cpa-auth');
const CSV_PATH = path.join(__dirname, '..', '..', 'accounts.csv');

/**
 * Convert email to CPA auth filename.
 * Pattern: codex-{email with @ replaced by -at- and . by -}.json
 */
function emailToAuthFilename(email) {
  const sanitized = email.replace('@', '-at-').replace(/\./g, '-');
  return `codex-${sanitized}.json`;
}

// GET /api/results — list all results with enrichment
router.get('/', (req, res) => {
  try {
    if (!fs.existsSync(DISCORD_RESULTS)) {
      return res.json([]);
    }

    const raw = fs.readFileSync(DISCORD_RESULTS, 'utf-8');
    const results = JSON.parse(raw);

    const enriched = results.map((result) => {
      const email = result.email || '';
      const sessionFile = path.join(SESSIONS_DIR, `${email}.json`);
      const authFile = path.join(CPA_AUTH_DIR, emailToAuthFilename(email));

      return {
        ...result,
        hasSession: fs.existsSync(sessionFile),
        hasAuthFile: fs.existsSync(authFile),
      };
    });

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: `Failed to read results: ${err.message}` });
  }
});

// GET /api/results/:email/auth-file — download CPA auth JSON for an email
router.get('/:email/auth-file', (req, res) => {
  const { email } = req.params;
  const filename = emailToAuthFilename(email);
  const filePath = path.join(CPA_AUTH_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Auth file not found' });
  }

  res.download(filePath, filename);
});

// GET /api/results/download-all — ZIP all CPA auth files and stream as download
router.get('/download-all', (req, res) => {
  if (!fs.existsSync(CPA_AUTH_DIR)) {
    return res.status(404).json({ error: 'No auth files directory found' });
  }

  const files = fs.readdirSync(CPA_AUTH_DIR).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    return res.status(404).json({ error: 'No auth files found' });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="cpa-auth-files.zip"');

  const archive = archiver('zip', { zlib: { level: 9 } });

  archive.on('error', (err) => {
    res.status(500).json({ error: `Archive error: ${err.message}` });
  });

  archive.pipe(res);

  for (const file of files) {
    archive.file(path.join(CPA_AUTH_DIR, file), { name: file });
  }

  archive.finalize();
});

// POST /api/results/:email/retry — find account index for retry
router.post('/:email/retry', (req, res) => {
  const { email } = req.params;

  try {
    if (!fs.existsSync(CSV_PATH)) {
      return res.status(404).json({ error: 'accounts.csv not found' });
    }

    const content = fs.readFileSync(CSV_PATH, 'utf-8');
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);

    // First line is header; find the account line
    for (let i = 1; i < lines.length; i++) {
      const fields = lines[i].split(',').map((f) => f.trim());
      if (fields[0] === email) {
        // i-1 because index 0 = first data row (after header)
        return res.json({ startFrom: i - 1 });
      }
    }

    res.status(404).json({ error: 'Account not found in accounts.csv' });
  } catch (err) {
    res.status(500).json({ error: `Failed to read accounts: ${err.message}` });
  }
});

module.exports = router;
