// ╔═══════════════════════════════════════════════════════════╗
// ║   Role System — VVIP / Admin / Owner / Dev                ║
// ║   Satu sumber data role + displayName ("nama rahasia"),    ║
// ║   dipakai bareng sama isUnlimited & bonus limit. Semua      ║
// ║   request (web ATAUPUN APK lewat API) otomatis kena efek    ║
// ║   role ini karena sama-sama ngirim login_username ke        ║
// ║   endpoint panel yang sama.                                ║
// ╚═══════════════════════════════════════════════════════════╝

const fs   = require('fs');
const path = require('path');

const ROOT       = path.join(__dirname, '..');
// Data role/titel sekarang disimpen di database/user/titel.json (bukan
// roles.json di root lagi) -- struktur folder database/ buat semua data
// user ke depannya, biar rapi & gampang di-backup (lihat /backupdb).
const USER_DB_DIR = path.join(ROOT, 'database', 'user');
const ROLES_FILE  = path.join(USER_DB_DIR, 'titel.json');

function ensureUserDbDir() {
  fs.mkdirSync(USER_DB_DIR, { recursive: true });
}

const VALID_ROLES = ['member', 'vip', 'vvip', 'admin', 'owner', 'dev'];

// VVIP & VIP: limit TETAP per role (beda-beda), reset otomatis SEKALI SEHARI,
// dan bebas total dari app off/maintenance/limit-global (sesi tertutup) --
// TAPI TETAP kena limit personalnya sendiri & TETAP kena ban kalau di-ban --
// beda dari admin/owner/dev yang full bypass semuanya termasuk limit personal & ban.
const ROLE_LIMITS = {
  vvip: { song: 10, banner: 5, video: 1 },
  vip:  { song: 5,  banner: 3, video: 1 },
};
// Alias lama -- beberapa kode lain mungkin masih baca VVIP_LIMITS langsung.
const VVIP_LIMITS = ROLE_LIMITS.vvip;
const VVIP_RESET_MS = 24 * 60 * 60 * 1000; // 1 hari (per hari)
// VIP & VVIP cuma berlaku SEMENTARA (langganan harian, lihat harga di
// lib/vvipShop.js), bukan permanen -- otomatis balik jadi member kalau udah
// lewat. Role lain (admin/owner/dev) tetep permanen sampai diubah manual.
const VVIP_DURATION_MS = 90 * 24 * 60 * 60 * 1000; // 3 bulan (~90 hari) -- default kalau /setrole manual gak nentuin durasi

// Username yang otomatis dianggap 'owner' + displayName default walau belum
// pernah diset manual lewat /setrole (biar tetep kompatibel sama fitur
// full-access & "wanzz" yang udah ada sebelumnya, zero-config).
const DEFAULT_OWNERS = ['wanzzgantengbanget'];
const DEFAULT_DISPLAY_NAMES = { wanzzgantengbanget: 'wanzz' };

// Struktur file titel.json sekarang: { [username_lowercase]: { role, displayName } }
// Cache "data role terakhir yang valid" di memori proses ini -- ini kunci
// biar VVIP GAK KENA RESET kalau titel.json sempet gagal dibaca (misal lagi
// di-copy/dipindah pas migrasi server, disk hiccup, dll). TANPA cache ini,
// readRoles() bakal kepaksa balikin {} pas gagal baca, dan kalau PAS itu juga
// ada setRole() lain yang nyoba nyimpen (misal VVIP baru aja kebeli), hasil
// simpenannya bakal NIMPA SEMUA role user jadi cuma berisi 1 user itu doang
// -- history VVIP orang lain ilang permanen. Dengan cache, kejadian gagal
// baca yang sifatnya SEMENTARA (migrasi lagi jalan) gak bakal bikin data
// hilang, karena tetep pakai data terakhir yang berhasil dibaca.
let cachedRoles = null;

function readRoles() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'));
    cachedRoles = parsed; // simpan sebagai "last known good"
    return parsed;
  } catch (e) {
    if (!fs.existsSync(ROLES_FILE)) {
      // Beneran belum pernah ada -- coba migrasi dari lokasi lama (roles.json
      // di root), BUKAN kasus "lagi dipindah/korup".
      const OLD_FILE = path.join(ROOT, 'roles.json');
      try {
        const old = JSON.parse(fs.readFileSync(OLD_FILE, 'utf8'));
        saveRoles(old);
        console.log('[roles] Migrasi roles.json (lama) -> database/user/titel.json (baru) berhasil.');
        return old;
      } catch { /* memang belum pernah ada sama sekali, lanjut ke bawah */ }
    } else {
      // File ADA tapi GAGAL diparse -- kemungkinan lagi di-copy/dipindah
      // (setengah ke-tulis) atau korup. JANGAN anggap ini "kosong" kalau
      // kita masih punya cache yang valid dari pembacaan sebelumnya.
      console.error('[roles] Gagal baca titel.json (mungkin lagi dipindah/korup):', e.message);
      if (cachedRoles) console.error('[roles] Pakai cache role terakhir yang valid buat sementara (VVIP tetap jalan normal).');
    }
    return cachedRoles || {};
  }
}
function saveRoles(r) {
  ensureUserDbDir();
  // Tulis atomik: tulis ke file .tmp dulu, baru rename ke nama aslinya.
  // Rename di level filesystem itu ATOMIK -- jadi titel.json TIDAK PERNAH
  // kebaca dalam kondisi "setengah tertulis" walau prosesnya keburu
  // di-restart/dipindah/nge-crash di tengah proses simpen.
  const tmpFile = ROLES_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(r, null, 2));
  fs.renameSync(tmpFile, ROLES_FILE);
  cachedRoles = r; // update cache juga
}

function getRole(username) {
  if (!username) return 'member';
  const u = username.trim().toLowerCase();
  if (DEFAULT_OWNERS.includes(u)) return 'dev';
  const roles = readRoles();
  const entry = roles[u];
  if (!entry) return 'member';

  // VIP & VVIP cuma sementara -- kalau udah lewat expiresAt, auto-downgrade
  // ke member (dibersihin dari titel.json) tiap kali role-nya dicek.
  if ((entry.role === 'vvip' || entry.role === 'vip') && entry.expiresAt && Date.now() > entry.expiresAt) {
    delete roles[u];
    saveRoles(roles);
    return 'member';
  }
  return entry.role || 'member';
}

// Sisa hari VIP/VVIP sebelum expired -- null kalau bukan vip/vvip / gak ada expiry.
function getVvipDaysLeft(username) {
  if (!username) return null;
  const u = username.trim().toLowerCase();
  const roles = readRoles();
  const entry = roles[u];
  if (!entry || (entry.role !== 'vvip' && entry.role !== 'vip') || !entry.expiresAt) return null;
  const msLeft = entry.expiresAt - Date.now();
  if (msLeft <= 0) return 0;
  return Math.ceil(msLeft / (24 * 60 * 60 * 1000));
}

// Kapan VIP/VVIP user ini berakhir (epoch ms) -- null kalau bukan vip/vvip / tanpa expiry / sudah lewat.
function getRoleExpiryMs(username) {
  if (!username) return null;
  const u = username.trim().toLowerCase();
  const entry = readRoles()[u];
  if (!entry || (entry.role !== 'vvip' && entry.role !== 'vip') || !entry.expiresAt) return null;
  return entry.expiresAt > Date.now() ? entry.expiresAt : null;
}

// displayName = "nama rahasia" yang ditampilin ke publik (app, tiket ke admin)
// -- username LOGIN asli TETAP dipakai apa adanya buat auth/limit/backend,
// cuma gak ditampilin ke siapa-siapa selain lewat command bot ini.
function getDisplayName(username) {
  if (!username) return username;
  const u = username.trim().toLowerCase();
  const roles = readRoles();
  return roles[u]?.displayName || DEFAULT_DISPLAY_NAMES[u] || username;
}

// ── Parser durasi custom buat /setrole ───────────────────────────────────
// Format: angka + satuan. d = hari, w = minggu (7 hari), m = bulan (30 hari).
// Contoh: 1d, 21w, 1m. Boleh lebih dari 1 token & digabung (dijumlahkan):
//   ['1m', '2w', '3d'] = 1 bulan + 2 minggu + 3 hari = 47 hari.
const DURATION_UNIT_MS   = { d: 24 * 60 * 60 * 1000, w: 7 * 24 * 60 * 60 * 1000, m: 30 * 24 * 60 * 60 * 1000 };
const DURATION_UNIT_NAME = { d: 'hari', w: 'minggu', m: 'bulan' };
const MAX_CUSTOM_DURATION_MS = 3650 * 24 * 60 * 60 * 1000; // 10 tahun -- batas wajar biar gak salah ketik

function parseDurationTokens(tokens) {
  const list = (Array.isArray(tokens) ? tokens : [tokens]).map(t => String(t).trim()).filter(Boolean);
  if (!list.length) return { ok: false, error: 'Durasi kosong.' };
  const sums = { m: 0, w: 0, d: 0 };
  let ms = 0;
  for (const raw of list) {
    const m = raw.match(/^(\d{1,6})([dwm])$/i);
    if (!m) return { ok: false, error: `Durasi "${raw}" tidak valid. Pakai angka + satuan: d = hari, w = minggu, m = bulan (contoh: 1d, 2w, 1m).` };
    const n = parseInt(m[1], 10);
    if (n <= 0) return { ok: false, error: `Durasi "${raw}" harus lebih dari 0.` };
    const unit = m[2].toLowerCase();
    sums[unit] += n;
    ms += n * DURATION_UNIT_MS[unit];
  }
  if (ms > MAX_CUSTOM_DURATION_MS) return { ok: false, error: 'Durasi terlalu panjang (maksimal 10 tahun). Cek lagi angkanya.' };
  const label = ['m', 'w', 'd'].filter(u => sums[u]).map(u => `${sums[u]} ${DURATION_UNIT_NAME[u]}`).join(' ');
  return { ok: true, ms, label, days: Math.round(ms / DURATION_UNIT_MS.d) };
}

// Set role + displayName sekaligus -- ini yang dipakai /setrole sekarang.
// displayName boleh null/kosong kalau mau tetep pakai username asli buat tampilan.
// customDurationMs (opsional) -- dipakai auto-order VVIP (routes/vvip.js) buat
// kasih durasi sesuai paket yang dibeli user (7/30/90/dst hari), bukan cuma
// default 3 bulan. Kosongkan/undefined buat perilaku lama (dipakai /setrole).
function setRole(username, role, displayName, customDurationMs) {
  if (!username || !VALID_ROLES.includes(role)) return false;
  const roles = readRoles();
  const u = username.trim().toLowerCase();
  if (role === 'member' && !displayName) {
    delete roles[u];
  } else {
    roles[u] = {
      role,
      displayName: displayName ? displayName.trim() : (roles[u]?.displayName || null),
      // VIP/VVIP dikasih masa berlaku dari SEKARANG tiap kali di-set ulang
      // (termasuk perpanjang). Role lain gak ada expiry.
      expiresAt: (role === 'vvip' || role === 'vip') ? (Date.now() + (customDurationMs || VVIP_DURATION_MS)) : null,
      // Nomor WA lama (legacy, dari sebelum fitur nomor WA dihapus) tetap
      // dipertahankan walau role di-update ulang -- cuma dipakai /boardcastwa.
      // Pengiriman ID privat GAK lagi pakai nomor ini.
      waNumber: roles[u]?.waNumber || null
    };
  }
  saveRoles(roles);
  return true;
}

// Nomor WA pribadi (LEGACY) -- dulu dipakai buat DM "judul+ID" ke VVIP, sekarang
// pengiriman ID privat VIP/VVIP cuma lewat halaman "ID Saya" (lib/privateInbox.js).
// Nomor lama yang masih tersimpan cuma dibaca oleh /boardcastwa.
function getWaNumber(username) {
  if (!username) return null;
  const u = username.trim().toLowerCase();
  const roles = readRoles();
  return roles[u]?.waNumber || null;
}

function setWaNumber(username, number) {
  if (!username) return false;
  const roles = readRoles();
  const u = username.trim().toLowerCase();
  if (!roles[u]) return false; // harus udah punya role (minimal vvip) dulu
  const clean = String(number || '').replace(/[^0-9]/g, '') || null;
  roles[u].waNumber = clean;
  saveRoles(roles);
  return true;
}

function listRoles() {
  const roles = readRoles();
  let changed = false;
  const out = {};
  for (const [u, v] of Object.entries(roles)) {
    if ((v.role === 'vvip' || v.role === 'vip') && v.expiresAt && Date.now() > v.expiresAt) {
      delete roles[u];
      changed = true;
      continue;
    }
    out[u] = v.role;
  }
  if (changed) saveRoles(roles);
  for (const u of DEFAULT_OWNERS) out[u] = 'dev';
  return out;
}

// admin, owner, dev = full akses TOTAL: bypass limit, ban, sesi tertutup,
// app off/maintenance. VIP/VVIP TIDAK termasuk sini -- vvip punya jalur bypass
// sendiri yang lebih terbatas (lihat canBypassSessionGate/canBypassAppMode),
// TETAP kena limit personal (10/5) & ban sendiri.
function isFullAccessRole(username) {
  const r = getRole(username);
  return r === 'admin' || r === 'owner' || r === 'dev';
}

function isVvip(username) {
  return getRole(username) === 'vvip';
}

// VIP ATAU VVIP (dua-duanya "premium", beda cuma limit & harga) -- dipakai
// buat privilege yang SAMA-SAMA didapat kedua tier: bebas sesi tertutup,
// bebas app off, dapet kirim hasil privat (bukan ke Page publik). Mode
// MAINTENANCE tetap berlaku juga buat VIP/VVIP -- yang masih bisa mereka buka
// cuma halaman "ID Saya" (lihat canBypassAppMode).
function isPremium(username) {
  const r = getRole(username);
  return r === 'vip' || r === 'vvip';
}

// "Bebas global limit" buat VIP/VVIP: boleh tetep request walau sesi/kuota
// global lagi ditutup (reqStat.enabled === false). Limit PERSONAL masing-
// masing tier tetap berlaku.
function canBypassSessionGate(username) {
  return isFullAccessRole(username) || isPremium(username);
}

// Siapa yang BEBAS dari mode app non-online:
//   - admin/owner/dev: bebas semuanya (off & maintenance).
//   - VIP/VVIP: bebas mode OFF, tapi TIDAK bebas MAINTENANCE -- maintenance
//     berdampak ke SEMUA user termasuk VIP/VVIP. Satu-satunya yang tetap boleh
//     mereka akses saat maintenance adalah halaman "ID Saya" (endpoint
//     /api/my-private-ids* & /api/mobile/my-private-ids* memang gak di-gate mode app).
// `mode` = appStatus.mode saat ini ('online' | 'offline' | 'maintenance'); kalau
// gak dikirim, dianggap bukan maintenance (perilaku lama).
function canBypassAppMode(username, mode = null) {
  if (isFullAccessRole(username)) return true;
  if (mode === 'maintenance') return false;
  return isPremium(username);
}

// Limit HARIAN sesuai role user yang sebenarnya (vip dapet angka vip,
// vvip dapet angka vvip) -- dipakai di tempat yang butuh tau limit MILIK
// USER tertentu (bukan cuma "berapa limit vvip secara umum").
function roleLimit(username, type) {
  const r = getRole(username);
  return ROLE_LIMITS[r]?.[type] || 0;
}

// Alias lama (limit VVIP generik, gak peduli user-nya) -- dipertahankan
// buat kompatibilitas kode lain yang mungkin masih manggil kayak gini.
function vvipLimit(type) {
  return ROLE_LIMITS.vvip[type] || 0;
}

// Titel + emoji yang tampil di bawah nama user (app) & di belakang nama di
// tiket (admin). Beda gaya per role biar gampang dibedain sekilas.
const ROLE_TITLES = {
  owner: '👑 owner',
  dev  : '🧑\u200d💻 dev',
  admin: '🛡️ admin',
  vvip : '🌟 vvip',
  vip  : '💎 vip',
};

function roleTitle(username) {
  const r = getRole(username);
  return ROLE_TITLES[r] || null; // null buat 'member' -- gak ada titel tambahan
}

module.exports = {
  parseDurationTokens, VALID_ROLES, VVIP_LIMITS, ROLE_LIMITS, VVIP_RESET_MS, VVIP_DURATION_MS, ROLE_TITLES, DEFAULT_OWNERS, DEFAULT_DISPLAY_NAMES,
  USER_DB_DIR, ROLES_FILE,
  getRole, setRole, listRoles, getDisplayName, getVvipDaysLeft, getRoleExpiryMs,
  isFullAccessRole, isVvip, isPremium, canBypassSessionGate, canBypassAppMode, vvipLimit, roleLimit, roleTitle,
  getWaNumber, setWaNumber,
};
