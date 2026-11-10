'use strict';
require('dotenv').config();

const express    = require('express');
const http       = require('http');
const path       = require('path');
const { Server } = require('socket.io');
const cors       = require('cors');
const jwt        = require('jsonwebtoken');
const { initDB, sql } = require('./db');

const app    = express();
const server = http.createServer(app);

/* ─── CORS: izinkan Vercel domain + localhost ─── */
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  // Vercel deployment URLs — tambahkan domain kamu setelah deploy
  process.env.FRONTEND_URL,           // e.g. https://flychat.vercel.app
  process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null
].filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman, same-origin)
    if (!origin) return callback(null, true);
    // Allow localhost dev
    if (origin.includes('localhost') || origin.includes('127.0.0.1'))
      return callback(null, true);
    // Allow any Vercel app
    if (origin.endsWith('.vercel.app')) return callback(null, true);
    // Allow any Render app
    if (origin.endsWith('.onrender.com')) return callback(null, true);
    // Allow any Railway app
    if (origin.endsWith('.railway.app') || origin.endsWith('.up.railway.app'))
      return callback(null, true);
    // Allow explicitly whitelisted origins
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    // Block everything else in production, allow in dev
    if (process.env.NODE_ENV !== 'production') return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (origin.includes('localhost') || origin.includes('127.0.0.1') ||
          origin.endsWith('.vercel.app') || origin.endsWith('.onrender.com') ||
          origin.endsWith('.railway.app') || ALLOWED_ORIGINS.includes(origin))
        return callback(null, true);
      if (process.env.NODE_ENV !== 'production') return callback(null, true);
      callback(new Error('Socket CORS blocked'));
    },
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;

/* ═══════════════════════════════════════
   MIDDLEWARE
═══════════════════════════════════════ */
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // preflight
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

/* Serve uploaded files */
app.use('/uploads', express.static(path.resolve(process.env.UPLOAD_DIR || 'uploads')));

/* Serve frontend static files dari public/ */
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ═══════════════════════════════════════
   API ROUTES
═══════════════════════════════════════ */
app.use('/api/auth',   require('./routes/auth'));
app.use('/api/users',  require('./routes/users'));
app.use('/api/chats',  require('./routes/chats'));
app.use('/api/upload', require('./routes/upload'));

/* Health check */
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* SPA fallback — semua route ke index.html */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

/* ═══════════════════════════════════════
   SOCKET.IO — Real-time layer
═══════════════════════════════════════ */

/** Authenticate socket via JWT query param atau header */
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('No token'));
  try {
    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

/* Map userId → Set<socketId> untuk multi-tab support */
const userSockets = new Map();

io.on('connection', async (socket) => {
  const userId = socket.user.id;
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socket.id);

  /* Set online */
  await sql`UPDATE users SET online = TRUE, last_seen = NOW() WHERE id = ${userId}`.catch(() => {});
  socket.broadcast.emit('user:online', { userId, online: true });

  console.log(`🔌 ${socket.user.name} connected (${socket.id})`);

  /* ── Join chat room ── */
  socket.on('chat:join', (chatId) => {
    socket.join(`chat:${chatId}`);
  });

  /* ── Leave chat room ── */
  socket.on('chat:leave', (chatId) => {
    socket.leave(`chat:${chatId}`);
  });

  /* ── Typing indicator ── */
  socket.on('typing:start', ({ chatId }) => {
    socket.to(`chat:${chatId}`).emit('typing:start', {
      chatId, userId, userName: socket.user.name
    });
  });

  socket.on('typing:stop', ({ chatId }) => {
    socket.to(`chat:${chatId}`).emit('typing:stop', { chatId, userId });
  });

  /* ── New message (broadcast ke room) ── */
  socket.on('message:new', ({ chatId, message }) => {
    socket.to(`chat:${chatId}`).emit('message:new', { chatId, message });
    /* Kirim notifikasi ke partner jika tidak di room */
    socket.to(`chat:${chatId}`).emit('chat:updated', { chatId });
  });

  /* ── Message deleted ── */
  socket.on('message:deleted', ({ chatId, msgId }) => {
    socket.to(`chat:${chatId}`).emit('message:deleted', { chatId, msgId });
  });

  /* ── Reaction added ── */
  socket.on('message:reacted', ({ chatId, msgId, userId: uid, emoji }) => {
    socket.to(`chat:${chatId}`).emit('message:reacted', { chatId, msgId, userId: uid, emoji });
  });

  /* ── Disconnect ── */
  socket.on('disconnect', async () => {
    const sockets = userSockets.get(userId);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        userSockets.delete(userId);
        await sql`UPDATE users SET online = FALSE, last_seen = NOW() WHERE id = ${userId}`.catch(() => {});
        io.emit('user:online', { userId, online: false });
        console.log(`❌ ${socket.user.name} disconnected`);
      }
    }
  });
});

/* ═══════════════════════════════════════
   START SERVER
═══════════════════════════════════════ */
(async () => {
  try {
    await initDB();
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`\n🦋 FLYchat server running`);
      console.log(`   Local:   http://localhost:${PORT}`);
      console.log(`   API:     http://localhost:${PORT}/api/health\n`);
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err.message);
    process.exit(1);
  }
})();
