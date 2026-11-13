'use strict';
/**
 * FLYchat — Mailer helper (Nodemailer)
 * Mendukung Gmail App Password, Mailtrap, dsb.
 */
const nodemailer = require('nodemailer');

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error('SMTP belum dikonfigurasi. Isi SMTP_HOST, SMTP_USER, SMTP_PASS di .env');
  }

  _transporter = nodemailer.createTransport({
    host:   SMTP_HOST,
    port:   parseInt(SMTP_PORT || '587'),
    secure: SMTP_SECURE === 'true',   // true untuk port 465, false untuk 587
    auth:   { user: SMTP_USER, pass: SMTP_PASS },
    tls:    { rejectUnauthorized: false }   // agar tidak gagal di cert self-signed
  });

  return _transporter;
}

/**
 * Kirim email HTML
 * @param {string} to       - Alamat tujuan
 * @param {string} subject  - Subject email
 * @param {string} html     - Konten HTML
 */
async function sendMail(to, subject, html) {
  const transporter = getTransporter();
  const from = process.env.EMAIL_FROM || `FLYchat <${process.env.SMTP_USER}>`;
  const info  = await transporter.sendMail({ from, to, subject, html });
  console.log(`📧 Email terkirim ke ${to}: ${info.messageId}`);
  return info;
}

/**
 * Template email reset password
 */
function resetPasswordTemplate(name, resetLink) {
  return `
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Reset Password FLYchat</title>
</head>
<body style="font-family:Inter,Arial,sans-serif;background:#f4f4f5;margin:0;padding:24px">
  <div style="max-width:480px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#7d2535,#c0392b);padding:32px 32px 24px;text-align:center">
      <div style="display:inline-block;width:52px;height:42px;margin-bottom:12px">
        <svg viewBox="0 0 120 96" xmlns="http://www.w3.org/2000/svg" width="52" height="42">
          <path d="M60 12 C36 12, 6 30, 6 54 C6 66, 18 78, 36 72 C42 70, 48 62, 60 54 C72 62, 78 70, 84 72 C102 78, 114 66, 114 54 C114 30, 84 12, 60 12Z" fill="white"/>
        </svg>
      </div>
      <h1 style="color:white;margin:0;font-size:1.5rem;font-weight:700">FLYchat</h1>
      <p style="color:rgba(255,255,255,.8);margin:6px 0 0;font-size:.9rem">Reset Password</p>
    </div>
    <!-- Body -->
    <div style="padding:32px">
      <p style="color:#374151;font-size:1rem;margin:0 0 16px">Halo, <strong>${escHtml(name)}</strong>!</p>
      <p style="color:#6b7280;font-size:.92rem;line-height:1.6;margin:0 0 24px">
        Kami menerima permintaan untuk mereset password akun FLYchat kamu.
        Klik tombol di bawah untuk membuat password baru. Link ini berlaku selama <strong>1 jam</strong>.
      </p>
      <div style="text-align:center;margin:0 0 24px">
        <a href="${resetLink}"
           style="display:inline-block;background:linear-gradient(135deg,#7d2535,#c0392b);color:white;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:600;font-size:.95rem">
          🔑 Reset Password Sekarang
        </a>
      </div>
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 16px;margin:0 0 20px">
        <p style="color:#991b1b;font-size:.82rem;margin:0">
          ⚠️ Jika kamu tidak meminta reset password, abaikan email ini. Password kamu tidak akan berubah.
        </p>
      </div>
      <p style="color:#9ca3af;font-size:.8rem;margin:0">
        Atau salin link ini ke browser:<br/>
        <span style="word-break:break-all;color:#7d2535">${resetLink}</span>
      </p>
    </div>
    <!-- Footer -->
    <div style="background:#f9fafb;padding:16px 32px;text-align:center">
      <p style="color:#9ca3af;font-size:.78rem;margin:0">
        © ${new Date().getFullYear()} FLYchat · Dikirim otomatis, jangan balas email ini
      </p>
    </div>
  </div>
</body>
</html>`;
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

module.exports = { sendMail, resetPasswordTemplate };
