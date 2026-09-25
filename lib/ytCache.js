// ╔═══════════════════════════════════════════════════════════╗
// ║   YT Cache — simpen hasil download YouTube sementara        ║
// ║                                                           ║
// ║   Lagu viral sering di-request banyak orang / diulang admin. ║
// ║   Kalau video yang sama sudah pernah berhasil di-download &   ║
// ║   dikonversi dalam beberapa jam terakhir, pakai file itu     ║
// ║   lagi -- gak perlu nembak API provider sama sekali (lebih    ║
// ║   cepat, dan API provider gak dikeroyok).                    ║
// ╚═══════════════════════════════════════════════════════════╝

const fs   = require('fs');
const path = require('path');
const { CACHE_DIR, dirSize, TMP_DIR, TMP_MAX_BYTES } = require('./tempdir');

// Cache ada di tmp/yt-cache (disk server, bukan /tmp yang isinya ada di RAM/tmpfs) dan
// KECIL: cuma buat lagu yang sering di-request ulang. Kalau tmp/ sudah terisi > 60% dari
// batasnya, cache berhenti nambah (put() gagal diam-diam) & yang lama dibuang duluan.
const DEFAULT_TTL = 3 * 60 * 60 * 1000; // 3 jam
const MAX_ENTRIES = 25;
const MAX_BYTES   = 120 * 1024 * 1024;  // 120 MB total

// Ambil ID video (11 karakter) dari berbagai bentuk link YouTube. null kalau bukan link YouTube.
function extractYtId(url) {
  const s = String(url || '').trim();
  let m = s.match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:embed\/|shorts\/|live\/|v\/))([\w-]{11})(?![\w-])/i);
  if (m) return m[1];
  m = s.match(/[?&]v=([\w-]{11})(?![\w-])/i);
  return m ? m[1] : null;
}

function ensureDir() { try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {} }
const audioPath = (id) => path.join(CACHE_DIR, `${id}.mp3`);
const metaPath  = (id) => path.join(CACHE_DIR, `${id}.json`);

function get(id, ttlMs = DEFAULT_TTL) {
  if (!id) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
    if (Date.now() - (meta.savedAt || 0) > ttlMs) { remove(id); return null; }
    const p = audioPath(id);
    if (!fs.existsSync(p) || fs.statSync(p).size < 2000) { remove(id); return null; }
    return { path: p, meta };
  } catch { return null; }
}

function remove(id) {
  try { fs.unlinkSync(audioPath(id)); } catch {}
  try { fs.unlinkSync(metaPath(id)); } catch {}
}

function prune(ttlMs = DEFAULT_TTL) {
  try {
    const now = Date.now();
    const entries = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json')).map(f => {
      const id = f.slice(0, -5);
      let savedAt = 0, size = 0;
      try { savedAt = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8')).savedAt || 0; } catch {}
      try { size = fs.statSync(audioPath(id)).size; } catch {}
      return { id, savedAt, size };
    }).sort((a, b) => b.savedAt - a.savedAt); // terbaru dulu
    let total = 0, kept = 0;
    for (const e of entries) {
      total += e.size; kept++;
      if (now - e.savedAt > ttlMs || kept > MAX_ENTRIES || total > MAX_BYTES) remove(e.id);
    }
  } catch {}
}

// Simpan salinan file (srcPath TIDAK dipindah/diubah -- pemanggil tetap pakai file aslinya).
function put(id, srcPath, meta) {
  if (!id) return false;
  try {
    ensureDir();
    // Jangan pernah rebutan tempat dgn file yang lagi dipakai proses lain.
    let size = 0; try { size = fs.statSync(srcPath).size; } catch {}
    if (dirSize(TMP_DIR) + size > TMP_MAX_BYTES * 0.6) return false;
    const tmp = audioPath(id) + '.tmp';
    fs.copyFileSync(srcPath, tmp);
    fs.renameSync(tmp, audioPath(id));
    fs.writeFileSync(metaPath(id), JSON.stringify({ ...meta, savedAt: Date.now() }));
    prune();
    return true;
  } catch { return false; }
}

module.exports = { CACHE_DIR, extractYtId, get, put, remove, prune };
