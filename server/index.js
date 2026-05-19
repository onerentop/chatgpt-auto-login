const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/auth');
const { authMiddleware } = require('./routes/auth');
const accountsRoutes = require('./routes/accounts');
const configRoutes = require('./routes/config');
const executeRoutes = require('./routes/execute');
const resultsRoutes = require('./routes/results');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/accounts', authMiddleware, accountsRoutes);
app.use('/api/config', authMiddleware, configRoutes);
app.use('/api/execute', authMiddleware, executeRoutes(io));
app.use('/api/results', authMiddleware, resultsRoutes);

// Serve Vue static build
const distPath = path.join(__dirname, '..', 'web', 'dist');
app.use(express.static(distPath));

// Fallback: non-/api routes serve index.html (SPA support)
app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

module.exports = { app, server, io };
