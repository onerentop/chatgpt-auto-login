const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db');

const configRoutes = require('./routes/config');

const app = express();
const server = http.createServer(app);

const ALLOWED_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] },
});

// Socket.IO — no auth
io.use((socket, next) => next());

app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());

// Init DB then mount routes
initDB().then(() => {
  const accountsRoutes = require('./routes/accounts');
  const executeRoutes = require('./routes/execute');
  const resultsRoutes = require('./routes/results');

  app.use('/api/accounts', accountsRoutes);
  app.use('/api/config', configRoutes);
  app.use('/api/execute', executeRoutes(io));
  app.use('/api/results', resultsRoutes);

  const distPath = path.join(__dirname, '..', 'web', 'dist');
  app.use(express.static(distPath));
  app.get(/^\/(?!api).*/, (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
