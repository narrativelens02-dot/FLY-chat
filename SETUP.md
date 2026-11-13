# 🦋 FLYchat v2 — Panduan Setup (Neon + Node.js)

## Stack Teknologi
| Komponen | Teknologi |
|----------|-----------|
| Database | Neon Postgres (PostgreSQL 18) |
| Backend  | Node.js + Express + Socket.io |
| Auth     | JWT + bcryptjs + Google OAuth (token verification) |
| Storage  | Cloudinary (cloud) atau Multer disk (lokal) |
| Email    | Nodemailer (SMTP — Gmail App Password / Mailtrap) |
| Frontend | Vanilla HTML/CSS/JS (tanpa framework) |
| Realtime | Socket.io WebSocket + HTTP Polling (Vercel) |
| Call     | WebRTC Peer-to-Peer (voice & video) |

## Struktur Project
```
FLYchat/
├── server/
│   ├── index.js          ← Express + Socket.io server
│   ├── db.js             ← Neon Postgres + auto schema migration
│   ├── mailer.js         ← Nodemailer SMTP helper + email templates
│   ├── routes/
│   │   ├── auth.js       ← Register, Login, Google, Me, Logout,
│   │   │                    ForgotPassword, ResetPassword (lengkap)
│   │   ├── users.js      ← Profile, Contacts, Search, Presence
│   │   ├── chats.js      ← CRUD chats & messages, reactions
│   │   └── upload.js     ← Upload (Cloudinary atau disk lokal)
│   └── middleware/
│       └── auth.js       ← JWT verification middleware
├── public/               ← Frontend static files
│   ├── index.html        ← SPA + modal call, forgot pwd, reset pwd
│   ├── config.js         ← Runtime config (API URL, Google Client ID)
│   ├── js/app.js         ← Semua logika frontend + WebRTC
│   ├── css/style.css
│   └── assets/
├── uploads/              ← File yang diupload user (auto-created)
├── .env                  ← DATABASE_URL + JWT_SECRET
└── package.json
```

## Cara Jalankan

### 1. Install dependencies
```bash
npm install
```

### 2. Isi `.env`
```env
DATABASE_URL=postgresql://...    # dari Neon Console
JWT_SECRET=...                   # random string panjang
PORT=3000
UPLOAD_DIR=uploads
MAX_FILE_SIZE_MB=50
```

### 3. Jalankan
```bash
npm run dev
```

Server otomatis:
- Membuat semua tabel di Neon Postgres (users, chats, messages, contacts, reactions)
- Menyajikan frontend dari `public/`
- Membuka WebSocket untuk real-time chat

### 4. Buka browser
```
http://localhost:3000
```

## API Endpoints

### Auth
| Method | Path | Keterangan |
|--------|------|-----------|
| POST | `/api/auth/register` | Daftar akun baru |
| POST | `/api/auth/login` | Masuk dengan email/password |
| POST | `/api/auth/google` | Login/register via Google |
| GET  | `/api/auth/me` | Ambil profil diri sendiri |
| POST | `/api/auth/logout` | Keluar |
| POST | `/api/auth/forgot-password` | Reset password |

### Users
| Method | Path | Keterangan |
|--------|------|-----------|
| GET    | `/api/users/search?email=` | Cari user by email |
| GET    | `/api/users/:id` | Profil user tertentu |
| PATCH  | `/api/users/me` | Update profil |
| PATCH  | `/api/users/me/presence` | Update online status |
| GET    | `/api/users/me/contacts` | Daftar kontak |
| POST   | `/api/users/me/contacts` | Tambah kontak |

### Chats & Messages
| Method | Path | Keterangan |
|--------|------|-----------|
| GET    | `/api/chats` | List semua chat saya |
| POST   | `/api/chats` | Buat/temukan chat dengan user |
| PATCH  | `/api/chats/:id/read` | Tandai sudah dibaca |
| GET    | `/api/chats/:id/messages` | Ambil pesan |
| POST   | `/api/chats/:id/messages` | Kirim pesan |
| DELETE | `/api/chats/:chatId/messages/:msgId` | Hapus pesan |
| DELETE | `/api/chats/:id/messages` | Hapus semua riwayat |
| PATCH  | `/api/chats/:chatId/messages/:msgId/reactions` | Tambah reaksi |

### Upload
| Method | Path | Keterangan |
|--------|------|-----------|
| POST | `/api/upload/file` | Upload foto/video/dokumen |
| POST | `/api/upload/avatar` | Upload foto profil |

## Socket.io Events

### Client → Server
| Event | Data | Keterangan |
|-------|------|-----------|
| `chat:join` | `chatId` | Masuk room chat |
| `chat:leave` | `chatId` | Keluar room chat |
| `typing:start` | `{chatId}` | Mulai mengetik |
| `typing:stop` | `{chatId}` | Berhenti mengetik |
| `message:new` | `{chatId, message}` | Broadcast pesan baru |
| `message:deleted` | `{chatId, msgId}` | Broadcast hapus pesan |
| `message:reacted` | `{chatId, msgId, userId, emoji}` | Broadcast reaksi |

### Server → Client
| Event | Data | Keterangan |
|-------|------|-----------|
| `message:new` | `{chatId, message}` | Ada pesan baru |
| `message:deleted` | `{chatId, msgId}` | Pesan dihapus |
| `message:reacted` | `{chatId, msgId, userId, emoji}` | Ada reaksi baru |
| `typing:start` | `{chatId, userId, userName}` | Partner mengetik |
| `typing:stop` | `{chatId, userId}` | Partner berhenti |
| `user:online` | `{userId, online}` | Perubahan status online |
| `chat:updated` | `{chatId}` | Update list chat |

## ✅ Fitur Lengkap
- Register & Login Email/Password
- Login Google (via Google Identity Services)
- Real-time chat via Socket.io
- Kirim foto, video, dokumen
- Preview foto/video sebelum kirim + caption
- Bagikan lokasi GPS (OpenStreetMap, gratis)
- Balas pesan (reply with quote)
- Reaksi emoji pada pesan
- Hapus pesan
- Typing indicator real-time
- Status online/offline real-time
- Unread message badge
- Edit profil + upload foto profil
- Dark mode / Light mode
- Notifikasi browser push
- PWA (installable)
- Responsif mobile
- Pencarian kontak via email
- Hapus riwayat chat
- Keyboard shortcuts (Ctrl+K, Esc)
- Offline caching (Service Worker)


---

## ⚙️ Konfigurasi Fitur Baru

### 1. Google OAuth (Login Google)

Dapatkan Google Client ID:
1. Buka https://console.cloud.google.com
2. Pilih project → **APIs & Services → Credentials**
3. **Create Credentials → OAuth 2.0 Client ID**
4. Tipe: **Web application**
5. Authorized JavaScript origins:
   - `http://localhost:3000` (development)
   - `https://domain-produksi-kamu.com` (production)
6. Copy **Client ID** (format: `xxxx.apps.googleusercontent.com`)

Lalu isi di dua tempat:
```
# .env
GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com

# public/config.js
window.__GOOGLE_CLIENT_ID__ = 'xxxxx.apps.googleusercontent.com';
```

Keamanan: Backend sekarang **memverifikasi signature** token Google via `google-auth-library` sebelum login/register.

---

### 2. Forgot Password / Reset Password (SMTP Email)

**Opsi A — Gmail (Rekomendasi)**
1. Aktifkan 2FA di akun Google
2. Buka https://myaccount.google.com/apppasswords
3. Buat App Password untuk "Mail" / "Other (Custom name)"
4. Isi `.env`:
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=emailkamu@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx   ← app password 16 karakter
EMAIL_FROM=FLYchat <emailkamu@gmail.com>
FRONTEND_URL=http://localhost:3000
```

**Opsi B — Mailtrap (testing lokal, gratis)**
1. Buat akun di https://mailtrap.io
2. Sandbox → pilih inbox → pilih SMTP credentials
```
SMTP_HOST=sandbox.smtp.mailtrap.io
SMTP_PORT=2525
SMTP_USER=your_mailtrap_user
SMTP_PASS=your_mailtrap_pass
```

Flow reset password:
- User klik "Lupa password?" → isi email → dapat link di email
- Link: `http://localhost:3000/reset-password?token=UUID`
- Token valid **1 jam**, sekali pakai
- Backend verifikasi token → update password di DB

---

### 3. Cloudinary (File Upload Cloud Persistent)

Tanpa Cloudinary, file upload disimpan ke disk lokal — file akan hilang saat redeploy di Railway/Render.

Setup Cloudinary (gratis 25GB):
1. Buat akun di https://console.cloudinary.com
2. **Settings → API Keys → Generate new pair**
3. Isi `.env`:
```
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=123456789012345
CLOUDINARY_API_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Auto-detect: jika variabel Cloudinary terisi → pakai Cloudinary, jika tidak → fallback disk lokal.

Cloudinary features yang aktif:
- Gambar: auto-quality, auto-format (WebP/AVIF)
- Avatar: crop ke 400×400, face-aware
- Video: upload as-is (resource_type: video)
- Dokumen: upload as raw

---

### 4. WebRTC Voice & Video Call

Sudah berjalan out-of-the-box — tidak perlu konfigurasi tambahan.

Cara kerja:
- **Signaling via REST polling** (kompatibel dengan Vercel serverless)
- Pesan signaling dikirim sebagai chat message dengan format JSON `{__rtc__: true, ...}`
- Pesan signaling otomatis disaring — tidak ditampilkan sebagai chat bubble
- **STUN servers**: Google STUN (gratis, tidak perlu konfigurasi)
- **Peer-to-peer**: audio/video langsung antar browser setelah handshake

Keterbatasan:
- Jika kedua user di belakang **symmetric NAT** yang ketat (jaringan corporate), koneksi P2P mungkin gagal
- Untuk keandalan lebih tinggi di production, tambahkan TURN server (coturn self-hosted atau Twilio TURN)

Tambahkan TURN server di `app.js` jika diperlukan:
```javascript
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:your-turn-server.com:3478',
      username: 'your-username',
      credential: 'your-password'
    }
  ]
};
```
