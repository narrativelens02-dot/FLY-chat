'use strict';
const router = require('express').Router();
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const { v4: uuid } = require('uuid');
const auth   = require('../middleware/auth');

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const AVATAR_DIR = path.join(UPLOAD_DIR, 'avatars');
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });

const MAX_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '50');

/* ── Storage engine ── */
function makeStorage(subdir) {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_DIR, subdir || '');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext  = path.extname(file.originalname).toLowerCase();
      const name = `${Date.now()}_${uuid()}${ext}`;
      cb(null, name);
    }
  });
}

/* ── Upload file chat (image / video / document) ── */
const chatUpload = multer({
  storage: makeStorage('chat'),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // Blokir file berbahaya
    const blocked = ['.exe', '.bat', '.sh', '.cmd', '.ps1', '.js', '.php'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (blocked.includes(ext)) return cb(new Error(`Tipe file ${ext} tidak diizinkan`));
    cb(null, true);
  }
});

router.post('/file', auth, chatUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Tidak ada file yang diunggah' });

  const fileURL = `/uploads/chat/${req.file.filename}`;
  res.json({
    fileURL,
    fileName: req.file.originalname,
    fileSize: formatSize(req.file.size),
    mimeType: req.file.mimetype
  });
});

/* ── Upload avatar ── */
const avatarUpload = multer({
  storage: makeStorage('avatars'),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Hanya file gambar yang diizinkan'));
    cb(null, true);
  }
});

router.post('/avatar', auth, avatarUpload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Tidak ada file yang diunggah' });
  res.json({ photoURL: `/uploads/avatars/${req.file.filename}` });
});

/* ── Error handler multer ── */
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

function formatSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

module.exports = router;
