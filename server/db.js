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

  await sql`
    CREATE TABLE IF NOT EXISTS password_resets (
      id         TEXT PRIMARY KEY,              -- UUID token
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      used       BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  /* ─── GRUP / GROUP CHAT ─── */
  await sql`
    CREATE TABLE IF NOT EXISTS chat_groups (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT DEFAULT '',
      photo_url   TEXT DEFAULT '',
      created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS chat_group_members (
      group_id   TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT NOT NULL DEFAULT 'member',   -- admin | member
      joined_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (group_id, user_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS chat_group_messages (
      id               TEXT PRIMARY KEY,
      group_id         TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
      sender_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type             TEXT NOT NULL DEFAULT 'text',
      content          TEXT DEFAULT '',
      file_url         TEXT DEFAULT '',
      file_name        TEXT DEFAULT '',
      file_size        TEXT DEFAULT '',
      caption          TEXT DEFAULT '',
      lat              DOUBLE PRECISION,
      lng              DOUBLE PRECISION,
      location_name    TEXT DEFAULT '',
      reply_to_id      TEXT,
      reply_to_sender  TEXT DEFAULT '',
      reply_to_text    TEXT DEFAULT '',
      is_deleted       BOOLEAN DEFAULT FALSE,
      deleted_at       TIMESTAMPTZ,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS chat_group_reactions (
      message_id TEXT NOT NULL REFERENCES chat_group_messages(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji      TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (message_id, user_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS chat_group_reads (
      group_id     TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_read_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (group_id, user_id)
    )
  `;

  /* ─── WEBRTC SIGNALING — persisten agar jalan di Vercel / multi-instance ─── */
  await sql`
    CREATE TABLE IF NOT EXISTS rtc_signals (
      id         TEXT PRIMARY KEY,
      chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      sender_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      call_id    TEXT,
      content    TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  /* ─── Penyimpanan file di database (fallback Vercel tanpa Cloudinary) ─── */
  await sql`
    CREATE TABLE IF NOT EXISTS uploaded_files (
      id          TEXT PRIMARY KEY,
      owner_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
      kind        TEXT NOT NULL DEFAULT 'chat',
      file_name   TEXT NOT NULL DEFAULT '',
      mime_type   TEXT NOT NULL DEFAULT 'application/octet-stream',
      file_size   BIGINT NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 1,
      status      TEXT NOT NULL DEFAULT 'ready',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS uploaded_file_chunks (
      file_id TEXT NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
      idx     INTEGER NOT NULL,
      data    BYTEA NOT NULL,
      PRIMARY KEY (file_id, idx)
    )
  `;

  /* Migrasi kolom tambahan untuk tabel lama */
  await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`;
  await sql`ALTER TABLE reactions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`;

  /* Indexes untuk performa */
  await sql`CREATE INDEX IF NOT EXISTS idx_chats_p1 ON chats(participant1_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_chats_p2 ON chats(participant2_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at ASC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_reset_user ON password_resets(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_group_members_user ON chat_group_members(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_group_messages_group ON chat_group_messages(group_id, created_at ASC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_group_reactions_message ON chat_group_reactions(message_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_rtc_signals_target ON rtc_signals(target_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_rtc_signals_chat ON rtc_signals(chat_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_uploaded_files_owner ON uploaded_files(owner_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_uploaded_files_pending ON uploaded_files(status, created_at)`;

  console.log('✅ Database schema ready');
}

module.exports = { sql, initDB };
