// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Util — Helper Murni                                  ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝


function getTime() {
  return new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'full', timeStyle: 'short' });
}

const statusLabel = { pending: '⏳ Pending', approved: '✅ Disetujui', rejected: '❌ Ditolak' };


function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function sanitizeFilename(name, ext) {
  let base = String(name || 'audio')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) base = 'audio';
  if (base.length > 80) base = base.slice(0, 80).trim();
  const cleanExt = (ext || '.mp3').toLowerCase();
  return base.toLowerCase().endsWith(cleanExt) ? base : `${base}${cleanExt}`;
}

function actorFrom(from) {
  return { id: String(from?.id || ''), name: from?.first_name || (from?.username ? '@' + from.username : String(from?.id || 'admin')) };
}

// Escape karakter spesial HTML supaya input user (nama, judul, pesan, dll) tidak
// merusak parse_mode:'HTML' Telegram. Tanpa ini, nama/pesan yang mengandung
// karakter seperti < > & bisa bikin Telegram GAGAL kirim pesan/gambar sama sekali
// (error "can't parse entities") — request jadi hilang tanpa notif ke admin.
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Buang watermark domain situs downloader dari judul video (mis. video hasil
// reupload yang dikasih judul "vidssave.com DJ VIRAL..." oleh uploader-nya).
// Ini FILTER TAMPILAN saja -- judul asli dari YouTube tetap apa adanya di
// sumbernya, cuma dibersihin sebelum disimpan/ditampilkan ke user di sini.
const TITLE_JUNK_PATTERNS = [
  // domain umum situs download/converter: vidssave.com, y2mate.com, savefrom.net, dst.
  /\b[a-z0-9-]+\.(?:com|net|org|id|co|me|to|xyz|cc|io|app|site|online|club|info)\b/gi,
  // tag umum yang suka ditambahin situs reupload
  /\b(?:download|downloader|converter|mp3\s*download|free\s*download)\b/gi,
];

function sanitizeTitle(title) {
  let t = String(title || '');
  for (const pattern of TITLE_JUNK_PATTERNS) t = t.replace(pattern, ' ');
  t = t
    .replace(/[|•·\-–—_]{1,}/g, m => (m.length > 2 ? ' ' : m)) // rapikan pemisah panjang sisa junk
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s|•·\-–—_]+|[\s|•·\-–—_]+$/g, '')
    .trim();
  return t || String(title || '').trim();
}

module.exports = { getTime, statusLabel, makeId, sanitizeFilename, actorFrom, escapeHtml, sanitizeTitle };
