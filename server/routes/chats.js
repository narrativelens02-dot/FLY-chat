'use strict';
const router = require('express').Router();
const auth   = require('../middleware/auth');
const { sql } = require('../db');
const { v4: uuid } = require('uuid');
const { ah, emitTo } = require('../utils');

/* ════════════════════════════════════════
   HELPERS
════════════════════════════════════════ */
async function assertParticipant(chatId, userId, res) {
  const [c] = await sql`SELECT * FROM chats WHERE id = ${chatId}`;
  if (!c) { res.status(404).json({ error: 'Chat tidak ditemukan' }); return null; }
  if (c.participant1_id !== userId && c.participant2_id !== userId) {
    res.status(403).json({ error: 'Akses ditolak' }); return null;
  }
  return c;
}

async function reactionMapFor(messageIds) {
  if (!messageIds.length) return {};
  const rows = await sql`
    SELECT message_id, user_id, emoji
    FROM reactions
    WHERE message_id = ANY(${messageIds})
  `;
  const map = {};
  rows.forEach(r => {
    if (!map[r.message_id]) map[r.message_id] = {};
    map[r.message_id][r.user_id] = r.emoji;
  });
  return map;
}

async function reactionRowsForChat(chatId) {
  return sql`
    SELECT r.message_id, r.user_id, r.emoji
    FROM reactions r
    JOIN messages m ON m.id = r.message_id
    WHERE m.chat_id = ${chatId}
  `;
}

/* Typing indicator (ephemeral, per-instance) */
const typingStore = new Map();
const TYPING_TTL  = 5000;

function setTyping(chatId, userId, name, on) {
  const key = `${chatId}:${userId}`;
  if (on) typingStore.set(key, { name, updated_at: Date.now() });
  else typingStore.delete(key);
}

function activeTypers(chatId, exceptUserId) {
  const now = Date.now();
  const out = [];
  for (const [key, val] of typingStore) {
    if (now - val.updated_at > TYPING_TTL) { typingStore.delete(key); continue; }
    const sep = key.lastIndexOf(':');
    const keyChat = key.slice(0, sep);
    const keyUser = key.slice(sep + 1);
    if (keyChat !== chatId || keyUser === exceptUserId) continue;
    out.push({ user_id: keyUser, name: val.name });
  }
  return out;
}

/* ════════════════════════════════════════
   LIST MY CHATS
════════════════════════════════════════ */
router.get('/', auth, ah(async (req, res) => {
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
}));

/* ════════════════════════════════════════
   FIND OR CREATE CHAT
════════════════════════════════════════ */
router.post('/', auth, ah(async (req, res) => {
  const { partner_id } = req.body || {};
  if (!partner_id) return res.status(400).json({ error: 'partner_id diperlukan' });
  if (partner_id === req.user.id) return res.status(400).json({ error: 'Tidak bisa chat dengan diri sendiri' });

  const [partner] = await sql`SELECT id FROM users WHERE id = ${partner_id}`;
  if (!partner) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });

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
    ON CONFLICT DO NOTHING
  `;

  const [row] = await sql`
    SELECT id FROM chats
    WHERE (participant1_id = ${req.user.id} AND participant2_id = ${partner_id})
       OR (participant1_id = ${partner_id}   AND participant2_id = ${req.user.id})
    LIMIT 1
  `;

  res.status(201).json({ chat_id: row?.id || chatId, created: true });
}));

/* ════════════════════════════════════════
   WEBRTC SIGNALING — disimpan di Postgres
   (persisten, aman untuk Vercel / multi-instance)
════════════════════════════════════════ */
router.get('/rtc/incoming', auth, ah(async (req, res) => {
  const rows = await sql`
    SELECT * FROM rtc_signals
    WHERE target_id = ${req.user.id}
      AND created_at > NOW() - INTERVAL '40 seconds'
    ORDER BY created_at DESC
  `;

  const parsed = rows.map(r => {
    let sig = null;
    try { sig = JSON.parse(r.content); } catch {}
    return { row: r, sig };
  }).filter(x => x.sig && x.sig.__rtc__);

  let activeOffer = null;
  for (const item of parsed) {
    if (item.sig.action !== 'offer') continue;
    const cancelled = parsed.some(p =>
      p.sig.callId === item.sig.callId &&
      (p.sig.action === 'end' || p.sig.action === 'reject')
    );
    if (!cancelled) {
      activeOffer = {
        chat_id:    item.row.chat_id,
        sender_id:  item.row.sender_id,
        signal:     item.sig,
        created_at: item.row.created_at
      };
      break;
    }
  }

  res.json({ incoming: activeOffer });
}));

router.get('/:id/rtc', auth, ah(async (req, res) => {
  const c = await assertParticipant(req.params.id, req.user.id, res);
  if (!c) return;

  const since = req.query.since || req.query.after;
  const signals = since
    ? await sql`
        SELECT * FROM rtc_signals
        WHERE chat_id = ${req.params.id}
          AND sender_id <> ${req.user.id}
          AND created_at > ${since}::timestamptz
        ORDER BY created_at ASC
      `
    : await sql`
        SELECT * FROM rtc_signals
        WHERE chat_id = ${req.params.id}
          AND sender_id <> ${req.user.id}
          AND created_at > NOW() - INTERVAL '40 seconds'
        ORDER BY created_at ASC
      `;

  res.json({ signals });
}));

/* ════════════════════════════════════════
   MARK CHAT AS READ
════════════════════════════════════════ */
router.patch('/:id/read', auth, ah(async (req, res) => {
  const c = await assertParticipant(req.params.id, req.user.id, res);
  if (!c) return;

  if (c.participant1_id === req.user.id) {
    await sql`UPDATE chats SET unread1 = 0 WHERE id = ${req.params.id}`;
  } else {
    await sql`UPDATE chats SET unread2 = 0 WHERE id = ${req.params.id}`;
  }
  res.json({ ok: true });
}));

/* ════════════════════════════════════════
   GET MESSAGES
════════════════════════════════════════ */
router.get('/:id/messages', auth, ah(async (req, res) => {
  const c = await assertParticipant(req.params.id, req.user.id, res);
  if (!c) return;

  const limit        = Math.min(parseInt(req.query.limit) || 100, 200);
  const before       = req.query.before;
  const after        = req.query.after;          // polling incremental
  const deletedAfter = req.query.deleted_after;  // polling penghapusan

  let rows;
  if (after) {
    rows = await sql`
      SELECT m.*, u.name AS sender_name, u.photo_url AS sender_photo
      FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.chat_id = ${req.params.id}
        AND m.created_at > ${after}::timestamptz
      ORDER BY m.created_at DESC LIMIT ${limit}
    `;
  } else if (before) {
    rows = await sql`
      SELECT m.*, u.name AS sender_name, u.photo_url AS sender_photo
      FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.chat_id = ${req.params.id}
        AND m.created_at < ${before}::timestamptz
      ORDER BY m.created_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT m.*, u.name AS sender_name, u.photo_url AS sender_photo
      FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.chat_id = ${req.params.id}
      ORDER BY m.created_at DESC LIMIT ${limit}
    `;
  }

  const messages = rows.reverse();
  const reactionMap = await reactionMapFor(messages.map(m => m.id));
  const result = messages.map(m => ({ ...m, reactions: reactionMap[m.id] || {} }));

  const extras = { reactions: [], deleted: [], typing: [] };
  if (after) {
    extras.reactions = await reactionRowsForChat(req.params.id);
    extras.deleted = deletedAfter
      ? await sql`
          SELECT id, deleted_at FROM messages
          WHERE chat_id = ${req.params.id} AND is_deleted = TRUE
            AND deleted_at > ${deletedAfter}::timestamptz
        `
      : await sql`
          SELECT id, deleted_at FROM messages
          WHERE chat_id = ${req.params.id} AND is_deleted = TRUE AND deleted_at IS NOT NULL
        `;
    extras.typing = activeTypers(req.params.id, req.user.id);
  }

  res.json({ messages: result, ...extras });
}));

/* ════════════════════════════════════════
   SEND MESSAGE
════════════════════════════════════════ */
router.post('/:id/messages', auth, ah(async (req, res) => {
  const c = await assertParticipant(req.params.id, req.user.id, res);
  if (!c) return;

  const { type = 'text', content = '', file_url = '', file_name = '',
          file_size = '', caption = '', lat, lng, location_name = '',
          reply_to_id, reply_to_sender = '', reply_to_text = '' } = req.body || {};

  if (type === 'text' && String(content).length > 4000) {
    return res.status(400).json({ error: 'Pesan terlalu panjang (maks 4000 karakter)' });
  }

  /* ── WebRTC signaling: simpan di DB, TIDAK masuk messages ── */
  if (type === 'text' && content) {
    let sig;
    try { sig = JSON.parse(content); } catch {}
    if (sig?.__rtc__ === true) {
      const targetId = c.participant1_id === req.user.id ? c.participant2_id : c.participant1_id;

      await sql`
        INSERT INTO rtc_signals (id, chat_id, sender_id, target_id, call_id, content)
        VALUES (${uuid()}, ${req.params.id}, ${req.user.id}, ${targetId},
                ${sig.callId || null}, ${content})
      `;
      // Bersihkan sinyal lama agar tabel tidak membengkak
      await sql`DELETE FROM rtc_signals WHERE created_at < NOW() - INTERVAL '10 minutes'`;

      return res.status(201).json({
        message: {
          id: `rtc_${Date.now()}`,
          chat_id: req.params.id,
          sender_id: req.user.id,
          type: 'text',
          content,
          created_at: new Date().toISOString(),
          reactions: {}
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

  /* Update chat meta + increment unread for partner */
  const isP1   = c.participant1_id === req.user.id;
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

  const [sender] = await sql`SELECT name, photo_url FROM users WHERE id = ${req.user.id}`;
  const message = {
    ...msg,
    sender_name:  sender?.name || req.user.name,
    sender_photo: sender?.photo_url || '',
    reactions:    {}
  };

  emitTo(req, `chat:${req.params.id}`, 'message:new', { chatId: req.params.id, message });
  emitTo(req, `chat:${req.params.id}`, 'chat:updated', { chatId: req.params.id });

  res.status(201).json({ message });
}));

/* ════════════════════════════════════════
   DELETE MESSAGE
════════════════════════════════════════ */
router.delete('/:chatId/messages/:msgId', auth, ah(async (req, res) => {
  const { chatId, msgId } = req.params;

  const [msg] = await sql`
    SELECT * FROM messages WHERE id = ${msgId} AND chat_id = ${chatId}
  `;
  if (!msg) return res.status(404).json({ error: 'Pesan tidak ditemukan' });
  if (msg.sender_id !== req.user.id) {
    return res.status(403).json({ error: 'Hanya bisa hapus pesan sendiri' });
  }

  await sql`
    UPDATE messages SET is_deleted = TRUE, deleted_at = NOW() WHERE id = ${msgId}
  `;
  emitTo(req, `chat:${chatId}`, 'message:deleted', { chatId, msgId });
  res.json({ ok: true });
}));

/* ════════════════════════════════════════
   CLEAR ALL MESSAGES
════════════════════════════════════════ */
router.delete('/:id/messages', auth, ah(async (req, res) => {
  const c = await assertParticipant(req.params.id, req.user.id, res);
  if (!c) return;

  await sql`
    UPDATE messages SET is_deleted = TRUE, deleted_at = NOW()
    WHERE chat_id = ${req.params.id} AND is_deleted = FALSE
  `;
  await sql`
    UPDATE chats SET last_message = '', last_message_at = NOW()
    WHERE id = ${req.params.id}
  `;
  emitTo(req, `chat:${req.params.id}`, 'chat:cleared', { chatId: req.params.id });
  res.json({ ok: true });
}));

/* ════════════════════════════════════════
   REACTIONS (toggle: klik emoji sama = hapus)
════════════════════════════════════════ */
router.patch('/:chatId/messages/:msgId/reactions', auth, ah(async (req, res) => {
  const { chatId, msgId } = req.params;
  const { emoji } = req.body || {};
  if (!emoji) return res.status(400).json({ error: 'emoji diperlukan' });

  const c = await assertParticipant(chatId, req.user.id, res);
  if (!c) return;

  const [msg] = await sql`
    SELECT id FROM messages WHERE id = ${msgId} AND chat_id = ${chatId}
  `;
  if (!msg) return res.status(404).json({ error: 'Pesan tidak ditemukan' });

  const [existing] = await sql`
    SELECT emoji FROM reactions WHERE message_id = ${msgId} AND user_id = ${req.user.id}
  `;

  let action;
  if (existing && existing.emoji === emoji) {
    await sql`
      DELETE FROM reactions
      WHERE message_id = ${msgId} AND user_id = ${req.user.id}
    `;
    action = 'removed';
  } else if (existing) {
    await sql`
      UPDATE reactions SET emoji = ${emoji}, updated_at = NOW()
      WHERE message_id = ${msgId} AND user_id = ${req.user.id}
    `;
    action = 'updated';
  } else {
    await sql`
      INSERT INTO reactions (message_id, user_id, emoji)
      VALUES (${msgId}, ${req.user.id}, ${emoji})
    `;
    action = 'added';
  }

  const map = await reactionMapFor([msgId]);
  const reactions = map[msgId] || {};

  emitTo(req, `chat:${chatId}`, 'message:reacted', { chatId, msgId, reactions });
  res.json({ ok: true, action, reactions });
}));

/* ════════════════════════════════════════
   TYPING (fallback REST untuk polling)
════════════════════════════════════════ */
router.post('/:id/typing', auth, ah(async (req, res) => {
  const c = await assertParticipant(req.params.id, req.user.id, res);
  if (!c) return;

  setTyping(req.params.id, req.user.id, req.user.name, req.body?.typing !== false);
  res.json({ ok: true });
}));

module.exports = router;
