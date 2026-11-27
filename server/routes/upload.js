'use strict';
/**
 * FLYchat — File Upload Route
 *
 * Mode otomatis:
 *   1. CLOUDINARY_* tersedia  → Cloudinary v2 (paling disarankan, tanpa batas kecil)
 *   2. Serverless (Vercel)    → simpan di database Neon (chunked, aman limit 4,5 MB)
 *   3. Selain itu             → disk lokal (uploads/)
 *
 * Endpoint database:
 *   POST /api/upload/file      → unggah kecil (≤2 MB) sekali kirim
 *   POST /api/upload/avatar    → foto profil (≤2 MB, dikompres di klien)
 *   POST /api/upload/init      → mulai unggah besar (video/dokumen)
 *   POST /api/upload/chunk     → kirim potongan (≤2 MB per request)
 *   POST /api/upload/complete  → selesaikan unggah
 */
const router   = require('express').Router();
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { v4: uuid } = require('uuid');
const auth     = require('../middleware/auth');
const { sql }  = require('../db');
const { ah }   = require('../utils');
const { CHUNK_MB, CHUNK_BYTES } = require('../fileStore');

/* ─── Deteksi mode ─────────────────────────── */
const USE_CLOUDINARY = !!(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET &&
  !process.env.CLOUDINARY_CLOUD_NAME.includes('your_cloud_name')
);

/* Vercel/Lambda: filesystem read-only, tidak bisa mkdir */
const IS_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);

const BLOCKED_EXT  = ['.exe','.bat','.sh','.cmd','.ps1','.js','.php','.py','.rb','.pl'];
const MAX_MB       = parseInt(process.env.MAX_FILE_SIZE_MB || '50');
const MAX_BYTES    = MAX_MB * 1024 * 1024;
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/* ═══════════════════════════════════════════
   CLOUDINARY MODE — multer memoryStorage +
   cloudinary.uploader.upload_stream
═══════════════════════════════════════════ */
function buildCloudinaryRoutes(router) {
  const cloudinary = require('cloudinary').v2;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });

  /* Upload ke Cloudinary dari buffer */
  function uploadToCloudinary(buffer, options) {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
      stream.end(buffer);
    });
  }

  /* multer dengan memoryStorage (buffer, tidak tulis ke disk) */
  const chatMulter = multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: MAX_MB * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (BLOCKED_EXT.includes(ext)) return cb(new Error(`Tipe file ${ext} tidak diizinkan`));
      cb(null, true);
    }
  });

  const avatarMulter = multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (!file.mimetype.startsWith('image/')) return cb(new Error('Hanya file gambar yang diizinkan'));
      cb(null, true);
    }
  });

  /* POST /api/upload/file */
  router.post('/file', auth, chatMulter.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Tidak ada file yang diunggah' });
    try {
      const isImage = req.file.mimetype.startsWith('image/');
      const isVideo = req.file.mimetype.startsWith('video/');
      const resourceType = isImage ? 'image' : isVideo ? 'video' : 'raw';

      const result = await uploadToCloudinary(req.file.buffer, {
        folder:        'flychat/chat',
        resource_type: resourceType,
        public_id:     `${Date.now()}_${uuid()}`,
        ...(isImage && { transformation: [{ quality: 'auto', fetch_format: 'auto' }] })
      });

      res.json({
        fileURL:  result.secure_url,
        fileName: req.file.originalname,
        fileSize: formatSize(req.file.size),
        mimeType: req.file.mimetype,
        storage:  'cloudinary'
      });
    } catch (err) {
      console.error('Cloudinary upload error:', err.message);
      res.status(500).json({ error: 'Upload gagal: ' + err.message });
    }
  });

  /* POST /api/upload/avatar */
  router.post('/avatar', auth, avatarMulter.single('avatar'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Tidak ada file yang diunggah' });
    try {
      const result = await uploadToCloudinary(req.file.buffer, {
        folder: 'flychat/avatars',
        resource_type: 'image',
        public_id: `avatar_${req.user.id}_${Date.now()}`,
        transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'face' }]
      });
      res.json({ photoURL: result.secure_url, storage: 'cloudinary' });
    } catch (err) {
      console.error('Cloudinary avatar error:', err.message);
      res.status(500).json({ error: 'Upload avatar gagal: ' + err.message });
    }
  });

  console.log('☁️  Upload mode: Cloudinary v2 (memory stream)');
}

/* ═══════════════════════════════════════════
   DATABASE MODE — fallback serverless tanpa Cloudinary
═══════════════════════════════════════════ */
function buildDatabaseRoutes(router) {
  const chunkMulter = multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: CHUNK_BYTES },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (BLOCKED_EXT.includes(ext)) return cb(new Error(`Tipe file ${ext} tidak diizinkan`));
      cb(null, true);
    }
  });

  const avatarMulter = multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: AVATAR_MAX_BYTES },
    fileFilter: (req, file, cb) => {
      if (!file.mimetype.startsWith('image/')) return cb(new Error('Hanya file gambar yang diizinkan'));
      cb(null, true);
    }
  });

  async function storeChunk(fileId, idx, buffer) {
    const hex = buffer.toString('hex');
    await sql`
      INSERT INTO uploaded_file_chunks (file_id, idx, data)
      VALUES (${fileId}, ${idx}, decode(${hex}, 'hex'))
      ON CONFLICT (file_id, idx) DO UPDATE SET data = decode(${hex}, 'hex')
    `;
  }

  async function createFile(ownerId, kind, name, mime, size, chunkCount, status) {
    const id = uuid();
    const [row] = await sql`
      INSERT INTO uploaded_files
        (id, owner_id, kind, file_name, mime_type, file_size, chunk_count, status)
      VALUES
        (${id}, ${ownerId}, ${kind}, ${name || 'file'},
         ${mime || 'application/octet-stream'}, ${size}, ${chunkCount}, ${status})
      RETURNING *
    `;
    return row;
  }

  function toResponse(row) {
    const url = `/api/files/${row.id}`;
    return {
      fileURL:  url,
      photoURL: url,
      fileName: row.file_name,
      fileSize: formatSize(Number(row.file_size)),
      mimeType: row.mime_type,
      storage:  'database'
    };
  }

  /* Unggah kecil (≤1 chunk) */
  router.post('/file', auth, chunkMulter.single('file'), ah(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Tidak ada file yang diunggah' });
    const row = await createFile(
      req.user.id, 'chat',
      req.file.originalname || 'file',
      req.file.mimetype,
      req.file.size, 1, 'ready'
    );
    await storeChunk(row.id, 0, req.file.buffer);
    res.json(toResponse(row));
  }));

  /* Foto profil */
  router.post('/avatar', auth, avatarMulter.single('avatar'), ah(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Tidak ada file yang diunggah' });
    const row = await createFile(
      req.user.id, 'avatar',
      req.file.originalname || 'avatar',
      req.file.mimetype,
      req.file.size, 1, 'ready'
    );
    await storeChunk(row.id, 0, req.file.buffer);
    res.json({ photoURL: `/api/files/${row.id}`, storage: 'database' });
  }));

  /* Mulai unggah besar */
  router.post('/init', auth, ah(async (req, res) => {
    const { file_name = 'file', mime_type = 'application/octet-stream', file_size, kind = 'chat' } = req.body || {};
    const size = Number(file_size);
    if (!Number.isFinite(size) || size <= 0) {
      return res.status(400).json({ error: 'Ukuran file tidak valid' });
    }
    if (size > MAX_BYTES) {
      return res.status(413).json({ error: `File terlalu besar (maks ${MAX_MB}MB)` });
    }
    const ext = path.extname(String(file_name)).toLowerCase();
    if (BLOCKED_EXT.includes(ext)) {
      return res.status(400).json({ error: `Tipe file ${ext} tidak diizinkan` });
    }

    /* Bersihkan unggahan yang tidak pernah diselesaikan */
    await sql`DELETE FROM uploaded_files WHERE status = 'pending' AND created_at < NOW() - INTERVAL '1 day'`.catch(() => {});

    const chunkCount = Math.max(1, Math.ceil(size / CHUNK_BYTES));
    const row = await createFile(
      req.user.id,
      kind === 'avatar' ? 'avatar' : 'chat',
      String(file_name), String(mime_type), size, chunkCount, 'pending'
    );

    res.json({
      upload_id:  row.id,
      chunk_size: CHUNK_BYTES,
      chunk_mb:   CHUNK_MB,
      chunk_count: chunkCount
    });
  }));

  /* Kirim satu potongan */
  router.post('/chunk', auth, chunkMulter.single('chunk'), ah(async (req, res) => {
    const { upload_id, index } = req.body || {};
    if (!upload_id || index === undefined) {
      return res.status(400).json({ error: 'upload_id dan index wajib diisi' });
    }
    if (!req.file) return res.status(400).json({ error: 'Potongan file kosong' });

    const idx = Number(index);
    const [file] = await sql`
      SELECT id, owner_id, chunk_count, status FROM uploaded_files WHERE id = ${upload_id}
    `;
    if (!file || file.owner_id !== req.user.id) {
      return res.status(404).json({ error: 'Upload tidak ditemukan' });
    }
    if (file.status !== 'pending') {
      return res.status(409).json({ error: 'Upload sudah diselesaikan' });
    }
    if (!Number.isInteger(idx) || idx < 0 || idx >= file.chunk_count) {
      return res.status(400).json({ error: 'Index potongan tidak valid' });
    }

    await storeChunk(upload_id, idx, req.file.buffer);
    res.json({ ok: true, index: idx });
  }));

  /* Selesaikan unggahan */
  router.post('/complete', auth, ah(async (req, res) => {
    const { upload_id } = req.body || {};
    if (!upload_id) return res.status(400).json({ error: 'upload_id wajib diisi' });

    const [file] = await sql`SELECT * FROM uploaded_files WHERE id = ${upload_id}`;
    if (!file || file.owner_id !== req.user.id) {
      return res.status(404).json({ error: 'Upload tidak ditemukan' });
    }
    if (file.status === 'ready') return res.json(toResponse(file));

    const [count] = await sql`
      SELECT COUNT(*)::int AS c FROM uploaded_file_chunks WHERE file_id = ${upload_id}
    `;
    if (count.c !== file.chunk_count) {
      return res.status(400).json({
        error: `Potongan file belum lengkap (${count.c}/${file.chunk_count})`
      });
    }

    const [row] = await sql`
      UPDATE uploaded_files SET status = 'ready' WHERE id = ${upload_id} RETURNING *
    `;
    res.json(toResponse(row));
  }));

  console.log('🗄️  Upload mode: Database Neon (chunked, aman untuk Vercel)');
}

/* ═══════════════════════════════════════════
   LOCAL DISK MODE — fallback
═══════════════════════════════════════════ */
function buildLocalRoutes(router) {
  const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || 'uploads');

  /* Buat direktori secara lazy (saat pertama kali dibutuhkan, bukan saat startup) */
  function ensureDir(sub) {
    const dir = path.join(UPLOAD_DIR, sub);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function makeStorage(subdir) {
    return multer.diskStorage({
      destination: (req, file, cb) => cb(null, ensureDir(subdir)),
      filename:    (req, file, cb) => cb(null, `${Date.now()}_${uuid()}${path.extname(file.originalname).toLowerCase()}`)
    });
  }

  const chatMulter = multer({
    storage: makeStorage('chat'),
    limits:  { fileSize: MAX_MB * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (BLOCKED_EXT.includes(ext)) return cb(new Error(`Tipe file ${ext} tidak diizinkan`));
      cb(null, true);
    }
  });

  const avatarMulter = multer({
    storage: makeStorage('avatars'),
    limits:  { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (!file.mimetype.startsWith('image/')) return cb(new Error('Hanya file gambar yang diizinkan'));
      cb(null, true);
    }
  });

  router.post('/file', auth, chatMulter.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Tidak ada file yang diunggah' });
    res.json({
      fileURL:  `/uploads/chat/${req.file.filename}`,
      fileName: req.file.originalname,
      fileSize: formatSize(req.file.size),
      mimeType: req.file.mimetype,
      storage:  'local'
    });
  });

  router.post('/avatar', auth, avatarMulter.single('avatar'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Tidak ada file yang diunggah' });
    res.json({ photoURL: `/uploads/avatars/${req.file.filename}`, storage: 'local' });
  });

  console.log('💾 Upload mode: Disk lokal (atur CLOUDINARY_* di .env untuk cloud storage)');
}

/* ─── Init ──────────────────────────────── */
if (USE_CLOUDINARY) {
  buildCloudinaryRoutes(router);
  if (IS_SERVERLESS) {
    /* Fallback chunked DB untuk file > 4MB di Vercel meski Cloudinary aktif */
    buildDatabaseRoutes(router);
  }
} else if (IS_SERVERLESS) {
  buildDatabaseRoutes(router);
} else {
  buildLocalRoutes(router);
}

/* Info endpoint */
router.get('/info', auth, (req, res) => {
  const mode = USE_CLOUDINARY ? 'cloudinary' : IS_SERVERLESS ? 'database' : 'local';
  const singleMax = mode === 'local'
    ? MAX_BYTES
    : (mode === 'cloudinary' && !IS_SERVERLESS)
      ? MAX_BYTES
      : (mode === 'cloudinary' ? 4 * 1024 * 1024 : CHUNK_BYTES);
  res.json({
    mode,
    maxSize: `${MAX_MB}MB`,
    maxBytes: MAX_BYTES,
    avatarMaxSize: `${Math.round(AVATAR_MAX_BYTES / 1024 / 1024)}MB`,
    chunkSize: CHUNK_BYTES,
    chunkMb: CHUNK_MB,
    singleMax
  });
});

/* Error handler multer */
router.use((err, req, res, next) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: `File terlalu besar. Maksimal ${CHUNK_MB}MB per unggahan; file lebih besar dikirim otomatis per potongan.`
    });
  }
  return res.status(400).json({ error: err.message });
});

function formatSize(b) {
  if (b < 1024)    return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

module.exports = router;
