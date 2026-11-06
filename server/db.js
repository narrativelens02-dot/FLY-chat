/**
 * Neon Postgres — Database connection & schema setup
 * Menggunakan @neondatabase/serverless driver (HTTP transport)
 */
'use strict';
require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL tidak ditemukan di .env');
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

/** Jalankan migrasi DDL saat server start */
async function initDB() {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,           -- UUID
      email       TEXT UNIQUE NOT NULL,
      password    TEXT,                        -- NULL untuk Google OAuth
      name        TEXT NOT NULL,
      photo_url   TEXT DEFAULT '',
      status      TEXT DEFAULT 'Hei, aku pakai FLYchat! 🦋',
      about       TEXT DEFAULT '',
      phone       TEXT DEFAULT '',
      online      BOOLEAN DEFAULT FALSE,
      show_online BOOLEAN DEFAULT TRUE,
      last_seen   TIMESTAMPTZ DEFAULT NOW(),
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS contacts (
      owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contact_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (owner_id, contact_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS chats (
      id               TEXT PRIMARY KEY,       -- UUID
      participant1_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      participant2_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_message     TEXT DEFAULT '',
      last_message_at  TIMESTAMPTZ DEFAULT NOW(),
      unread1          INT DEFAULT 0,           -- unread untuk participant1
      unread2          INT DEFAULT 0,           -- unread untuk participant2
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (participant1_id, participant2_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id               TEXT PRIMARY KEY,        -- UUID
      chat_id          TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      sender_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type             TEXT NOT NULL DEFAULT 'text',  -- text|image|video|document|location
      content          TEXT DEFAULT '',
      file_url         TEXT DEFAULT '',
      file_name        TEXT DEFAULT '',
      file_size        TEXT DEFAULT '',
      caption          TEXT DEFAULT '',
      lat              DOUBLE PRECISION,
      lng              DOUBLE PRECISION,
      location_name    TEXT DEFAULT '',
      reply_to_id      TEXT REFERENCES messages(id) ON DELETE SET NULL,
      reply_to_sender  TEXT DEFAULT '',
      reply_to_text    TEXT DEFAULT '',
      is_deleted       BOOLEAN DEFAULT FALSE,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS reactions (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji      TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id)
    )
  `;

  /* Indexes untuk performa */
  await sql`CREATE INDEX IF NOT EXISTS idx_chats_p1 ON chats(participant1_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_chats_p2 ON chats(participant2_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at ASC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id)`;

  console.log('✅ Database schema ready');
}

module.exports = { sql, initDB };
