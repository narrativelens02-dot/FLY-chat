'use strict';
/**
 * FLYchat — Mailer helper
 *
 * Mode (auto-detect, urutan prioritas):
 *  1. Resend API  — isi RESEND_API_KEY  (paling mudah, free 3000/bulan)
 *  2. SMTP        — isi SMTP_HOST + SMTP_USER + SMTP_PASS (Gmail App Password dll)
 *  3. Console     — fallback development: cetak link ke console, tidak kirim email
 */
const nodemailer = require('nodemailer');

/* ─── Deteksi mode ─── */
function getMode() {
  if (process.env.RESEND_API_KEY && !process.env.RESEND_API_KEY.includes('your_resend')) return 'resend';
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS &&
      !process.env.SMTP_USER.includes('your_email')) return 'smtp';
  return 'console';
}

/* ─── SMTP transporter (lazy singleton) ─── */
let _transporter = null;
function getSmtpTransporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls:    { rejectUnauthorized: false }
  });
  return _transporter;
}

/* ─── Resend sender (HTTP API) ─── */
async function sendViaResend(to, subject, html) {
  const from = process.env.EMAIL_FROM || 'FLYchat <onboarding@resend.dev>';
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
    },
    body: JSON.stringify({ from, to, subject, html })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Resend error: ${data.message || resp.status}`);
  console.log(`📧 Email terkirim via Resend ke ${to}: ${data.id}`);
  return data;
}

/* ─── SMTP sender ─── */
async function sendViaSmtp(to, subject, html) {
  const from = process.env.EMAIL_FROM || `FLYchat <${process.env.SMTP_USER}>`;
  const info = await getSmtpTransporter().sendMail({ from, to, subject, html });
  console.log(`📧 Email terkirim via SMTP ke ${to}: ${info.messageId}`);
  return info;
}

/* ─── Console fallback (dev) ─── */
async function sendViaConsole(to, subject, html) {
  console.log('\n' + '═'.repeat(60));
  console.log('📧 [DEV MODE] Email tidak dikirim — tampilkan di console');
  console.log(`   To:      ${to}`);
  console.log(`   Subject: ${subject}`);
  // Extract link reset dari HTML
  const linkMatch = html.match(/href="(https?:\/\/[^"]+reset-password[^"]+)"/);
  if (linkMatch) console.log(`   Link:    ${linkMatch[1]}`);
  console.log('═'.repeat(60) + '\n');
  return { messageId: 'console-' + Date.now() };
}

/**
 * Kirim email HTML — auto-pilih mode
 */
async function sendMail(to, subject, html) {
  const mode = getMode();
  switch (mode) {
    case 'resend':  return sendViaResend(to, subject, html);
    case 'smtp':    return sendViaSmtp(to, subject, html);
    default:        return sendViaConsole(to, subject, html);
  }
}

/**
 * Cek apakah email bisa dikirim (untuk info endpoint)
 */
function getMailerStatus() {
  const mode = getMode();
  return {
    mode,
    configured: mode !== 'console',
    info: mode === 'resend'
      ? 'Resend API aktif'
      : mode === 'smtp'
      ? `SMTP aktif (${process.env.SMTP_HOST})`
      : 'Mode console (dev) — email dicetak ke log server, tidak dikirim ke inbox'
  };
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
    <div style="background:linear-gradient(135deg,#7d2535,#c0392b);padding:32px 32px 24px;text-align:center">
      <svg viewBox="0 0 120 96" xmlns="http://www.w3.org/2000/svg" width="52" height="42">
        <path d="M60 12 C36 12, 6 30, 6 54 C6 66, 18 78, 36 72 C42 70, 48 62, 60 54 C72 62, 78 70, 84 72 C102 78, 114 66, 114 54 C114 30, 84 12, 60 12Z" fill="white"/>
      </svg>
      <h1 style="color:white;margin:8px 0 0;font-size:1.5rem;font-weight:700">FLYchat</h1>
      <p style="color:rgba(255,255,255,.8);margin:6px 0 0;font-size:.9rem">Reset Password</p>
    </div>
    <div style="padding:32px">
      <p style="color:#374151;font-size:1rem;margin:0 0 16px">Halo, <strong>${escHtml(name)}</strong>!</p>
      <p style="color:#6b7280;font-size:.92rem;line-height:1.6;margin:0 0 24px">
        Kami menerima permintaan reset password akun FLYchat kamu.
        Klik tombol berikut untuk membuat password baru.
        Link berlaku selama <strong>1 jam</strong>.
      </p>
      <div style="text-align:center;margin:0 0 24px">
        <a href="${resetLink}"
           style="display:inline-block;background:linear-gradient(135deg,#7d2535,#c0392b);color:white;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:600;font-size:.95rem">
          🔑 Reset Password Sekarang
        </a>
      </div>
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 16px;margin:0 0 20px">
        <p style="color:#991b1b;font-size:.82rem;margin:0">
          ⚠️ Jika tidak meminta reset, abaikan email ini. Password tidak akan berubah.
        </p>
      </div>
      <p style="color:#9ca3af;font-size:.8rem;margin:0">
        Atau salin link ini:<br/>
        <span style="word-break:break-all;color:#7d2535">${resetLink}</span>
      </p>
    </div>
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

module.exports = { sendMail, resetPasswordTemplate, getMailerStatus };
