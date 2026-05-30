const express = require('express');
const fs = require('fs');
const path = require('path');
const { PipelineEngine } = require('../engine');
const { ProtocolEngine } = require('../../protocol-engine');
const { getEngine, setEngine } = require('../engine-singleton');

function readProtocolMode() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8'));
    return !!cfg.protocolMode;
  } catch { return false; }
}

module.exports = function (io) {
  const router = express.Router();

  router.get('/status', (req, res) => {
    const engine = getEngine();
    res.json({ status: engine ? engine.getStatus() : 'idle' });
  });

  // POST /api/execute — start pipeline
  // Body: { emails?: string[] } — if provided, only run these accounts
  router.post('/', async (req, res) => {
    let engine = getEngine();
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
    // Release listeners + tear down the previous engine before constructing
    // a new one. Without this, an in-flight Chrome / Python / tempDir from
    // the prior run can collide with the new engine's user-data-dir, and
    // a stale LogCapture monkey-patch lingers on console.log forever.
    if (engine) {
      try { engine.removeAllListeners(); } catch {}
      try { await engine.stop(); } catch {}
    }
    engine = readProtocolMode() ? new ProtocolEngine() : new PipelineEngine();
    setEngine(engine);

    engine.on('log', (data) => io.emit('log', data));
    engine.on('account-status', (data) => io.emit('account-status', data));
    engine.on('step-status', (data) => io.emit('step-status', data));
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

  // POST /api/execute/retry-step — re-run pipeline for one account starting at stepId
  // Body: { email: string, stepId: string }
  router.post('/retry-step', async (req, res) => {
    const { email, stepId } = req.body || {};
    if (typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ error: 'email is required and must be a non-empty string' });
    }
    if (typeof stepId !== 'string' || !stepId.trim()) {
      return res.status(400).json({ error: 'stepId is required and must be a non-empty string' });
    }

    let engine = getEngine();
    if (engine && engine.getStatus() !== 'idle') {
      return res.status(409).json({ error: 'Pipeline is already running' });
    }

    // Tear down prior engine like POST '/' does
    if (engine) {
      try { engine.removeAllListeners(); } catch {}
      try { await engine.stop(); } catch {}
    }

    engine = readProtocolMode() ? new ProtocolEngine() : new PipelineEngine();
    setEngine(engine);

    engine.on('log', (data) => io.emit('log', data));
    engine.on('account-status', (data) => io.emit('account-status', data));
    engine.on('step-status', (data) => io.emit('step-status', data));
    engine.on('complete', (data) => {
      io.emit('execution-complete', data);
      io.emit('log', { email: '', phase: '', message: `Execution complete: ${JSON.stringify(data.summary)}`, timestamp: new Date().toISOString() });
    });

    engine.start(0, [email], { forceStepId: stepId }).catch((err) => {
      io.emit('log', { email: '', phase: 'error', message: `Retry error: ${err.message}`, timestamp: new Date().toISOString() });
      io.emit('execution-complete', { summary: { total: 0, success: 0, error: 1 } });
    });

    res.json({ message: 'Retry started', email, stepId });
  });

  router.post('/stop', (req, res) => {
    const engine = getEngine();
    if (!engine) return res.status(400).json({ error: 'No engine instance' });
    // engine.stop() is async (waits for browser.close + tempdir rm). We don't
    // block the HTTP response on it — engine.getStatus() will report 'stopping'
    // until the cleanup completes, and idempotent re-entry is safe.
    engine.stop().catch((err) => console.error('engine.stop() failed:', err));
    res.json({ message: 'Force stopped' });
  });

  return router;
};
