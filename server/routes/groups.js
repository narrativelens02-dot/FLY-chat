'use strict';
/**
 * FLYchat — Group Chat Routes
 * Tabel: chat_groups, chat_group_members, chat_group_messages,
 *        chat_group_reactions, chat_group_reads
 */
const router = require('express').Router();
const auth   = require('../middleware/auth');
const { sql } = require('../db');
const { v4: uuid } = require('uuid');
const { ah, emitTo } = require('../utils');

/* ════════════════════════════════════════
   HELPERS
════════════════════════════════════════ */
async function getMembership(groupId, userId) {
  const [row] = await sql`
    SELECT role FROM chat_group_members
    WHERE group_id = ${groupId} AND user_id = ${userId}
  `;
  return row || null;
}

async function getGroupDetail(groupId, userId) {
  const [group] = await sql`
    SELECT g.*, m.role AS my_role,
      (SELECT COUNT(*)::int FROM chat_group_members cm WHERE cm.group_id = g.id) AS member_count
    FROM chat_groups g
    JOIN chat_group_members m ON m.group_id = g.id AND m.user_id = ${userId}
    WHERE g.id = ${groupId}
  `;
  if (!group) return null;

  const members = await sql`
    SELECT u.id, u.name, u.email, u.photo_url, u.status, u.online,
           gm.role, gm.joined_at
    FROM chat_group_members gm
    JOIN users u ON u.id = gm.user_id
    WHERE gm.group_id = ${groupId}
    ORDER BY CASE WHEN gm.role = 'admin' THEN 0 ELSE 1 END, u.name ASC
  `;

  return { ...group, members };
}

async function reactionMapFor(messageIds) {
  if (!messageIds.length) return {};
  const rows = await sql`
    SELECT message_id, user_id, emoji
    FROM chat_group_reactions
    WHERE message_id = ANY(${messageIds})
  `;
  const map = {};
  rows.forEach(r => {
    if (!map[r.message_id]) map[r.message_id] = {};
    map[r.message_id][r.user_id] = r.emoji;
  });
  return map;
}

async function reactionRowsForGroup(groupId) {
  return sql`
    SELECT r.message_id, r.user_id, r.emoji
    FROM chat_group_reactions r
    JOIN chat_group_messages m ON m.id = r.message_id
    WHERE m.group_id = ${groupId}
  `;
}

/* Typing indicator (ephemeral, per-instance — cukup untuk indikator) */
const typingStore = new Map();
const TYPING_TTL  = 5000;

function setTyping(groupId, userId, name, on) {
  const key = `${groupId}:${userId}`;
  if (on) typingStore.set(key, { name, updated_at: Date.now() });
  else typingStore.delete(key);
}

function activeTypers(groupId, exceptUserId) {
  const now = Date.now();
  const out = [];
  for (const [key, val] of typingStore) {
    if (now - val.updated_at > TYPING_TTL) { typingStore.delete(key); continue; }
    const sep = key.lastIndexOf(':');
    const keyGroup = key.slice(0, sep);
    const keyUser  = key.slice(sep + 1);
    if (keyGroup !== groupId || keyUser === exceptUserId) continue;
    out.push({ user_id: keyUser, name: val.name });
  }
  return out;
}

/* ════════════════════════════════════════
   LIST GROUPS
════════════════════════════════════════ */
router.get('/', auth, ah(async (req, res) => {
  const me = req.user.id;

  const rows = await sql`
    SELECT g.*, m.role AS my_role,
      (SELECT COUNT(*)::int FROM chat_group_members cm WHERE cm.group_id = g.id) AS member_count,
      (SELECT CASE
          WHEN msg.type = 'text'     THEN msg.content
          WHEN msg.type = 'image'    THEN '📷 Foto'
          WHEN msg.type = 'video'    THEN '🎥 Video'
          WHEN msg.type = 'location' THEN '📍 Lokasi'
          ELSE '📄 ' || COALESCE(NULLIF(msg.file_name, ''), 'Dokumen')
        END
        FROM chat_group_messages msg
        WHERE msg.group_id = g.id AND msg.is_deleted = FALSE
        ORDER BY msg.created_at DESC LIMIT 1) AS last_message,
      (SELECT msg.created_at FROM chat_group_messages msg
        WHERE msg.group_id = g.id AND msg.is_deleted = FALSE
        ORDER BY msg.created_at DESC LIMIT 1) AS last_message_at,
      (SELECT COUNT(*)::int FROM chat_group_messages msg
        WHERE msg.group_id = g.id AND msg.is_deleted = FALSE AND msg.sender_id <> ${me}
          AND msg.created_at > COALESCE(
            (SELECT r.last_read_at FROM chat_group_reads r
              WHERE r.group_id = g.id AND r.user_id = ${me}), 'epoch'::timestamptz)
      ) AS unread
    FROM chat_groups g
    JOIN chat_group_members m ON m.group_id = g.id AND m.user_id = ${me}
    ORDER BY last_message_at DESC NULLS LAST, g.created_at DESC
  `;

  const ids = rows.map(r => r.id);
  const memberRows = ids.length ? await sql`
    SELECT gm.group_id, u.id, u.name, u.photo_url, gm.role
    FROM chat_group_members gm
    JOIN users u ON u.id = gm.user_id
    WHERE gm.group_id = ANY(${ids})
    ORDER BY CASE WHEN gm.role = 'admin' THEN 0 ELSE 1 END, u.name ASC
  ` : [];

  const membersByGroup = {};
  memberRows.forEach(m => {
    if (!membersByGroup[m.group_id]) membersByGroup[m.group_id] = [];
    membersByGroup[m.group_id].push(m);
  });

  const groups = rows.map(g => ({
    ...g,
    members: membersByGroup[g.id] || []
  }));

  res.json({ groups });
}));

/* ════════════════════════════════════════
   CREATE GROUP
════════════════════════════════════════ */
router.post('/', auth, ah(async (req, res) => {
  const me = req.user.id;
  const { name, description = '', member_ids = [] } = req.body || {};

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Nama grup wajib diisi' });
  }
  if (String(name).trim().length > 80) {
    return res.status(400).json({ error: 'Nama grup maksimal 80 karakter' });
  }

  const groupId = uuid();
  await sql`
    INSERT INTO chat_groups (id, name, description, created_by)
    VALUES (${groupId}, ${String(name).trim()}, ${String(description || '').slice(0, 500)}, ${me})
  `;
  await sql`
    INSERT INTO chat_group_members (group_id, user_id, role)
    VALUES (${groupId}, ${me}, 'admin')
  `;

  const ids = [...new Set((Array.isArray(member_ids) ? member_ids : [])
    .filter(id => id && id !== me))].slice(0, 100);

  if (ids.length) {
    const valid = await sql`SELECT id FROM users WHERE id = ANY(${ids})`;
    for (const u of valid) {
      await sql`
        INSERT INTO chat_group_members (group_id, user_id, role)
        VALUES (${groupId}, ${u.id}, 'member')
        ON CONFLICT DO NOTHING
      `;
      await sql`
        INSERT INTO chat_group_reads (group_id, user_id, last_read_at)
        VALUES (${groupId}, ${u.id}, NOW())
        ON CONFLICT DO NOTHING
      `;
    }
  }

  const group = await getGroupDetail(groupId, me);
  res.status(201).json({ group });
}));

/* ════════════════════════════════════════
   GROUP DETAIL
════════════════════════════════════════ */
router.get('/:id', auth, ah(async (req, res) => {
  const group = await getGroupDetail(req.params.id, req.user.id);
  if (!group) return res.status(404).json({ error: 'Grup tidak ditemukan atau kamu bukan anggota' });
  res.json({ group });
}));

/* ════════════════════════════════════════
   UPDATE GROUP (admin)
════════════════════════════════════════ */
router.patch('/:id', auth, ah(async (req, res) => {
  const membership = await getMembership(req.params.id, req.user.id);
  if (!membership) return res.status(403).json({ error: 'Kamu bukan anggota grup' });
  if (membership.role !== 'admin') return res.status(403).json({ error: 'Hanya admin yang bisa mengubah grup' });

  const { name, description, photo_url } = req.body || {};
  const [group] = await sql`
    UPDATE chat_groups SET
      name        = COALESCE(${name ? String(name).trim() : null}, name),
      description = COALESCE(${description ?? null}, description),
      photo_url   = COALESCE(${photo_url ?? null}, photo_url)
    WHERE id = ${req.params.id}
    RETURNING *
  `;
  emitTo(req, `group:${req.params.id}`, 'group:updated', { groupId: req.params.id });
  res.json({ group });
}));

/* ════════════════════════════════════════
   DELETE GROUP (admin)
════════════════════════════════════════ */
router.delete('/:id', auth, ah(async (req, res) => {
  const membership = await getMembership(req.params.id, req.user.id);
  if (!membership) return res.status(403).json({ error: 'Kamu bukan anggota grup' });
  if (membership.role !== 'admin') return res.status(403).json({ error: 'Hanya admin yang bisa menghapus grup' });

  await sql`DELETE FROM chat_groups WHERE id = ${req.params.id}`;
  emitTo(req, `group:${req.params.id}`, 'group:deleted', { groupId: req.params.id });
  res.json({ ok: true });
}));

/* ════════════════════════════════════════
   MEMBERS
════════════════════════════════════════ */
router.post('/:id/members', auth, ah(async (req, res) => {
  const membership = await getMembership(req.params.id, req.user.id);
  if (!membership) return res.status(403).json({ error: 'Kamu bukan anggota grup' });
  if (membership.role !== 'admin') return res.status(403).json({ error: 'Hanya admin yang bisa menambah anggota' });

  const ids = [...new Set((Array.isArray(req.body?.user_ids) ? req.body.user_ids : [])
    .filter(Boolean))].slice(0, 100);
  if (!ids.length) return res.status(400).json({ error: 'Pilih minimal 1 anggota' });

  const valid = await sql`SELECT id FROM users WHERE id = ANY(${ids})`;
  for (const u of valid) {
    await sql`
      INSERT INTO chat_group_members (group_id, user_id, role)
      VALUES (${req.params.id}, ${u.id}, 'member')
      ON CONFLICT DO NOTHING
    `;
    await sql`
      INSERT INTO chat_group_reads (group_id, user_id, last_read_at)
      VALUES (${req.params.id}, ${u.id}, NOW())
      ON CONFLICT DO NOTHING
    `;
  }

  const group = await getGroupDetail(req.params.id, req.user.id);
  emitTo(req, `group:${req.params.id}`, 'group:updated', { groupId: req.params.id });
  res.json({ group });
}));

router.delete('/:id/members/:userId', auth, ah(async (req, res) => {
  const { id: groupId, userId } = req.params;
  const membership = await getMembership(groupId, req.user.id);
  if (!membership) return res.status(403).json({ error: 'Kamu bukan anggota grup' });

  const isSelf = userId === req.user.id;
  if (!isSelf && membership.role !== 'admin') {
    return res.status(403).json({ error: 'Hanya admin yang bisa mengeluarkan anggota' });
  }

  const target = await getMembership(groupId, userId);
  if (!target) return res.status(404).json({ error: 'Anggota tidak ditemukan' });

  await sql`
    DELETE FROM chat_group_members
    WHERE group_id = ${groupId} AND user_id = ${userId}
  `;

  const [countRow] = await sql`
    SELECT COUNT(*)::int AS count FROM chat_group_members WHERE group_id = ${groupId}
  `;

  if (countRow.count === 0) {
    await sql`DELETE FROM chat_groups WHERE id = ${groupId}`;
  } else {
    const [admin] = await sql`
      SELECT user_id FROM chat_group_members
      WHERE group_id = ${groupId} AND role = 'admin' LIMIT 1
    `;
    if (!admin) {
      const [next] = await sql`
        SELECT user_id FROM chat_group_members
        WHERE group_id = ${groupId} ORDER BY joined_at ASC LIMIT 1
      `;
      if (next) {
        await sql`
          UPDATE chat_group_members SET role = 'admin'
          WHERE group_id = ${groupId} AND user_id = ${next.user_id}
        `;
      }
    }
  }

  emitTo(req, `group:${groupId}`, 'group:updated', { groupId });
  res.json({ ok: true });
}));

/* ════════════════════════════════════════
   MESSAGES
════════════════════════════════════════ */
router.get('/:id/messages', auth, ah(async (req, res) => {
  const groupId = req.params.id;
  const me = req.user.id;

  const membership = await getMembership(groupId, me);
  if (!membership) return res.status(403).json({ error: 'Kamu bukan anggota grup' });

  const limit = Math.min(parseInt(req.query.limit) || 100, 200);
  const after = req.query.after;
  const before = req.query.before;
  const deletedAfter = req.query.deleted_after;

  let rows;
  if (after) {
    rows = await sql`
      SELECT m.*, u.name AS sender_name, u.photo_url AS sender_photo
      FROM chat_group_messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.group_id = ${groupId} AND m.created_at > ${after}::timestamptz
      ORDER BY m.created_at DESC LIMIT ${limit}
    `;
  } else if (before) {
    rows = await sql`
      SELECT m.*, u.name AS sender_name, u.photo_url AS sender_photo
      FROM chat_group_messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.group_id = ${groupId} AND m.created_at < ${before}::timestamptz
      ORDER BY m.created_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT m.*, u.name AS sender_name, u.photo_url AS sender_photo
      FROM chat_group_messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.group_id = ${groupId}
      ORDER BY m.created_at DESC LIMIT ${limit}
    `;
  }

  const messages = rows.reverse();
  const reactionMap = await reactionMapFor(messages.map(m => m.id));
  const result = messages.map(m => ({ ...m, reactions: reactionMap[m.id] || {} }));

  const extras = { reactions: [], deleted: [], typing: [] };
  if (after) {
    extras.reactions = await reactionRowsForGroup(groupId);
    extras.deleted = deletedAfter
      ? await sql`
          SELECT id, deleted_at FROM chat_group_messages
          WHERE group_id = ${groupId} AND is_deleted = TRUE
            AND deleted_at > ${deletedAfter}::timestamptz
        `
      : await sql`
          SELECT id, deleted_at FROM chat_group_messages
          WHERE group_id = ${groupId} AND is_deleted = TRUE AND deleted_at IS NOT NULL
        `;
    extras.typing = activeTypers(groupId, me);
  }

  res.json({ messages: result, ...extras });
}));

router.post('/:id/messages', auth, ah(async (req, res) => {
  const groupId = req.params.id;
  const me = req.user.id;

  const membership = await getMembership(groupId, me);
  if (!membership) return res.status(403).json({ error: 'Kamu bukan anggota grup' });

  const { type = 'text', content = '', file_url = '', file_name = '',
          file_size = '', caption = '', lat, lng, location_name = '',
          reply_to_id, reply_to_sender = '', reply_to_text = '' } = req.body || {};

  if (type === 'text' && String(content).length > 4000) {
    return res.status(400).json({ error: 'Pesan terlalu panjang (maks 4000 karakter)' });
  }

  const msgId = uuid();
  const [msg] = await sql`
    INSERT INTO chat_group_messages
      (id, group_id, sender_id, type, content, file_url, file_name, file_size,
       caption, lat, lng, location_name, reply_to_id, reply_to_sender, reply_to_text)
    VALUES (
      ${msgId}, ${groupId}, ${me}, ${type}, ${content},
      ${file_url}, ${file_name}, ${file_size}, ${caption},
      ${lat || null}, ${lng || null}, ${location_name},
      ${reply_to_id || null}, ${reply_to_sender}, ${reply_to_text}
    )
    RETURNING *
  `;

  const [sender] = await sql`SELECT name, photo_url FROM users WHERE id = ${me}`;
  const message = {
    ...msg,
    sender_name:  sender?.name || req.user.name,
    sender_photo: sender?.photo_url || '',
    reactions:    {}
  };

  emitTo(req, `group:${groupId}`, 'group:message:new', { groupId, message });
  res.status(201).json({ message });
}));

router.delete('/:id/messages/:msgId', auth, ah(async (req, res) => {
  const { id: groupId, msgId } = req.params;
  const me = req.user.id;

  const membership = await getMembership(groupId, me);
  if (!membership) return res.status(403).json({ error: 'Kamu bukan anggota grup' });

  const [msg] = await sql`
    SELECT * FROM chat_group_messages WHERE id = ${msgId} AND group_id = ${groupId}
  `;
  if (!msg) return res.status(404).json({ error: 'Pesan tidak ditemukan' });
  if (msg.sender_id !== me && membership.role !== 'admin') {
    return res.status(403).json({ error: 'Hanya pengirim atau admin yang bisa menghapus pesan' });
  }

  await sql`
    UPDATE chat_group_messages
    SET is_deleted = TRUE, deleted_at = NOW()
    WHERE id = ${msgId}
  `;
  emitTo(req, `group:${groupId}`, 'group:message:deleted', { groupId, msgId });
  res.json({ ok: true });
}));

router.delete('/:id/messages', auth, ah(async (req, res) => {
  const groupId = req.params.id;
  const membership = await getMembership(groupId, req.user.id);
  if (!membership) return res.status(403).json({ error: 'Kamu bukan anggota grup' });
  if (membership.role !== 'admin') return res.status(403).json({ error: 'Hanya admin yang bisa menghapus riwayat grup' });

  await sql`
    UPDATE chat_group_messages
    SET is_deleted = TRUE, deleted_at = NOW()
    WHERE group_id = ${groupId} AND is_deleted = FALSE
  `;
  emitTo(req, `group:${groupId}`, 'group:cleared', { groupId });
  res.json({ ok: true });
}));

/* ════════════════════════════════════════
   REACTIONS (toggle)
════════════════════════════════════════ */
router.patch('/:id/messages/:msgId/reactions', auth, ah(async (req, res) => {
  const { id: groupId, msgId } = req.params;
  const me = req.user.id;
  const { emoji } = req.body || {};

  if (!emoji) return res.status(400).json({ error: 'emoji diperlukan' });

  const membership = await getMembership(groupId, me);
  if (!membership) return res.status(403).json({ error: 'Kamu bukan anggota grup' });

  const [msg] = await sql`
    SELECT id FROM chat_group_messages WHERE id = ${msgId} AND group_id = ${groupId}
  `;
  if (!msg) return res.status(404).json({ error: 'Pesan tidak ditemukan' });

  const [existing] = await sql`
    SELECT emoji FROM chat_group_reactions
    WHERE message_id = ${msgId} AND user_id = ${me}
  `;

  let action;
  if (existing && existing.emoji === emoji) {
    await sql`DELETE FROM chat_group_reactions WHERE message_id = ${msgId} AND user_id = ${me}`;
    action = 'removed';
  } else if (existing) {
    await sql`
      UPDATE chat_group_reactions SET emoji = ${emoji}, updated_at = NOW()
      WHERE message_id = ${msgId} AND user_id = ${me}
    `;
    action = 'updated';
  } else {
    await sql`
      INSERT INTO chat_group_reactions (message_id, user_id, emoji)
      VALUES (${msgId}, ${me}, ${emoji})
    `;
    action = 'added';
  }

  const map = await reactionMapFor([msgId]);
  const reactions = map[msgId] || {};

  emitTo(req, `group:${groupId}`, 'group:message:reacted', { groupId, msgId, reactions });
  res.json({ ok: true, action, reactions });
}));

/* ════════════════════════════════════════
   READ & TYPING
════════════════════════════════════════ */
router.post('/:id/read', auth, ah(async (req, res) => {
  const groupId = req.params.id;
  const me = req.user.id;

  const membership = await getMembership(groupId, me);
  if (!membership) return res.status(403).json({ error: 'Kamu bukan anggota grup' });

  await sql`
    INSERT INTO chat_group_reads (group_id, user_id, last_read_at)
    VALUES (${groupId}, ${me}, NOW())
    ON CONFLICT (group_id, user_id) DO UPDATE SET last_read_at = NOW()
  `;
  res.json({ ok: true });
}));

router.post('/:id/typing', auth, ah(async (req, res) => {
  const groupId = req.params.id;
  const me = req.user.id;

  const membership = await getMembership(groupId, me);
  if (!membership) return res.status(403).json({ error: 'Kamu bukan anggota grup' });

  setTyping(groupId, me, req.user.name, req.body?.typing !== false);
  res.json({ ok: true });
}));

module.exports = router;
