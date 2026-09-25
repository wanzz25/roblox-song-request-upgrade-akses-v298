// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Uploads — Konfigurasi Multer (Audio, Gambar & Video)        ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝

const multer = require('multer');
const path   = require('path');
const fs     = require('fs');

const ROOT = path.join(__dirname, '..');

const audioStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(ROOT, 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + Math.round(Math.random()*1e9) + path.extname(file.originalname));
  }
});
const uploadAudio = multer({
  storage: audioStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/mp3|mp4|wav|ogg|flac|m4a|aac/i.test(path.extname(file.originalname).replace('.', '')))
      return cb(null, true);
    cb(new Error('Format audio tidak didukung.'));
  }
});

const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(ROOT, 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + Math.round(Math.random()*1e9) + path.extname(file.originalname));
  }
});
const uploadImage = multer({
  storage: imageStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/jpg|jpeg|png|gif|webp|svg/i.test(path.extname(file.originalname).replace('.', '')))
      return cb(null, true);
    cb(new Error('Format gambar tidak didukung.'));
  }
});

const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(ROOT, 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + Math.round(Math.random()*1e9) + path.extname(file.originalname));
  }
});
const uploadVideo = multer({
  storage: videoStorage,
  limits: { fileSize: 60 * 1024 * 1024 }, // 60MB -- video jauh lebih berat drpd gambar/audio
  fileFilter: (req, file, cb) => {
    if (/mp4|mov|mkv|webm|avi/i.test(path.extname(file.originalname).replace('.', '')))
      return cb(null, true);
    cb(new Error('Format video tidak didukung.'));
  }
});

// ── Pembersih file upload basi ────────────────────────────────────────────
// Video request SEKARANG disimpan di disk server sampai admin memprosesnya
// (gak lagi diambil ulang dari Telegram -- Bot API Telegram cuma mau
// ngasih download file sampai 20 MB, jadi video 21-60 MB dulu selalu gagal
// dengan "file is too big"). Kalau request-nya ditolak/dibatalkan/gak
// pernah diproses, file-nya bisa ketinggalan -- sweeper ini ngehapus file
// di folder uploads/ yang umurnya lewat TTL (default 48 jam).
const UPLOAD_TTL_MS = 48 * 60 * 60 * 1000;

function sweepStaleUploads(ttlMs = UPLOAD_TTL_MS) {
  const dir = path.join(ROOT, 'uploads');
  let removed = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && now - st.mtimeMs > ttlMs) { fs.unlinkSync(p); removed++; }
      } catch {}
    }
  } catch (e) { console.warn('[uploads sweeper]', e.message); }
  if (removed) console.log(`[uploads sweeper] ${removed} file basi dihapus dari uploads/`);
  return removed;
}

function startUploadsSweeper() {
  sweepStaleUploads();
  const t = setInterval(() => sweepStaleUploads(), 60 * 60 * 1000); // tiap 1 jam
  if (t.unref) t.unref();
}

module.exports = { uploadAudio, uploadImage, uploadVideo, sweepStaleUploads, startUploadsSweeper };
