'use strict';

/** Bungkus handler async agar error-nya diteruskan ke Express error handler. */
function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** Emit Socket.io event bila instance Socket.io tersedia (tidak ada di Vercel). */
function emitTo(req, room, event, payload) {
  const io = req.app && req.app.get ? req.app.get('io') : null;
  if (io) io.to(room).emit(event, payload);
}

/** Batas panjang pesan teks. */
const MAX_TEXT_LENGTH = 4000;

module.exports = { ah, emitTo, MAX_TEXT_LENGTH };
