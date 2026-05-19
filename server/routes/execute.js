const express = require('express');
const { PipelineEngine } = require('../engine');

let engine = null;

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

    const { emails } = req.body;
    engine = new PipelineEngine();

    engine.on('log', (data) => io.emit('log', data));
    engine.on('account-status', (data) => io.emit('account-status', data));
    engine.on('complete', (data) => {
      io.emit('execution-complete', data);
      io.emit('log', { email: '', phase: '', message: `Execution complete: ${JSON.stringify(data.summary)}`, timestamp: new Date().toISOString() });
    });

    engine.start(0, emails || null).catch((err) => {
      io.emit('log', { email: '', phase: 'error', message: `Pipeline error: ${err.message}`, timestamp: new Date().toISOString() });
    });

    res.json({ message: 'Pipeline started', accounts: emails ? emails.length : 'all' });
  });

  router.post('/stop', (req, res) => {
    if (!engine || engine.getStatus() !== 'running') {
      return res.status(400).json({ error: 'Pipeline is not running' });
    }
    engine.stop();
    res.json({ message: 'Stop requested' });
  });

  return router;
};
