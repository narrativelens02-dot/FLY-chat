'use strict';
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { sql } = require('../db');
const { sendMail, resetPasswordTemplate } = require('../mailer');

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

/* ── Google OAuth — Verifikasi ID Token via google-auth-library ── */
router.post('/google', async (req, res) => {
  try {
    const { credential, email, name, photo_url } = req.body;

    // Jika credential (ID token dari GSI) dikirim, verifikasi via Google
    if (credential) {
      let payload;
      try {
        const { OAuth2Client } = require('google-auth-library');
        const clientId = process.env.GOOGLE_CLIENT_ID;
        if (!clientId || clientId.includes('YOUR_GOOGLE_CLIENT_ID')) {
          // Fallback: decode tanpa verifikasi jika Client ID belum diisi
          // Ini mempertahankan kompatibilitas dengan mode development
          console.warn('⚠️  GOOGLE_CLIENT_ID belum diisi, skip verifikasi signature');
          const parts = credential.split('.');
          payload = JSON.parse(Buffer.from(
            parts[1].replace(/-/g, '+').replace(/_/g, '/'),
            'base64'
          ).toString('utf8'));
        } else {
          const client = new OAuth2Client(clientId);
          const ticket = await client.verifyIdToken({
            idToken:  credential,
            audience: clientId
          });
          payload = ticket.getPayload();
        }
      } catch (verifyErr) {
        console.error('Google token verify error:', verifyErr.message);
        return res.status(401).json({ error: 'Token Google tidak valid' });
      }

      const googleEmail    = (payload.email || '').toLowerCase();
      const googleName     = payload.name || googleEmail.split('@')[0];
      const googlePhoto    = payload.picture || '';

      if (!googleEmail) return res.status(400).json({ error: 'Email tidak ditemukan dalam token Google' });

      let [user] = await sql`SELECT * FROM users WHERE email = ${googleEmail}`;
      if (!user) {
        const id = uuid();
        ;[user] = await sql`
          INSERT INTO users (id, email, name, photo_url)
          VALUES (${id}, ${googleEmail}, ${googleName}, ${googlePhoto})
          RETURNING id, email, name, photo_url, status, about, phone, show_online
        `;
      }
      await sql`UPDATE users SET online = TRUE, last_seen = NOW() WHERE id = ${user.id}`;

      const safe = { id: user.id, email: user.email, name: user.name,
                     photo_url: user.photo_url, status: user.status,
                     about: user.about, phone: user.phone, show_online: user.show_online };
      return res.json({ token: sign(safe), user: safe });
    }

    // Legacy fallback: frontend kirim profile langsung (hanya untuk development)
    if (!email) return res.status(400).json({ error: 'Data Google tidak lengkap' });

    if (process.env.NODE_ENV === 'production') {
      return res.status(400).json({ error: 'Mode ini tidak diizinkan di produksi. Kirim credential token.' });
    }

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

/* ── Forgot Password — kirim email dengan link reset ── */
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email wajib diisi' });

  try {
    const [user] = await sql`SELECT id, name, email FROM users WHERE email = ${email.toLowerCase()}`;

    // Selalu return 200 agar tidak leak info akun terdaftar
    if (!user) {
      return res.json({ message: 'Jika email terdaftar, link reset akan dikirim.' });
    }

    // Hapus token lama yang belum dipakai untuk user ini
    await sql`DELETE FROM password_resets WHERE user_id = ${user.id} AND used = FALSE`;

    // Buat token reset (berlaku 1 jam)
    const tokenId  = uuid();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // +1 jam
    await sql`
      INSERT INTO password_resets (id, user_id, expires_at)
      VALUES (${tokenId}, ${user.id}, ${expiresAt.toISOString()})
    `;

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const resetLink   = `${frontendUrl}/reset-password?token=${tokenId}`;

    await sendMail(
      user.email,
      '🔑 Reset Password FLYchat',
      resetPasswordTemplate(user.name, resetLink)
    );

    res.json({ message: 'Jika email terdaftar, link reset akan dikirim.' });
  } catch (err) {
    console.error('forgot-password error:', err.message);
    // Jangan expose error detail SMTP ke client
    if (err.message.includes('SMTP')) {
      return res.status(503).json({ error: 'Layanan email sedang tidak tersedia. Coba lagi nanti.' });
    }
    res.status(500).json({ error: 'Gagal mengirim email' });
  }
});

/* ── Verify Reset Token (cek apakah token valid) ── */
router.get('/reset-password', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token diperlukan' });

  try {
    const [reset] = await sql`
      SELECT * FROM password_resets
      WHERE id = ${token} AND used = FALSE AND expires_at > NOW()
    `;
    if (!reset) return res.status(400).json({ error: 'Token tidak valid atau sudah kedaluwarsa' });
    res.json({ valid: true });
  } catch (err) {
    res.status(500).json({ error: 'Gagal memverifikasi token' });
  }
});

/* ── Reset Password — terapkan password baru ── */
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token dan password diperlukan' });
  if (password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });

  try {
    const [reset] = await sql`
      SELECT * FROM password_resets
      WHERE id = ${token} AND used = FALSE AND expires_at > NOW()
    `;
    if (!reset) return res.status(400).json({ error: 'Token tidak valid atau sudah kedaluwarsa' });

    const hash = await bcrypt.hash(password, 12);
    await sql`UPDATE users SET password = ${hash} WHERE id = ${reset.user_id}`;
    await sql`UPDATE password_resets SET used = TRUE WHERE id = ${token}`;

    res.json({ message: 'Password berhasil diubah. Silakan login dengan password baru.' });
  } catch (err) {
    console.error('reset-password error:', err);
    res.status(500).json({ error: 'Gagal mengubah password' });
  }
});

module.exports = router;
