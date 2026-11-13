'use strict';
/**
 * FLYchat — File Upload Route
 *
 * Mode otomatis:
 *   - Jika CLOUDINARY_CLOUD_NAME + CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET tersedia
 *     → upload ke Cloudinary (persistent, cocok untuk Railway/Render/Vercel)
 *   - Jika tidak → fallback ke disk lokal di /uploads (tidak persisten di cloud)
 */
const router = require('express').Router();
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const { v4: uuid } = require('uuid');
const auth   = require('../middleware/auth');

/* ─────────────────────────────────────────
   Deteksi mode upload
───────────────────────────────────────── */
const USE_CLOUDINARY = !!(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET &&
  !process.env.CLOUDINARY_CLOUD_NAME.includes('your_cloud_name')
);

/* ─────────────────────────────────────────
   CLOUDINARY MODE
───────────────────────────────────────── */
function buildCloudinaryUploader() {
  const cloudinary          = require('cloudinary').v2;
  const { CloudinaryStorage } = require('multer-storage-cloudinary');

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });

  const MAX_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '50');

  // Storage chat (gambar, video, dokumen)
  const chatStorage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
      const isImage    = file.mimetype.startsWith('image/');
      const isVideo    = file.mimetype.startsWith('video/');
      const resourceType = isImage ? 'image' : isVideo ? 'video' : 'raw';
      return {
        folder:        'flychat/chat',
        resource_type: resourceType,
        public_id:     `${Date.now()}_${uuid()}`,
        // Aktifkan transformasi untuk gambar agar dioptimasi
        ...(isImage && {
          transformation: [{ quality: 'auto', fetch_format: 'auto' }]
        })
      };
    }
  });

  // Storage avatar
  const avatarStorage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder:        'flychat/avatars',
      resource_type: 'image',
      transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'face', quality: 'auto' }]
    }
  });

  const BLOCKED_EXT = ['.exe', '.bat', '.sh', '.cmd', '.ps1', '.js', '.php', '.py'];

  const chatUpload = multer({
    storage: chatStorage,
    limits:  { fileSize: MAX_MB * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (BLOCKED_EXT.includes(ext)) return cb(new Error(`Tipe file ${ext} tidak diizinkan`));
      cb(null, true);
    }
  });

  const avatarUpload = multer({
    storage: avatarStorage,
    limits:  { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (!file.mimetype.startsWith('image/')) return cb(new Error('Hanya file gambar yang diizinkan'));
      cb(null, true);
    }
  });

  return {
    chatUpload,
    avatarUpload,
    getFileURL:   (req) => req.file.path,          // Cloudinary mengembalikan URL lengkap di path
    getPhotoURL:  (req) => req.file.path
  };
}

/* ─────────────────────────────────────────
   LOCAL DISK MODE (fallback)
───────────────────────────────────────── */
function buildLocalUploader() {
  const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || 'uploads');
  const AVATAR_DIR = path.join(UPLOAD_DIR, 'avatars');
  const CHAT_DIR   = path.join(UPLOAD_DIR, 'chat');

  [UPLOAD_DIR, AVATAR_DIR, CHAT_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });

  const MAX_MB    = parseInt(process.env.MAX_FILE_SIZE_MB || '50');
  const BLOCKED_EXT = ['.exe', '.bat', '.sh', '.cmd', '.ps1', '.js', '.php', '.py'];

  function makeStorage(subdir) {
    return multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(UPLOAD_DIR, subdir);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const ext  = path.extname(file.originalname).toLowerCase();
        cb(null, `${Date.now()}_${uuid()}${ext}`);
      }
    });
  }

  const chatUpload = multer({
    storage: makeStorage('chat'),
    limits:  { fileSize: MAX_MB * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (BLOCKED_EXT.includes(ext)) return cb(new Error(`Tipe file ${ext} tidak diizinkan`));
      cb(null, true);
    }
  });

  const avatarUpload = multer({
    storage: makeStorage('avatars'),
    limits:  { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (!file.mimetype.startsWith('image/')) return cb(new Error('Hanya file gambar yang diizinkan'));
      cb(null, true);
    }
  });

  return {
    chatUpload,
    avatarUpload,
    getFileURL:  (req) => `/uploads/chat/${req.file.filename}`,
    getPhotoURL: (req) => `/uploads/avatars/${req.file.filename}`
  };
}

/* ─────────────────────────────────────────
   Inisialisasi uploader sesuai mode
───────────────────────────────────────── */
let uploader;
try {
  if (USE_CLOUDINARY) {
    uploader = buildCloudinaryUploader();
    console.log('☁️  Upload mode: Cloudinary');
  } else {
    uploader = buildLocalUploader();
    console.log('💾 Upload mode: Disk lokal (atur CLOUDINARY_* di .env untuk cloud storage)');
  }
} catch (err) {
  console.error('⚠️  Upload init error, fallback ke disk lokal:', err.message);
  uploader = buildLocalUploader();
}

/* ─────────────────────────────────────────
   ROUTES
───────────────────────────────────────── */

/* Upload file chat (gambar / video / dokumen) */
router.post('/file', auth, (req, res, next) => {
  uploader.chatUpload.single('file')(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) return res.status(400).json({ error: 'Tidak ada file yang diunggah' });

    res.json({
      fileURL:   uploader.getFileURL(req),
      fileName:  req.file.originalname,
      fileSize:  formatSize(req.file.size || 0),
      mimeType:  req.file.mimetype,
      storage:   USE_CLOUDINARY ? 'cloudinary' : 'local'
    });
  });
});

/* Upload avatar */
router.post('/avatar', auth, (req, res, next) => {
  uploader.avatarUpload.single('avatar')(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) return res.status(400).json({ error: 'Tidak ada file yang diunggah' });

    res.json({
      photoURL: uploader.getPhotoURL(req),
      storage:  USE_CLOUDINARY ? 'cloudinary' : 'local'
    });
  });
});

/* Info mode upload saat ini */
router.get('/info', auth, (req, res) => {
  res.json({
    mode:    USE_CLOUDINARY ? 'cloudinary' : 'local',
    maxSize: `${process.env.MAX_FILE_SIZE_MB || 50}MB`
  });
});

/* Error handler multer */
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

/* ─────────────────────────────────────────
   HELPER
───────────────────────────────────────── */
function formatSize(b) {
  if (b < 1024)    return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

module.exports = router;
