const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const JWT_SECRET = 'chatgpt-auto-login-web';
const JWT_EXPIRES_IN = '24h';

/**
 * Read webPassword from config.json, default to 'admin'
 */
function getWebPassword() {
  try {
    const configPath = path.join(__dirname, '..', '..', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return config.webPassword || 'admin';
  } catch {
    return 'admin';
  }
}

/**
 * POST /api/auth/login
 * Body: { password: string }
 * Returns: { token: string } on success, 401 on failure
 */
router.post('/login', (req, res) => {
  const { password } = req.body;
  const webPassword = getWebPassword();

  if (!password || password !== webPassword) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });

  res.json({ token });
});

/**
 * Middleware to verify JWT Bearer token
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = router;
module.exports.authMiddleware = authMiddleware;
