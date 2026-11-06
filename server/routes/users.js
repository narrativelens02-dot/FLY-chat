'use strict';
const router = require('express').Router();
const auth   = require('../middleware/auth');
const { sql } = require('../db');

/* ── Search user by email ── */
router.get('/search', auth, async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Parameter email diperlukan' });
  if (email.toLowerCase() === req.user.email.toLowerCase())
    return res.status(400).json({ error: 'Tidak bisa mencari diri sendiri' });

  const [user] = await sql`
    SELECT id, email, name, photo_url, status, about, online, show_online, last_seen
    FROM users WHERE email = ${email.toLowerCase()}
  `;
  if (!user) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
  res.json({ user });
});

/* ── Get single user ── */
router.get('/:id', auth, async (req, res) => {
  const [user] = await sql`
    SELECT id, email, name, photo_url, status, about, online, show_online, last_seen
    FROM users WHERE id = ${req.params.id}
  `;
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
  res.json({ user });
});

/* ── Update my profile ── */
router.patch('/me', auth, async (req, res) => {
  const { name, status, about, phone, show_online, photo_url } = req.body;

  // Build update using explicit fields to avoid sql injection
  const [user] = await sql`
    UPDATE users SET
      name        = COALESCE(${name        ?? null}, name),
      status      = COALESCE(${status      ?? null}, status),
      about       = COALESCE(${about       ?? null}, about),
      phone       = COALESCE(${phone       ?? null}, phone),
      show_online = COALESCE(${show_online ?? null}, show_online),
      photo_url   = COALESCE(${photo_url   ?? null}, photo_url)
    WHERE id = ${req.user.id}
    RETURNING id, email, name, photo_url, status, about, phone, show_online
  `;
  res.json({ user });
});

/* ── Update online presence ── */
router.patch('/me/presence', auth, async (req, res) => {
  const { online } = req.body;
  await sql`
    UPDATE users SET online = ${Boolean(online)}, last_seen = NOW()
    WHERE id = ${req.user.id}
  `;
  res.json({ ok: true });
});

/* ── Get my contacts ── */
router.get('/me/contacts', auth, async (req, res) => {
  const rows = await sql`
    SELECT u.id, u.email, u.name, u.photo_url, u.status, u.online, u.show_online, u.last_seen
    FROM contacts c
    JOIN users u ON u.id = c.contact_id
    WHERE c.owner_id = ${req.user.id}
    ORDER BY u.name ASC
  `;
  res.json({ contacts: rows });
});

/* ── Add contact ── */
router.post('/me/contacts', auth, async (req, res) => {
  const { contact_id } = req.body;
  if (!contact_id) return res.status(400).json({ error: 'contact_id diperlukan' });
  await sql`
    INSERT INTO contacts (owner_id, contact_id) VALUES (${req.user.id}, ${contact_id})
    ON CONFLICT DO NOTHING
  `;
  res.json({ ok: true });
});

module.exports = router;
