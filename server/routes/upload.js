'use strict';
/**
 * FLYchat — File Upload Route
 *
 * Mode otomatis:
 *   - Jika CLOUDINARY_* tersedia → upload ke Cloudinary v2 (persistent)
 *   - Jika tidak             → fallback ke disk lokal
 *
 * Cloudinary upload menggunakan multer memoryStorage + upload_stream
 * (tanpa multer-storage-cloudinary yang tidak support cloudinary v2)
 */
const router   = require('express').Router();
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { v4: uuid } = require('uuid');
const auth     = require('../middleware/auth');

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
        folder:         'flychat/avatars',
        resource_type:  'image',
        public_id:      `${Date.now()}_${uuid()}`,
        transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'face', quality: 'auto' }]
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
} else if (IS_SERVERLESS) {
  /* Vercel tanpa Cloudinary — kembalikan error yang jelas */
  console.warn('⚠️  Upload mode: DISABLED (serverless tanpa Cloudinary). Isi CLOUDINARY_* di env vars.');
  router.post('/file',   auth, (req, res) => res.status(501).json({
    error: 'Upload tidak tersedia. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET di Vercel Environment Variables.'
  }));
  router.post('/avatar', auth, (req, res) => res.status(501).json({
    error: 'Upload tidak tersedia. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET di Vercel Environment Variables.'
  }));
} else {
  buildLocalRoutes(router);
}

/* Info endpoint */
router.get('/info', auth, (req, res) => {
  res.json({ mode: USE_CLOUDINARY ? 'cloudinary' : 'local', maxSize: `${MAX_MB}MB` });
});

/* Error handler multer */
router.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message });
  next();
});

function formatSize(b) {
  if (b < 1024)    return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

module.exports = router;
