const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');

// Fields whose values should be partially masked in GET /
const SENSITIVE_FIELDS = ['discordToken', 'cpaKey', 'smsApiUrl'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read config.json and return as object.
 */
function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {};
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Write config object to config.json.
 */
function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Mask a sensitive field value: show first 4 chars + ••••••
 */
function maskSensitive(value) {
  if (!value || typeof value !== 'string') return value;
  if (value.length <= 4) return '••••••';
  return value.slice(0, 4) + '••••••';
}

/**
 * Return a copy of config with sensitive fields masked.
 */
function maskConfig(config) {
  const masked = { ...config };
  for (const field of SENSITIVE_FIELDS) {
    if (masked[field] !== undefined && masked[field] !== null && masked[field] !== '') {
      masked[field] = maskSensitive(String(masked[field]));
    }
  }
  return masked;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET / — return config with sensitive fields masked
 */
router.get('/', (req, res) => {
  try {
    const config = readConfig();
    res.json(maskConfig(config));
  } catch (err) {
    res.status(500).json({ error: 'Failed to read config', detail: err.message });
  }
});

/**
 * GET /raw — return full config (unmasked, for editing)
 */
router.get('/raw', (req, res) => {
  try {
    const config = readConfig();
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read config', detail: err.message });
  }
});

/**
 * PUT / — update config
 * Skips any field whose value contains •••••• to avoid overwriting
 * real values with masked placeholders.
 */
router.put('/', (req, res) => {
  try {
    const incoming = req.body;

    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }

    const current = readConfig();

    // Merge incoming fields into current config, skipping masked values
    for (const [key, value] of Object.entries(incoming)) {
      if (typeof value === 'string' && value.includes('••••••')) {
        // Skip — this is a masked value, do not overwrite
        continue;
      }
      current[key] = value;
    }

    writeConfig(current);
    res.json({ message: 'Config updated', config: maskConfig(current) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update config', detail: err.message });
  }
});

module.exports = router;
