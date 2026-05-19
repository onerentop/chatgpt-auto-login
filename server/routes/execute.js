const express = require('express');
const { PipelineEngine } = require('../engine');

let engine = null;

module.exports = function (io) {
  const router = express.Router();

  // GET /api/execute/status
  router.get('/status', (req, res) => {
    res.json({ status: engine ? engine.getStatus() : 'idle' });
  });

  // POST /api/execute — start pipeline execution
  router.post('/', (req, res) => {
    if (engine && engine.getStatus() !== 'idle') {
      return res.status(409).json({ error: 'Pipeline is already running' });
    }

    const { startFrom } = req.body;
    engine = new PipelineEngine();

    // Wire engine events to Socket.IO
    engine.on('log', (data) => io.emit('log', data));
    engine.on('account-status', (data) => io.emit('account-status', data));
    engine.on('complete', (data) => io.emit('complete', data));

    // Start without awaiting — returns immediately
    engine.start(startFrom || 0).catch((err) => {
      io.emit('log', {
        email: '',
        phase: 'error',
        message: `Pipeline error: ${err.message}`,
        timestamp: new Date().toISOString(),
      });
    });

    res.json({ message: 'Pipeline started' });
  });

  // POST /api/execute/stop — stop pipeline execution
  router.post('/stop', (req, res) => {
    if (!engine || engine.getStatus() !== 'running') {
      return res.status(400).json({ error: 'Pipeline is not running' });
    }

    engine.stop();
    res.json({ message: 'Stop requested' });
  });

  return router;
};
