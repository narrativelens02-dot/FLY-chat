'use strict';
const router = require('express').Router();
const auth   = require('../middleware/auth');
const { sql } = require('../db');
const { v4: uuid } = require('uuid');

/**
 * In-memory store untuk sinyal WebRTC (offer/answer/ICE).
 * Tidak disimpan ke DB — hidup hanya 60 detik, cukup untuk handshake.
 * Array of { chat_id, sender_id, content, created_at }
 */
const rtcStore = [];

/* helper: apakah user adalah participant chat */
async function assertParticipant(chatId, userId, res) {
  const [c] = await sql`SELECT * FROM chats WHERE id = ${chatId}`;
  if (!c) { res.status(404).json({ error: 'Chat tidak ditemukan' }); return null; }
  if (c.participant1_id !== userId && c.participant2_id !== userId) {
    res.status(403).json({ error: 'Akses ditolak' }); return null;
  }
  return c;
}

/* ── List my chats ── */
router.get('/', auth, async (req, res) => {
  const rows = await sql`
    SELECT c.*,
      u1.id AS p1_id, u1.name AS p1_name, u1.photo_url AS p1_photo, u1.online AS p1_online, u1.show_online AS p1_show_online, u1.last_seen AS p1_last_seen,
      u2.id AS p2_id, u2.name AS p2_name, u2.photo_url AS p2_photo, u2.online AS p2_online, u2.show_online AS p2_show_online, u2.last_seen AS p2_last_seen
    FROM chats c
    JOIN users u1 ON u1.id = c.participant1_id
    JOIN users u2 ON u2.id = c.participant2_id
    WHERE c.participant1_id = ${req.user.id} OR c.participant2_id = ${req.user.id}
    ORDER BY c.last_message_at DESC
  `;

  const chats = rows.map(r => {
    const isP1 = r.participant1_id === req.user.id;
    const partner = {
      id:          isP1 ? r.p2_id       : r.p1_id,
      name:        isP1 ? r.p2_name     : r.p1_name,
      photo_url:   isP1 ? r.p2_photo    : r.p1_photo,
      online:      isP1 ? r.p2_online   : r.p1_online,
      show_online: isP1 ? r.p2_show_online : r.p1_show_online,
      last_seen:   isP1 ? r.p2_last_seen : r.p1_last_seen
    };
    return {
      id: r.id,
      partner,
      last_message:    r.last_message,
      last_message_at: r.last_message_at,
      unread: isP1 ? r.unread1 : r.unread2
    };
  });

  res.json({ chats });
});

/* ── Find or create chat ── */
router.post('/', auth, async (req, res) => {
  const { partner_id } = req.body;
  if (!partner_id) return res.status(400).json({ error: 'partner_id diperlukan' });
  if (partner_id === req.user.id) return res.status(400).json({ error: 'Tidak bisa chat dengan diri sendiri' });

  // Check exist (either direction)
  const [existing] = await sql`
    SELECT id FROM chats
    WHERE (participant1_id = ${req.user.id} AND participant2_id = ${partner_id})
       OR (participant1_id = ${partner_id}   AND participant2_id = ${req.user.id})
  `;
  if (existing) return res.json({ chat_id: existing.id, created: false });

  const chatId = uuid();
  await sql`
    INSERT INTO chats (id, participant1_id, participant2_id)
    VALUES (${chatId}, ${req.user.id}, ${partner_id})
  `;
  res.status(201).json({ chat_id: chatId, created: true });
});

/* ── Mark chat as read ── */
router.patch('/:id/read', auth, async (req, res) => {
  const c = await assertParticipant(req.params.id, req.user.id, res);
  if (!c) return;

  if (c.participant1_id === req.user.id) {
    await sql`UPDATE chats SET unread1 = 0 WHERE id = ${req.params.id}`;
  } else {
    await sql`UPDATE chats SET unread2 = 0 WHERE id = ${req.params.id}`;
  }
  res.json({ ok: true });
});

/* ── Get messages ── */
router.get('/:id/messages', auth, async (req, res) => {
  const c = await assertParticipant(req.params.id, req.user.id, res);
  if (!c) return;

  const limit  = Math.min(parseInt(req.query.limit) || 100, 200);
  const before = req.query.before;
  const after  = req.query.after;  // ← untuk polling incremental

  let messages;
  if (after) {
    // Ambil hanya pesan baru setelah timestamp tertentu (untuk polling)
    messages = await sql`
      SELECT m.*, u.name AS sender_name, u.photo_url AS sender_photo
      FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.chat_id = ${req.params.id}
        AND m.is_deleted = FALSE
        AND m.created_at > ${after}::timestamptz
      ORDER BY m.created_at ASC LIMIT ${limit}
    `;
  } else if (before) {
    messages = await sql`
      SELECT m.*, u.name AS sender_name, u.photo_url AS sender_photo
      FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.chat_id = ${req.params.id} AND m.is_deleted = FALSE
        AND m.created_at < ${before}
      ORDER BY m.created_at ASC LIMIT ${limit}
    `;
  } else {
    messages = await sql`
      SELECT m.*, u.name AS sender_name, u.photo_url AS sender_photo
      FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.chat_id = ${req.params.id} AND m.is_deleted = FALSE
      ORDER BY m.created_at ASC LIMIT ${limit}
    `;
  }

  // Attach reactions
  const msgIds = messages.map(m => m.id);
  const reactions = msgIds.length
    ? await sql`
        SELECT r.message_id, r.user_id, r.emoji, u.name AS user_name
        FROM reactions r JOIN users u ON u.id = r.user_id
        WHERE r.message_id = ANY(${msgIds})
      `
    : [];

  const reactionMap = {};
  reactions.forEach(r => {
    if (!reactionMap[r.message_id]) reactionMap[r.message_id] = {};
    reactionMap[r.message_id][r.user_id] = r.emoji;
  });

  const result = messages.map(m => ({ ...m, reactions: reactionMap[m.id] || {} }));

  // Jika request polling (after param), sertakan sinyal RTC dari in-memory store
  if (after) {
    const rtcSignals = rtcStore.filter(s =>
      s.chat_id === req.params.id &&
      s.sender_id !== req.user.id &&
      new Date(s.created_at) > new Date(after)
    );
    rtcSignals.forEach(s => {
      result.push({
        id:         `rtc_mem_${s.created_at}`,
        chat_id:    s.chat_id,
        sender_id:  s.sender_id,
        type:       'text',
        content:    s.content,
        created_at: s.created_at,
        is_deleted: false,
        reactions:  {}
      });
    });
    // Sort by created_at agar urut
    result.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }

  res.json({ messages: result });
});

/* ── Send message ── */
router.post('/:id/messages', auth, async (req, res) => {
  const c = await assertParticipant(req.params.id, req.user.id, res);
  if (!c) return;

  const { type = 'text', content = '', file_url = '', file_name = '',
          file_size = '', caption = '', lat, lng, location_name = '',
          reply_to_id, reply_to_sender = '', reply_to_text = '' } = req.body;

  // ── WebRTC signaling: simpan sementara di memori, TIDAK ke DB ──
  // Pesan dengan {__rtc__:true} adalah sinyal voice/video call,
  // bukan pesan chat sungguhan — jangan polusi DB
  if (type === 'text' && content) {
    let sig;
    try { sig = JSON.parse(content); } catch {}
    if (sig?.__rtc__ === true) {
      // Simpan ke in-memory store dengan TTL 60 detik
      rtcStore.push({
        chat_id:    req.params.id,
        sender_id:  req.user.id,
        content,
        created_at: new Date().toISOString()
      });
      // Hapus sinyal lama (>60 detik) untuk mencegah memory leak
      const cutoff = Date.now() - 60_000;
      while (rtcStore.length && new Date(rtcStore[0].created_at).getTime() < cutoff) {
        rtcStore.shift();
      }
      return res.status(201).json({
        message: {
          id: `rtc_${Date.now()}`, chat_id: req.params.id,
          sender_id: req.user.id, type: 'text', content,
          created_at: new Date().toISOString(), reactions: {}
        }
      });
    }
  }

  const msgId = uuid();
  const [msg] = await sql`
    INSERT INTO messages (id, chat_id, sender_id, type, content, file_url, file_name,
      file_size, caption, lat, lng, location_name, reply_to_id, reply_to_sender, reply_to_text)
    VALUES (
      ${msgId}, ${req.params.id}, ${req.user.id}, ${type}, ${content},
      ${file_url}, ${file_name}, ${file_size}, ${caption},
      ${lat || null}, ${lng || null}, ${location_name},
      ${reply_to_id || null}, ${reply_to_sender}, ${reply_to_text}
    )
    RETURNING *
  `;

  // Update chat meta + increment unread for partner
  const isP1 = c.participant1_id === req.user.id;
  const preview = content || caption || `[${type}]`;
  if (isP1) {
    await sql`
      UPDATE chats
      SET last_message = ${preview.substring(0, 80)},
          last_message_at = NOW(),
          unread2 = unread2 + 1
      WHERE id = ${req.params.id}
    `;
  } else {
    await sql`
      UPDATE chats
      SET last_message = ${preview.substring(0, 80)},
          last_message_at = NOW(),
          unread1 = unread1 + 1
      WHERE id = ${req.params.id}
    `;
  }

  res.status(201).json({ message: { ...msg, reactions: {} } });
});

/* ── Delete message ── */
router.delete('/:chatId/messages/:msgId', auth, async (req, res) => {
  const [msg] = await sql`SELECT * FROM messages WHERE id = ${req.params.msgId}`;
  if (!msg) return res.status(404).json({ error: 'Pesan tidak ditemukan' });
  if (msg.sender_id !== req.user.id) return res.status(403).json({ error: 'Hanya bisa hapus pesan sendiri' });

  await sql`UPDATE messages SET is_deleted = TRUE WHERE id = ${req.params.msgId}`;
  res.json({ ok: true });
});

/* ── Clear all messages ── */
router.delete('/:id/messages', auth, async (req, res) => {
  const c = await assertParticipant(req.params.id, req.user.id, res);
  if (!c) return;

  await sql`UPDATE messages SET is_deleted = TRUE WHERE chat_id = ${req.params.id}`;
  await sql`UPDATE chats SET last_message = '', last_message_at = NOW() WHERE id = ${req.params.id}`;
  res.json({ ok: true });
});

/* ── Add / update reaction ── */
router.patch('/:chatId/messages/:msgId/reactions', auth, async (req, res) => {
  const { emoji } = req.body;
  if (!emoji) return res.status(400).json({ error: 'emoji diperlukan' });

  await sql`
    INSERT INTO reactions (message_id, user_id, emoji)
    VALUES (${req.params.msgId}, ${req.user.id}, ${emoji})
    ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = ${emoji}
  `;
  res.json({ ok: true });
});

/* ── Typing indicator via REST (WebSocket lebih baik, ini fallback) ── */
router.post('/:id/typing', auth, (req, res) => {
  // Handled di Socket.io, ini hanya 200 OK
  res.json({ ok: true });
});

module.exports = router;
