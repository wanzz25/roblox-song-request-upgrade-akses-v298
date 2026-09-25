// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Rate Limit — Kuota Request per User                  ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝

const fs   = require('fs');
const path = require('path');
const { dataFile } = require('./dataPaths');
const CFG  = require('../config');
const { isFullAccessRole, isVvip, isPremium, roleLimit, VVIP_RESET_MS } = require('./roles');

const ROOT = path.join(__dirname, '..');

const RATE_FILE   = dataFile('rate_limits.json');
const RATE_WINDOW = CFG.LIMIT_WINDOW_MS;
const RATE_LIMITS = { song: CFG.LIMIT_SONG, banner: CFG.LIMIT_BANNER };

// Legacy hardcoded list — sekarang username ini otomatis udah role 'owner'
// lewat lib/roles.js (DEFAULT_OWNERS), list ini dibiarin kosong tapi tetep
// dicek buat jaga-jaga kalau ada yang nambahin manual di masa depan.
const UNLIMITED_USERNAMES = [];

function readRates() {
  try { return JSON.parse(fs.readFileSync(RATE_FILE, 'utf8')); } catch { return {}; }
}
function saveRates(rates) {
  fs.writeFileSync(RATE_FILE, JSON.stringify(rates, null, 2));
}
function rateKey(req) {
  const u = req.body?.login_username?.trim();
  return u ? `u:${u.toLowerCase()}` : `ip:${req.ip}`;
}
function isUnlimited(username) {
  if (!username) return false;
  const u = username.trim().toLowerCase();
  return UNLIMITED_USERNAMES.includes(u) || isFullAccessRole(u);
}

function checkRateLimit(req, type) {
  const rawUsername = req.body?.login_username?.trim();

  // Bypass total untuk admin/owner/dev — tidak dicek, tidak dicatat.
  if (isUnlimited(rawUsername)) {
    return { allowed: true, used: 0, limit: Infinity };
  }

  const key   = rateKey(req);
  const rates = readRates();
  const bucket = rates[key] || {};
  let hits = bucket[type] || [];

  // VIP/VVIP: limit TETAP per tier (bukan bonus tambahan), dan hits
  // yang lebih lama dari 24 jam otomatis "kadaluarsa" -- gak nunggu sesi
  // dibuka ulang kayak member biasa.
  if (isPremium(rawUsername)) {
    const cutoff = Date.now() - VVIP_RESET_MS;
    hits = hits.filter(t => t > cutoff);
    const limit = roleLimit(rawUsername, type);

    if (hits.length >= limit) {
      const oldest = Math.min(...hits);
      const resetInMs = Math.max(0, (oldest + VVIP_RESET_MS) - Date.now());
      return {
        allowed: false, resetInMs, resetAt: oldest + VVIP_RESET_MS,
        message: `Limit request ${type === 'song' ? 'lagu' : 'banner'} kamu sudah habis (${limit}x). ` +
                 `Reset otomatis dalam ${Math.ceil(resetInMs / 60000)} menit.`
      };
    }

    hits.push(Date.now());
    bucket[type] = hits;
    rates[key] = bucket;
    saveRates(rates);
    return { allowed: true, used: hits.length, limit };
  }

  // Member biasa: limit permanen sampai direset manual (resetUserRate/resetAllRates)
  // atau otomatis saat sesi request global dibuka lagi (lihat lib/songSchedule.js
  // openSession()) -- tidak ada expiry berbasis waktu.
  const limit = RATE_LIMITS[type] + getBonus(rawUsername, type);

  if (hits.length >= limit) {
    return {
      allowed: false,
      resetInMs: null,
      resetAt: null,
      message: `Limit request ${type === 'song' ? 'lagu' : 'banner'} kamu sudah habis (${limit}x). ` +
               `Limit akan kembali otomatis saat sesi request dibuka lagi oleh admin.`
    };
  }

  hits.push(Date.now());
  bucket[type] = hits;
  rates[key] = bucket;
  saveRates(rates);
  return { allowed: true, used: hits.length, limit };
}

const BONUS_FILE = dataFile('limit_bonus.json');
function readBonus() { try { return JSON.parse(fs.readFileSync(BONUS_FILE, 'utf8')); } catch { return {}; } }
function saveBonus(b) { fs.writeFileSync(BONUS_FILE, JSON.stringify(b, null, 2)); }
function getBonus(username, type) {
  if (!username) return 0;
  const b = readBonus();
  return (b[username.toLowerCase()] || {})[type] || 0;
}
function addBonus(username, type, amount) {
  const b = readBonus();
  const key = username.toLowerCase();
  b[key] = b[key] || {};
  b[key][type] = (b[key][type] || 0) + amount;
  saveBonus(b);
  return b[key][type];
}
function resetUserRate(username) {
  const rates = readRates();
  delete rates['u:' + username.toLowerCase()];
  saveRates(rates);
}

// ── Pelanggaran durasi lagu (maks 7 menit) ──────────────────────────────────
// Pelanggaran ke-1: cuma ditolak (gratis, gak ada konsekuensi tambahan).
// Pelanggaran ke-2 dst: DITOLAK + limit song-nya dikurangi 1 (permanen,
// lewat sistem bonus yang sama kayak addBonus, cuma dikasih nilai negatif).
const DURATION_VIOLATIONS_FILE = dataFile('duration_violations.json');
function readDurationViolations() { try { return JSON.parse(fs.readFileSync(DURATION_VIOLATIONS_FILE, 'utf8')); } catch { return {}; } }
function saveDurationViolations(v) { fs.writeFileSync(DURATION_VIOLATIONS_FILE, JSON.stringify(v, null, 2)); }

function recordDurationViolation(username, type = 'song') {
  if (!username) return { count: 1, penalized: false };
  const key = username.trim().toLowerCase();
  const v = readDurationViolations();
  v[key] = (v[key] || 0) + 1;
  saveDurationViolations(v);
  const penalized = v[key] >= 2;
  if (penalized) {
    // PENTING: penalti ini konsumsi 1 slot EKSTRA di limit SESI yang lagi
    // jalan (rates.json) -- BUKAN bonus permanen (limit_bonus.json). Efeknya:
    // penalti ini otomatis "ilang sendiri" begitu admin buka sesi baru
    // (resetAllRates ke-panggil dari openSession), persis kayak limit normal
    // yang emang refresh tiap sesi -- bukan nempel selamanya.
    const rates = readRates();
    const rk = `u:${key}`;
    const bucket = rates[rk] || {};
    const hits = bucket[type] || [];
    hits.push(Date.now());
    bucket[type] = hits;
    rates[rk] = bucket;
    saveRates(rates);
  }
  return { count: v[key], penalized };
}

const LIMITS_CONFIG_FILE = dataFile('limits_config.json');

let _window = RATE_WINDOW;

(function loadLimitsConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(LIMITS_CONFIG_FILE, 'utf8'));
    if (saved.song   !== undefined) RATE_LIMITS.song   = saved.song;
    if (saved.banner !== undefined) RATE_LIMITS.banner = saved.banner;
    if (saved.window !== undefined) _window = saved.window;
  } catch {}
})();

function getRateWindow() { return _window; }

function saveLimitsConfig() {
  fs.writeFileSync(LIMITS_CONFIG_FILE, JSON.stringify({
    song  : RATE_LIMITS.song,
    banner: RATE_LIMITS.banner,
    window: _window
  }, null, 2));
}

function setWindow(ms) {
  _window = ms;
  saveLimitsConfig();
}

function fmtWindow(ms) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0 && m > 0) return `${h} jam ${m} menit`;
  if (h > 0)          return `${h} jam`;
  return `${m} menit`;
}

function refundRateLimit(username, type) {
  if (!username) return;

  // Kalau kuota GLOBAL buat type ini udah bener-bener abis (sisa 0), jangan
  // refund limit personal -- soalnya percobaan berikutnya bakal ditolak lagi
  // oleh gerbang sesi/kuota global, bukan gara-gara limit personal. Refund di
  // situasi ini cuma bikin orang bisa coba berkali-kali nembus kuota yang
  // emang udah abis. Refund CUMA jalan kalau kuota global masih ada sisa
  // (atau memang unlimited/null).
  // Lazy require biar gak circular dependency sama lib/songSchedule.js
  // (songSchedule.js sendiri require lib/ratelimit.js buat resetAllRates()).
  try {
    const { readSongSession } = require('./songSchedule');
    const session = readSongSession();
    const t = session?.[type];
    if (t && t.quota != null) {
      const remaining = t.quota - (t.count || 0);
      if (remaining <= 0) return; // kuota global abis -> gak di-refund
    }
  } catch { /* kalau gagal baca sesi, lanjut refund seperti biasa (fail-safe) */ }

  const key   = `u:${username.toLowerCase()}`;
  const rates = readRates();
  const bucket = rates[key];
  if (!bucket || !bucket[type] || !bucket[type].length) return;
  bucket[type].pop();
  if (!bucket[type].length) delete bucket[type];
  if (!Object.keys(bucket).length) delete rates[key];
  saveRates(rates);
}

// Reset limit personal SEMUA user sekaligus (dipakai saat sesi/kuota global lagu
// dibuka ulang — biar semua orang balik dapet jatah penuh, gak ketahan sisa cooldown lama).
function resetAllRates(type) {
  const rates = readRates();
  for (const key of Object.keys(rates)) {
    if (type) {
      delete rates[key][type];
      if (!Object.keys(rates[key]).length) delete rates[key];
    } else {
      delete rates[key];
    }
  }
  saveRates(rates);
}

// ── Cooldown submit -- nyegah user spam-klik tombol Kirim Request yang bikin
// banyak permintaan ke API provider dalam hitungan detik. Ini TERPISAH dari
// limit kuota di atas (kuota = "boleh berapa kali total", cooldown = "jangan
// kecepetan submit lagi") -- disimpan in-memory doang (gak perlu file, cukup
// jarak antar klik, direset kalau server restart -- gak masalah).
const lastSubmitAt = new Map(); // key -> timestamp submit terakhir

function checkSubmitCooldown(req) {
  const rawUsername = req.body?.login_username?.trim();
  if (isUnlimited(rawUsername)) return { allowed: true }; // admin/owner/dev bebas cooldown

  const key = rateKey(req);
  const now = Date.now();
  const last = lastSubmitAt.get(key);
  const cooldown = CFG.SUBMIT_COOLDOWN_MS || 0;

  if (last && (now - last) < cooldown) {
    const waitMs = cooldown - (now - last);
    return {
      allowed: false,
      waitMs,
      message: `Jangan buru-buru! Tunggu ${Math.ceil(waitMs / 1000)} detik lagi sebelum request berikutnya.`
    };
  }
  return { allowed: true };
}

// Dipanggil SETELAH request beneran diproses (bukan pas gagal validasi awal),
// biar orang yang emang typo/gagal validasi gak ikut kena cooldown percuma.
function markSubmitted(req) {
  lastSubmitAt.set(rateKey(req), Date.now());
}

// ── Video Tron: aturan KHUSUS, beda dari song/banner ────────────────────
// - Cuma VIP / VVIP / admin / owner yang boleh pakai (member biasa DITOLAK
//   TOTAL, bukan dikasih kuota 0 -- pesannya beda: suruh upgrade).
// - Limit HARIAN beda per role (lihat ROLE_LIMITS di lib/roles.js -- saat
//   ini VVIP & VIP sama-sama 1x/hari, tapi tetap dihitung per-role biar
//   gampang diubah beda-beda nanti tanpa ubah logic di sini).
// - WAJIB jeda minimal 2 jam antar-request meski kuota harian masih sisa.
const VIDEO_COOLDOWN_MS  = 2 * 60 * 60 * 1000;  // 2 jam
const VIDEO_WINDOW_MS    = 24 * 60 * 60 * 1000; // 24 jam rolling

function checkVideoLimit(username) {
  // Admin/owner: bypass total, konsisten sama tipe lain.
  if (isUnlimited(username)) return { allowed: true, used: 0, limit: Infinity };

  // Member biasa (bukan VIP/VVIP): DITOLAK TOTAL, bukan cuma dibatasin kuotanya.
  if (!isPremium(username)) {
    return {
      allowed: false, locked: true,
      message: 'Video Tron cuma buat member VIP, VVIP, admin, atau owner. Upgrade dulu buat bisa pakai fitur ini.'
    };
  }

  if (!username) return { allowed: false, message: 'Login dulu buat request Video Tron.' };

  const maxPerDay = roleLimit(username, 'video');
  const key   = `u:${username.trim().toLowerCase()}`;
  const rates = readRates();
  const bucket = rates[key] || {};
  let hits = (bucket.video || []).filter(t => t > Date.now() - VIDEO_WINDOW_MS);

  // Cek kuota harian DULUAN -- kalau ini yang jadi ganjalan, tampilin pesan
  // itu (reset bisa sampai ~24 jam), JANGAN kebalik nunjukin pesan cooldown
  // 2 jam yang lebih pendek padahal kuota hariannya sendiri masih abis.
  if (hits.length >= maxPerDay) {
    const oldest = Math.min(...hits);
    const resetInMs = Math.max(0, (oldest + VIDEO_WINDOW_MS) - Date.now());
    return {
      allowed: false, resetInMs, resetAt: oldest + VIDEO_WINDOW_MS,
      message: `Limit Video Tron harian kamu sudah habis (${maxPerDay}x/hari). Reset dalam ${Math.ceil(resetInMs / 3600000)} jam.`
    };
  }

  if (hits.length) {
    const lastHit = Math.max(...hits);
    const sinceLast = Date.now() - lastHit;
    if (sinceLast < VIDEO_COOLDOWN_MS) {
      const waitMs = VIDEO_COOLDOWN_MS - sinceLast;
      return {
        allowed: false, resetInMs: waitMs, resetAt: Date.now() + waitMs,
        message: `Tunggu ${Math.ceil(waitMs / 60000)} menit lagi sebelum bisa request Video Tron berikutnya (jeda minimal 2 jam antar-request).`
      };
    }
  }

  hits.push(Date.now());
  bucket.video = hits;
  rates[key] = bucket;
  saveRates(rates);
  return { allowed: true, used: hits.length, limit: maxPerDay };
}

module.exports = {
  RATE_WINDOW, RATE_LIMITS,
  readRates, saveRates, rateKey, checkRateLimit, checkVideoLimit,
  VIDEO_COOLDOWN_MS, VIDEO_WINDOW_MS,
  readBonus, saveBonus, getBonus, addBonus, resetUserRate, resetAllRates,
  LIMITS_CONFIG_FILE, saveLimitsConfig,
  refundRateLimit,
  getRateWindow, setWindow, fmtWindow,
  isUnlimited, recordDurationViolation,
  checkSubmitCooldown, markSubmitted
};
