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

/* ── Routes ── */
app.use('/api/auth',   require('../server/routes/auth'));
app.use('/api/users',  require('../server/routes/users'));
app.use('/api/chats',  require('../server/routes/chats'));

/* Upload — Cloudinary support di Vercel (tidak ada disk write) */
app.use('/api/upload', require('../server/routes/upload'));

/* Health check */
app.get('/api/health', (req, res) => res.json({
  ok: true,
  time: new Date().toISOString(),
  env: process.env.NODE_ENV || 'unknown'
}));

module.exports = app;
