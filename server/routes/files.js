'use strict';
/**
 * Penyajian file yang tersimpan di database (fallback Vercel).
 *
 * Mendukung HTTP Range agar video bisa diputar/di-seek dan unduhan
 * dokumen besar bisa diambil per potongan (di bawah limit Vercel).
 */
const router = require('express').Router();
const { sql } = require('../db');
const { ah } = require('../utils');
const { CHUNK_BYTES, MAX_RANGE_BYTES } = require('../fileStore');

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;

  let start, end;
  if (m[1] === '') {
    /* Suffix range: bytes=-500 → 500 byte terakhir */
    const len = Math.min(size, Number(m[2]));
    start = size - len;
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return { invalid: true };
  }
  return { start, end };
}

function safeFilename(name) {
  return String(name || 'file').replace(/["\\\r\n]/g, '_');
}

function toBuffer(val) {
  if (Buffer.isBuffer(val)) return val;
  if (val instanceof Uint8Array) return Buffer.from(val);
  if (typeof val === 'string' && val.startsWith('\\x')) return Buffer.from(val.slice(2), 'hex');
  return Buffer.from(val);
}

router.get('/:id', ah(async (req, res) => {
  const [file] = await sql`
    SELECT id, file_name, mime_type, file_size, status
    FROM uploaded_files
    WHERE id = ${req.params.id}
  `;
  if (!file || file.status !== 'ready') {
    return res.status(404).json({ error: 'File tidak ditemukan' });
  }

  const size = Number(file.file_size) || 0;
  res.setHeader('X-File-Size', String(size));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Content-Disposition', `inline; filename="${safeFilename(file.file_name)}"`);

  if (size <= 0) return res.status(200).end();

  let range = parseRange(req.headers.range, size);
  if (range && range.invalid) {
    res.setHeader('Content-Range', `bytes */${size}`);
    return res.status(416).end();
  }
  if (!range) range = { start: 0, end: size - 1 };

  /* Batasi ukuran respons agar tidak melewati limit Vercel */
  const start = range.start;
  const end = Math.min(range.end, start + MAX_RANGE_BYTES - 1, size - 1);
  const length = end - start + 1;

  const firstIdx = Math.floor(start / CHUNK_BYTES);
  const lastIdx  = Math.floor(end / CHUNK_BYTES);

  const rows = await sql`
    SELECT idx, data
    FROM uploaded_file_chunks
    WHERE file_id = ${file.id} AND idx BETWEEN ${firstIdx} AND ${lastIdx}
    ORDER BY idx ASC
  `;
  if (!rows.length) return res.status(404).json({ error: 'Isi file tidak ditemukan' });

  const joined = Buffer.concat(rows.map(r => toBuffer(r.data)));
  const offset = start - firstIdx * CHUNK_BYTES;
  const body = joined.subarray(offset, offset + length);

  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.setHeader('Content-Length', String(body.length));

  if (req.headers.range || size > MAX_RANGE_BYTES) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }

  res.end(body);
}));

module.exports = router;
