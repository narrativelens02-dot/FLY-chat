/**
 * FLYchat — Vercel Serverless API Handler
 * Semua request /api/* ditangani di sini.
 *
 * Keterbatasan Vercel Serverless:
 *  - Tidak ada Socket.io (stateless) → frontend pakai polling
 *  - Tidak ada disk write → upload file diblokir (perlu Cloudinary)
 *  - Cold start: request pertama mungkin lambat ~1-2 detik
 */
'use strict';
require('dotenv').config();

const express = require('express');
const cors    = require('cors');

const app = express();

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

/* ── Pastikan skema DB siap (idempotent, sekali per instance) ──
   Di Vercel server/index.js tidak dijalankan, jadi initDB dipanggil di sini. */
const { initDB } = require('../server/db');
let dbReady = null;
app.use(async (req, res, next) => {
  if (!dbReady) dbReady = initDB();
  try {
    await dbReady;
    next();
  } catch (err) {
    dbReady = null;
    next(err);
  }
});

/* ── Routes ── */
app.use('/api/auth',   require('../server/routes/auth'));
app.use('/api/users',  require('../server/routes/users'));
app.use('/api/chats',  require('../server/routes/chats'));
app.use('/api/groups', require('../server/routes/groups'));

/* Upload — Cloudinary support di Vercel (tidak ada disk write) */
app.use('/api/upload', require('../server/routes/upload'));

/* Health check */
app.get('/api/health', (req, res) => res.json({
  ok: true,
  time: new Date().toISOString(),
  env: process.env.NODE_ENV || 'unknown'
}));

/* Global error handler (Express 4 tidak menangkap error async otomatis) */
app.use((err, req, res, next) => {
  console.error('API error:', err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'Terjadi kesalahan server' });
});

module.exports = app;
