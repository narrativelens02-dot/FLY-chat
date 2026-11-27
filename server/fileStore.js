'use strict';

/**
 * Konstanta penyimpanan file di database.
 *
 * Vercel Serverless membatasi body request/response ±4,5 MB, jadi file
 * dipecah menjadi chunk 2 MB. Dengan cara ini foto, dokumen, dan video
 * tetap bisa diunggah/diunduh tanpa object storage eksternal.
 */
const CHUNK_MB = 2;
const CHUNK_BYTES = CHUNK_MB * 1024 * 1024;
const MAX_RANGE_BYTES = CHUNK_BYTES;

module.exports = { CHUNK_MB, CHUNK_BYTES, MAX_RANGE_BYTES };
