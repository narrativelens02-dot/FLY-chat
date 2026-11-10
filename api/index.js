/**
 * FLYchat — Vercel Serverless API Handler
 * Semua request /api/* ditangani di sini
 */
'use strict';
require('dotenv').config();

const express = require('express');
const cors    = require('cors');

const app = express();

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

/* Routes */
app.use('/api/auth',   require('../server/routes/auth'));
app.use('/api/users',  require('../server/routes/users'));
app.use('/api/chats',  require('../server/routes/chats'));

/* Health */
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString(), env: 'vercel' }));

/* File upload tidak didukung di Vercel Serverless (no disk write)
   Kembalikan error yang jelas */
app.use('/api/upload', (req, res) => {
  res.status(501).json({
    error: 'Upload file tidak tersedia di mode Vercel. Gunakan server lokal untuk upload.'
  });
});

module.exports = app;
