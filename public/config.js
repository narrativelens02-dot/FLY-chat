/**
 * FLYchat Runtime Config
 * 
 * LOCAL DEV:  kosong = same-origin (Express serve frontend + API)
 * VERCEL:     isi RAILWAY_URL dengan URL backend Railway kamu
 *             setelah deploy Railway, edit file ini atau gunakan env injection
 */
window.__FLYCHAT_API__ = '';

// Contoh setelah deploy Railway:
// window.__FLYCHAT_API__ = 'https://flychat-api.up.railway.app';
