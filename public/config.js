/**
 * FLYchat Runtime Config
 *
 * - Development lokal : buka http://localhost:3000
 * - Production Vercel : isi RAILWAY_URL di bawah setelah deploy Railway
 */

// Deteksi apakah dibuka via file:// (salah) atau http:// (benar)
if (window.location.protocol === 'file:') {
  document.body.innerHTML = `
    <div style="
      font-family:Inter,sans-serif;
      display:flex;flex-direction:column;
      align-items:center;justify-content:center;
      height:100vh;background:#f5e8ea;gap:16px;padding:24px;text-align:center
    ">
      <svg viewBox="0 0 120 96" width="80" xmlns="http://www.w3.org/2000/svg">
        <path d="M60 12C36 12 6 30 6 54c0 12 12 24 30 18 6-2 12-10 24-18 12 8 18 16 24 18 18 6 30-6 30-18 0-24-30-42-54-42z" fill="#7d2535"/>
      </svg>
      <h2 style="color:#7d2535;font-size:1.4rem">FLYchat tidak bisa dibuka langsung</h2>
      <p style="color:#555;max-width:320px;line-height:1.6">
        Kamu membuka file HTML secara langsung.<br/>
        FLYchat butuh server untuk berjalan.
      </p>
      <div style="background:white;border-radius:12px;padding:20px 28px;box-shadow:0 4px 20px rgba(125,37,53,.12)">
        <p style="font-weight:700;margin-bottom:10px;color:#333">Cara yang benar:</p>
        <p style="font-size:.95rem;color:#555;margin-bottom:14px">
          1. Buka terminal di folder FLYchat<br/>
          2. Jalankan perintah ini:
        </p>
        <code style="background:#f5e8ea;color:#7d2535;padding:10px 20px;border-radius:8px;font-size:1rem;display:block">
          node server/index.js
        </code>
        <p style="font-size:.9rem;color:#888;margin-top:12px">
          Lalu buka browser ke:<br/>
          <a href="http://localhost:3000" style="color:#7d2535;font-weight:700">
            http://localhost:3000
          </a>
        </p>
      </div>
    </div>
  `;
  throw new Error('Dibuka via file:// — gunakan http://localhost:3000');
}

// ── Production config ──────────────────────────────────
// Kosong = same-origin (saat server jalan di localhost:3000)
// Isi dengan Railway URL setelah deploy ke Railway+Vercel
window.__FLYCHAT_API__ = '';

// Contoh production:
// window.__FLYCHAT_API__ = 'https://flychat-api.up.railway.app';
