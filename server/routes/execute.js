const express = require('express');
const fs = require('fs');
const path = require('path');
const { PipelineEngine } = require('../engine');
const { ProtocolEngine } = require('../../protocol-engine');

let engine = null;

function readProtocolMode() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8'));
    return !!cfg.protocolMode;
  } catch { return false; }
}

module.exports = function (io) {
  const router = express.Router();

  router.get('/status', (req, res) => {
    res.json({ status: engine ? engine.getStatus() : 'idle' });
  });

  // POST /api/execute — start pipeline
  // Body: { emails?: string[] } — if provided, only run these accounts
  router.post('/', (req, res) => {
    if (engine && engine.getStatus() !== 'idle') {
      return res.status(409).json({ error: 'Pipeline is already running' });
    }

    const { emails } = req.body || {};
    // Validate emails: must be undefined/null (run all), or an array of non-empty strings
    if (emails !== undefined && emails !== null) {
      if (!Array.isArray(emails)) {
        return res.status(400).json({ error: 'emails must be an array or omitted' });
      }
      for (const e of emails) {
        if (typeof e !== 'string' || !e.trim()) {
          return res.status(400).json({ error: 'emails must contain non-empty strings' });
        }
      }
    }
    // Release listeners on previous engine instance (prevent leak)
    if (engine) try { engine.removeAllListeners(); } catch {}
    engine = readProtocolMode() ? new ProtocolEngine() : new PipelineEngine();

    engine.on('log', (data) => io.emit('log', data));
    engine.on('account-status', (data) => io.emit('account-status', data));
    engine.on('complete', (data) => {
      io.emit('execution-complete', data);
      io.emit('log', { email: '', phase: '', message: `Execution complete: ${JSON.stringify(data.summary)}`, timestamp: new Date().toISOString() });
    });

    engine.start(0, emails || null).catch((err) => {
      io.emit('log', { email: '', phase: 'error', message: `Pipeline error: ${err.message}`, timestamp: new Date().toISOString() });
      io.emit('execution-complete', { summary: { total: 0, success: 0, noLink: 0, error: 1 } });
      io.emit('log', { email: '', phase: '', message: 'Execution complete: {"total":0,"success":0,"error":1}', timestamp: new Date().toISOString() });
    });

    res.json({ message: 'Pipeline started', accounts: emails ? emails.length : 'all' });
  });

  router.post('/stop', (req, res) => {
    if (!engine) return res.status(400).json({ error: 'No engine instance' });
    engine.stop();
    res.json({ message: 'Force stopped' });
  });

  return router;
};
