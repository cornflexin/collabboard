/**
 * CollabBoard — Production-Grade Backend
 * Stack: Express + better-sqlite3 + JWT + WebSocket + Multer
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuid } = require('uuid');

const db = require('./db');
const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const taskRoutes = require('./routes/tasks');
const memberRoutes = require('./routes/members');
const activityRoutes = require('./routes/activity');
const uploadRoutes = require('./routes/upload');

const app = express();
const server = http.createServer(app);

// ── WEBSOCKET SERVER ──────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/ws' });

// room map: projectId -> Set<ws>
const rooms = new Map();

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.userId = null;
  ws.projectId = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleWsMessage(ws, msg);
    } catch (e) { /* ignore bad frames */ }
  });

  ws.on('close', () => {
    leaveRoom(ws);
  });
});

function broadcast(projectId, event, data, exceptWs = null) {
  const room = rooms.get(projectId);
  if (!room) return;
  const frame = JSON.stringify({ event, data, ts: Date.now() });
  for (const client of room) {
    if (client !== exceptWs && client.readyState === WebSocket.OPEN) {
      client.send(frame);
    }
  }
}

function joinRoom(ws, projectId) {
  leaveRoom(ws);
  ws.projectId = projectId;
  if (!rooms.has(projectId)) rooms.set(projectId, new Set());
  rooms.get(projectId).add(ws);
  // Send online presence to others
  broadcast(projectId, 'user:join', {
    userId: ws.userId, name: ws.userName, avatar: ws.userAvatar
  }, ws);
  // Tell the new joiner who's online
  const room = rooms.get(projectId);
  const online = [];
  for (const client of room) {
    if (client !== ws && client.userId) {
      online.push({ userId: client.userId, name: client.userName, avatar: client.userAvatar });
    }
  }
  ws.send(JSON.stringify({ event: 'room:online', data: online }));
}

function leaveRoom(ws) {
  if (ws.projectId) {
    const room = rooms.get(ws.projectId);
    if (room) {
      room.delete(ws);
      if (room.size === 0) rooms.delete(ws.projectId);
      else broadcast(ws.projectId, 'user:leave', { userId: ws.userId }, ws);
    }
    ws.projectId = null;
  }
}

function handleWsMessage(ws, msg) {
  const { type, payload } = msg;

  // Authenticate the socket on first message
  if (type === 'auth') {
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(payload.token, process.env.JWT_SECRET || 'cb_secret_2024');
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(decoded.userId);
      if (!user) return ws.close();
      ws.userId = user.id;
      ws.userName = user.name;
      ws.userAvatar = user.avatar;
      ws.send(JSON.stringify({ event: 'auth:ok', data: { userId: user.id } }));
    } catch { ws.close(); }
    return;
  }

  if (!ws.userId) return; // must auth first

  if (type === 'join') {
    // Verify user has access to project
    const member = db.prepare('SELECT * FROM project_members WHERE project_id=? AND user_id=?').get(payload.projectId, ws.userId);
    const owner = db.prepare('SELECT * FROM projects WHERE id=? AND owner_id=?').get(payload.projectId, ws.userId);
    if (!member && !owner) return;
    joinRoom(ws, payload.projectId);
    return;
  }

  if (type === 'leave') {
    leaveRoom(ws);
    return;
  }

  // Cursor position (real-time presence)
  if (type === 'cursor') {
    broadcast(ws.projectId, 'cursor', {
      userId: ws.userId, name: ws.userName, ...payload
    }, ws);
    return;
  }

  // Typing indicator
  if (type === 'typing') {
    broadcast(ws.projectId, 'typing', {
      userId: ws.userId, name: ws.userName, ...payload
    }, ws);
    return;
  }
}

// Export broadcast for use in routes
app.locals.broadcast = broadcast;
app.locals.wss = wss;

// ── MIDDLEWARE ────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many auth attempts, try again later.' }
});
app.use('/api/auth/', authLimiter);

// Static files
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use(express.static(path.join(__dirname, '../frontend')));

// ── API ROUTES ────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/members', memberRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/upload', uploadRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), ts: Date.now() });
});

// ── SPA FALLBACK ──────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ── HEARTBEAT ────────────────────────────────────────────
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

// ── START ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚀 CollabBoard running at http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`   Database: SQLite\n`);
});

module.exports = { app, broadcast };
