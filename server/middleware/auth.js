'use strict';
const jwt = require('jsonwebtoken');

/**
 * Middleware: verifikasi JWT dari header Authorization: Bearer <token>
 * Menyimpan payload ke req.user = { id, email, name }
 */
function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) return res.status(401).json({ error: 'Token tidak ditemukan' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token tidak valid atau kedaluwarsa' });
  }
}

module.exports = authMiddleware;
