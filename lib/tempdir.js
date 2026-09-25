// ╔═══════════════════════════════════════════════════════════╗
// ║   Tempdir — SATU tempat buat semua file sementara,          ║
// ║   dengan batas ukuran, pembersih otomatis, dan alarm.        ║
// ║                                                           ║
// ║   MASALAH LAMA: semua file sementara ditulis ke os.tmpdir()  ║
// ║   = /tmp. Di Pterodactyl, /tmp itu TMPFS (disk yang isinya   ║
// ║   ada di RAM) dengan kapasitas kecil (bawaan ~100 MB) DAN    ║
// ║   ikut dihitung sebagai pemakaian MEMORI container. Video     ║
// ║   (frame), file download, cache YouTube, upload mobile -- itu ║
// ║   semua numpuk di sana -> "ENOSPC: no space left on device"   ║
// ║   dan memori server ikut penuh.                              ║
// ║                                                           ║
// ║   SEKARANG: semua file sementara ada di folder tmp/ di dalam  ║
// ║   folder server (disk biasa, BUKAN RAM), dengan:              ║
// ║    • batas total (TMP_MAX_MB) yang dicek sebelum nulis besar   ║
// ║    • pembersih berkala + pembersih darurat saat mepet         ║
// ║    • laporan ke Owner kalau penyimpanan benar-benar penuh     ║
// ╚═══════════════════════════════════════════════════════════╝

const fs   = require('fs');
const path = require('path');
const CFG  = require('../config');

const ROOT        = path.join(__dirname, '..');
const MB          = 1024 * 1024;
const TMP_DIR     = process.env.APP_TMP_DIR ? path.resolve(process.env.APP_TMP_DIR) : path.join(ROOT, 'tmp');
const CACHE_DIR   = path.join(TMP_DIR, 'yt-cache');
const UPLOADS_DIR = path.join(ROOT, 'uploads');

const TMP_MAX_BYTES     = (CFG.TMP_MAX_MB     || 300) * MB;   // batas total isi tmp/
const UPLOADS_MAX_BYTES = (CFG.UPLOADS_MAX_MB || 400) * MB;   // batas total isi uploads/ (video yang nunggu diproses)
const MIN_FREE_BYTES    = (CFG.MIN_FREE_MB    || 200) * MB;   // alarm kalau sisa disk di bawah ini
const RECENT_MS         = 2 * 60 * 1000;                      // file yang barusan disentuh dianggap lagi dipakai

try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch {}

// ── util dasar ───────────────────────────────────────────────────────────────
function tmpPath(name) { fs.mkdirSync(TMP_DIR, { recursive: true }); return path.join(TMP_DIR, name); }
function makeTmpDir(prefix) { fs.mkdirSync(TMP_DIR, { recursive: true }); return fs.mkdtempSync(path.join(TMP_DIR, prefix)); }

function listFiles(dir) {
  const out = [];
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else if (e.isFile()) { try { const st = fs.statSync(p); out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs }); } catch {} }
  }
  return out;
}
const dirSize = (dir) => listFiles(dir).reduce((a, f) => a + f.size, 0);

function removeEmptyDirs(dir, keepRoot = true) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) if (e.isDirectory()) removeEmptyDirs(path.join(dir, e.name), false);
  if (!keepRoot) { try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch {} }
}

// Sisa ruang disk di volume tempat dir berada (null kalau Node-nya gak punya statfs).
function freeBytes(dir = TMP_DIR) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch { return null; }
}

const isNoSpaceError = (err) => /ENOSPC|no space left|EDQUOT|disk quota/i.test(String((err && err.message) || err || ''));

// ── notifikasi ke Owner (dibatasi 1x per jam per jenis biar gak spam) ────────────
let notifier = null;
const lastAlert = {};
function setNoSpaceNotifier(fn) { notifier = fn; }
function alertOwner(key, text, everyMs = 60 * 60 * 1000) {
  const now = Date.now();
  if (lastAlert[key] && now - lastAlert[key] < everyMs) return;
  lastAlert[key] = now;
  console.warn('[Tempdir]', text.replace(/<[^>]+>/g, ''));
  try { if (notifier) Promise.resolve(notifier(text)).catch(() => {}); } catch {}
}

// ── pembersihan ─────────────────────────────────────────────────────────────
// Hapus file lebih tua dari ttlMs (cache YouTube diurus ytCache sendiri, jadi dilewati).
function sweep(ttlMs, { includeCache = false } = {}) {
  const now = Date.now(); let freed = 0, n = 0;
  for (const f of listFiles(TMP_DIR)) {
    if (!includeCache && f.path.startsWith(CACHE_DIR + path.sep)) continue;
    if (now - f.mtimeMs > ttlMs) { try { fs.unlinkSync(f.path); freed += f.size; n++; } catch {} }
  }
  removeEmptyDirs(TMP_DIR);
  return { freed, files: n };
}

// Pembersih DARURAT: cache YouTube dibuang semua (gampang dibuat ulang), lalu file
// paling lama dihapus duluan sampai pemakaian turun ke targetRatio dari batas.
// File yang baru disentuh (<2 menit) TIDAK dihapus -- kemungkinan lagi dipakai.
function emergencyClean(targetRatio = 0.5) {
  const now = Date.now(); let freed = 0, n = 0;
  for (const f of listFiles(CACHE_DIR)) { try { fs.unlinkSync(f.path); freed += f.size; n++; } catch {} }
  let files = listFiles(TMP_DIR).filter(f => now - f.mtimeMs > RECENT_MS).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let cur = dirSize(TMP_DIR);
  const target = TMP_MAX_BYTES * targetRatio;
  for (const f of files) {
    if (cur <= target) break;
    try { fs.unlinkSync(f.path); freed += f.size; cur -= f.size; n++; } catch {}
  }
  removeEmptyDirs(TMP_DIR);
  return { freed, files: n, tmpAfter: dirSize(TMP_DIR) };
}

class NoSpaceError extends Error {
  constructor(msg) { super(msg); this.code = 'NO_SPACE'; }
}

// Panggil SEBELUM nulis file besar (needBytes = perkiraan ukuran). Kalau muat -> lanjut.
// Kalau mepet -> bersihin darurat dulu, cek lagi. Kalau tetap gak muat -> throw NoSpaceError
// dengan pesan yang jelas (bukan ENOSPC mentah di tengah proses) + kabarin Owner.
function ensureBudget(needBytes, label = 'file sementara') {
  const enough = () => {
    if (dirSize(TMP_DIR) + needBytes > TMP_MAX_BYTES) return false;
    const free = freeBytes(TMP_DIR);
    if (free != null && free < needBytes + 50 * MB) return false;
    return true;
  };
  if (enough()) return;
  const r = emergencyClean();
  if (enough()) {
    alertOwner('cleaned', `🧹 <b>Penyimpanan sementara mepet</b> — dibersihkan otomatis (${(r.freed / MB).toFixed(0)} MB dibebaskan) sebelum menulis ${label}.`);
    return;
  }
  alertOwner('full', `🚨 <b>Penyimpanan server PENUH</b> — gak muat buat ${label} (perlu ~${Math.ceil(needBytes / MB)} MB). Pemakaian tmp/: ${(dirSize(TMP_DIR) / MB).toFixed(0)} MB dari batas ${(TMP_MAX_BYTES / MB).toFixed(0)} MB. Cek /disk & /cleartmp.`);
  throw new NoSpaceError('Penyimpanan server sedang penuh — coba lagi beberapa saat lagi ya (admin sudah diberi tahu).');
}

// Dipanggil kalau ada error ENOSPC beneran: bersihin agresif + kabarin Owner. Balikin MB yang dibebaskan.
function handleNoSpace(context = '') {
  const r = emergencyClean(0);   // ENOSPC beneran -> buang SEMUA yang tidak sedang dipakai
  const up = pruneUploadsOrphans(10 * 60 * 1000);
  const freedMb = ((r.freed + up.freed) / MB).toFixed(0);
  alertOwner('enospc', `🚨 <b>ENOSPC (penyimpanan penuh)</b>${context ? ` saat ${context}` : ''} — dibersihkan otomatis: <b>${freedMb} MB</b> dibebaskan. Kalau sering terjadi, cek /disk.`, 10 * 60 * 1000);
  return { freedMb: Number(freedMb) };
}

// ── uploads/ (video yang nunggu diproses admin + file multer sementara) ─────────
// File yang masih dirujuk request 'pending' (videoPath) JANGAN dihapus; sisanya yang lebih
// tua dari olderThanMs adalah sisa (request ditolak/gagal/proses putus) -> dibuang.
function referencedUploads() {
  const set = new Set();
  try {
    const { readLogs } = require('./store');
    for (const l of readLogs()) if (l.videoPath && (l.status === 'pending' || l.stage === 'sukses_tunggu_share')) set.add(path.resolve(l.videoPath));
  } catch {}
  return set;
}
function pruneUploadsOrphans(olderThanMs = 30 * 60 * 1000) {
  const keep = referencedUploads(); const now = Date.now(); let freed = 0, n = 0;
  for (const f of listFiles(UPLOADS_DIR)) {
    if (keep.has(path.resolve(f.path))) continue;
    if (now - f.mtimeMs > olderThanMs) { try { fs.unlinkSync(f.path); freed += f.size; n++; } catch {} }
  }
  return { freed, files: n };
}
// Masih ada ruang di uploads/ setelah file upload baru ditulis? (dicek di /api/video)
function uploadsHasRoom() {
  const fits = () => dirSize(UPLOADS_DIR) <= UPLOADS_MAX_BYTES;   // file baru sudah ditulis multer, jadi cukup cek total
  if (fits()) return true;
  pruneUploadsOrphans(2 * 60 * 1000);
  if (fits()) return true;
  alertOwner('uploads-full', `📦 <b>Folder uploads/ penuh</b> (${(dirSize(UPLOADS_DIR) / MB).toFixed(0)} MB, batas ${(UPLOADS_MAX_BYTES / MB).toFixed(0)} MB) — video baru ditolak sementara. Proses/tolak request video yang menunggu.`);
  return false;
}

// Balasan error standar buat route: penyimpanan penuh -> 503 dgn pesan jelas (bukan "terjadi kesalahan").
function respondServerError(res, err) {
  if (err && (err.code === 'NO_SPACE' || isNoSpaceError(err))) {
    if (err.code !== 'NO_SPACE') handleNoSpace('menerima request');
    return res.status(503).json({ success: false, message: 'Penyimpanan server sedang penuh — coba lagi beberapa saat lagi ya (admin sudah diberi tahu). Limit kamu tidak jadi terpakai.' });
  }
  return res.status(500).json({ success: false, message: 'Terjadi kesalahan. Limit kamu tidak jadi terpakai, silakan coba lagi.' });
}

// ── laporan buat /disk ───────────────────────────────────────────────────────
function report() {
  const of = (p) => dirSize(p);
  const parts = [
    ['tmp/ (file sementara)',      of(TMP_DIR)],
    ['   ↳ cache YouTube',         of(CACHE_DIR)],
    ['uploads/ (video menunggu)',  of(UPLOADS_DIR)],
    ['database/ (SEMUA data)',     of(path.join(ROOT, 'database'))],
    ['   ↳ salinan backup lokal',  of(path.join(ROOT, 'database', 'user', 'backups'))],
    ['wa_auth/ (sesi WhatsApp)',   of(path.join(ROOT, 'wa_auth'))],
  ];
  return { parts, free: freeBytes(ROOT), tmpMax: TMP_MAX_BYTES, uploadsMax: UPLOADS_MAX_BYTES, tmpDir: TMP_DIR, tmpfs: !!(process.env.APP_TMP_DIR) };
}

// ── pembersih berkala ────────────────────────────────────────────────────────
function startTempSweeper() {
  try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch {}
  // Sisa dari proses sebelumnya (server mati mendadak): buang yang lebih tua dari 30 menit.
  // Yang lebih baru dibiarkan -- bisa jadi masih dipakai job yang dilanjutkan otomatis.
  const s0 = sweep(30 * 60 * 1000);
  if (s0.files) console.log(`[Tempdir] Sisa lama dibersihkan: ${s0.files} file (${(s0.freed / MB).toFixed(1)} MB)`);

  const tick = () => {
    try {
      sweep(2 * 60 * 60 * 1000);                        // file sementara > 2 jam = sisa
      pruneUploadsOrphans(30 * 60 * 1000);              // upload yatim > 30 menit
      if (dirSize(TMP_DIR) > TMP_MAX_BYTES * 0.8) {     // mepet 80% -> bersihin sebelum bikin gagal
        const r = emergencyClean();
        alertOwner('cleaned', `🧹 <b>tmp/ hampir penuh</b> — dibersihkan otomatis (${(r.freed / MB).toFixed(0)} MB dibebaskan).`);
      }
      const free = freeBytes(ROOT);
      if (free != null && free < MIN_FREE_BYTES) alertOwner('lowdisk', `⚠️ <b>Sisa ruang disk tinggal ${(free / MB).toFixed(0)} MB</b> (ambang ${(MIN_FREE_BYTES / MB).toFixed(0)} MB). Cek /disk.`);
    } catch (e) { console.warn('[Tempdir sweeper]', e.message); }
  };
  tick();
  const t = setInterval(tick, 10 * 60 * 1000);
  if (t.unref) t.unref();
}

module.exports = {
  TMP_DIR, CACHE_DIR, UPLOADS_DIR, TMP_MAX_BYTES, UPLOADS_MAX_BYTES,
  tmpPath, makeTmpDir, dirSize, listFiles, freeBytes, isNoSpaceError,
  sweep, emergencyClean, ensureBudget, handleNoSpace, NoSpaceError,
  pruneUploadsOrphans, uploadsHasRoom, respondServerError, report, setNoSpaceNotifier, alertOwner, startTempSweeper,
};
