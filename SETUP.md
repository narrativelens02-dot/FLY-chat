# 🦋 FLYchat v2 — Panduan Setup (Neon + Node.js)

## Stack Teknologi
| Komponen | Teknologi |
|----------|-----------|
| Database | Neon Postgres (PostgreSQL 18) |
| Backend  | Node.js + Express + Socket.io |
| Auth     | JWT + bcryptjs |
| Storage  | Multer (file upload lokal di `/uploads`) |
| Frontend | Vanilla HTML/CSS/JS (tanpa framework) |
| Realtime | Socket.io WebSocket |

## Struktur Project
```
FLYchat/
├── server/
│   ├── index.js          ← Express + Socket.io server
│   ├── db.js             ← Neon Postgres + auto schema migration
│   ├── routes/
│   │   ├── auth.js       ← Register, Login, Google, Me, Logout
│   │   ├── users.js      ← Profile, Contacts, Search, Presence
│   │   ├── chats.js      ← CRUD chats & messages, reactions
│   │   └── upload.js     ← File & avatar upload (Multer)
│   └── middleware/
│       └── auth.js       ← JWT verification middleware
├── public/               ← Frontend static files
│   ├── index.html
│   ├── js/app.js         ← Semua logika frontend
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
