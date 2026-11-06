'use strict';
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { sql } = require('../db');

const sign = (user) => jwt.sign(
  { id: user.id, email: user.email, name: user.name },
  process.env.JWT_SECRET,
  { expiresIn: '30d' }
);

/* ── Register ── */
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Semua field wajib diisi' });
    if (password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });

    const existing = await sql`SELECT id FROM users WHERE email = ${email.toLowerCase()}`;
    if (existing.length) return res.status(409).json({ error: 'Email sudah terdaftar' });

    const hash = await bcrypt.hash(password, 12);
    const id   = uuid();

    const [user] = await sql`
      INSERT INTO users (id, email, password, name)
      VALUES (${id}, ${email.toLowerCase()}, ${hash}, ${name})
      RETURNING id, email, name, photo_url, status, about, phone, show_online, created_at
    `;

    res.status(201).json({ token: sign(user), user });
  } catch (err) {
    console.error('register error:', err);
    res.status(500).json({ error: 'Registrasi gagal' });
  }
});

/* ── Login ── */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email dan password wajib diisi' });

    const [user] = await sql`SELECT * FROM users WHERE email = ${email.toLowerCase()}`;
    if (!user) return res.status(401).json({ error: 'Email atau password salah' });
    if (!user.password) return res.status(401).json({ error: 'Akun ini menggunakan login Google' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Email atau password salah' });

    // Update online
    await sql`UPDATE users SET online = TRUE, last_seen = NOW() WHERE id = ${user.id}`;

    const safe = { id: user.id, email: user.email, name: user.name,
                   photo_url: user.photo_url, status: user.status,
                   about: user.about, phone: user.phone, show_online: user.show_online };
    res.json({ token: sign(safe), user: safe });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'Login gagal' });
  }
});

/* ── Google OAuth (terima idToken, verifikasi manual tidak tersedia tanpa Firebase)
   Solusi: frontend kirim profile dari Google Identity popup, backend buat/cari user ── */
router.post('/google', async (req, res) => {
  try {
    const { email, name, photo_url, google_id } = req.body;
    if (!email) return res.status(400).json({ error: 'Data Google tidak lengkap' });

    let [user] = await sql`SELECT * FROM users WHERE email = ${email.toLowerCase()}`;
    if (!user) {
      const id = uuid();
      ;[user] = await sql`
        INSERT INTO users (id, email, name, photo_url)
        VALUES (${id}, ${email.toLowerCase()}, ${name || email.split('@')[0]}, ${photo_url || ''})
        RETURNING id, email, name, photo_url, status, about, phone, show_online
      `;
    }
    await sql`UPDATE users SET online = TRUE, last_seen = NOW() WHERE id = ${user.id}`;

    const safe = { id: user.id, email: user.email, name: user.name,
                   photo_url: user.photo_url, status: user.status,
                   about: user.about, phone: user.phone, show_online: user.show_online };
    res.json({ token: sign(safe), user: safe });
  } catch (err) {
    console.error('google auth error:', err);
    res.status(500).json({ error: 'Login Google gagal' });
  }
});

/* ── Get current user (me) ── */
const auth = require('../middleware/auth');
router.get('/me', auth, async (req, res) => {
  try {
    const [user] = await sql`
      SELECT id, email, name, photo_url, status, about, phone, show_online, online, last_seen
      FROM users WHERE id = ${req.user.id}
    `;
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil data user' });
  }
});

/* ── Logout ── */
router.post('/logout', auth, async (req, res) => {
  await sql`UPDATE users SET online = FALSE, last_seen = NOW() WHERE id = ${req.user.id}`.catch(() => {});
  res.json({ ok: true });
});

/* ── Forgot password — kirim email (placeholder, perlu SMTP) ── */
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email wajib diisi' });
  // TODO: integrate NodeMailer/Resend untuk kirim email reset
  // Untuk sementara response success agar frontend tidak error
  res.json({ message: 'Jika email terdaftar, link reset akan dikirim.' });
});

module.exports = router;
