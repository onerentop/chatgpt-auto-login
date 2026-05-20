const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const { initDB } = require('./db');

const authRoutes = require('./routes/auth');
const { authMiddleware } = require('./routes/auth');
const configRoutes = require('./routes/config');

const JWT_SECRET = 'chatgpt-auto-login-web';

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// Socket.IO authentication middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error('Authentication error: no token provided'));
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (err) {
    return next(new Error('Authentication error: invalid or expired token'));
  }
});

app.use(cors());
app.use(express.json());

// Init DB then mount routes
initDB().then(() => {
  const accountsRoutes = require('./routes/accounts');
  const executeRoutes = require('./routes/execute');
  const resultsRoutes = require('./routes/results');

  app.use('/api/auth', authRoutes);
  app.use('/api/accounts', authMiddleware, accountsRoutes);
  app.use('/api/config', authMiddleware, configRoutes);
  app.use('/api/execute', authMiddleware, executeRoutes(io));
  app.use('/api/results', authMiddleware, resultsRoutes);

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
