// ╔═══════════════════════════════════════════════════════════╗
// ║   Private Inbox — "ID Saya" khusus VIP/VVIP                 ║
// ║   Nyimpen ID (lagu/banner/video) yang sudah di-ACC khusus   ║
// ║   buat user VIP/VVIP -- ditampilin di halaman "ID Saya"     ║
// ║   (web/app). Ini SATU-SATUNYA jalur ID privat VIP/VVIP:     ║
// ║   gak dikirim ke saluran WA maupun DM WA pribadi lagi.      ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ╚═══════════════════════════════════════════════════════════╝

const fs   = require('fs');
const path = require('path');

const ROOT       = path.join(__dirname, '..');
// Data "ID Saya" punya FOLDER SENDIRI: database/idsaya/ -- sengaja dipisah dari
// database/user/ (titel.json = data role). Folder database/user/ sering
// ditimpa/di-restore dari backup lama pas ganti file/update, jadi kalau ID Saya
// numpang di situ, ID milik VIP/VVIP ikut ilang/kembali ke versi lama.
// Folder ini ikut ke-zip di /backupdb (lihat lib/dbBackup.js).
const INBOX_DIR  = path.join(ROOT, 'database', 'idsaya');
const INBOX_FILE = path.join(INBOX_DIR, 'privateIds.json');
// Lokasi LAMA (sebelum v20) -- dimigrasi otomatis, lihat migrateLegacyInbox().
const LEGACY_INBOX_FILE = path.join(ROOT, 'database', 'user', 'privateIds.json');

// Batas jumlah entri disimpan per user -- biar file gak numpuk gak jelas
// buat user yang udah lama jadi VIP/VVIP & banyak request.
const MAX_ENTRIES_PER_USER = 500;

function ensureInboxDir() {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
}

// Cache "data terakhir yang valid di memori" -- pola sama kayak lib/roles.js,
// biar gak ilang data pas kebetulan lagi ke-baca di tengah proses tulis
// (setengah ke-tulis / disk hiccup).
let cachedInbox = null;

function readInbox() {
  try {
    const parsed = JSON.parse(fs.readFileSync(INBOX_FILE, 'utf8'));
    cachedInbox = parsed;
    return parsed;
  } catch (e) {
    if (!fs.existsSync(INBOX_FILE)) return cachedInbox || {};
    console.error('[privateInbox] Gagal baca privateIds.json (mungkin lagi ditulis/korup):', e.message);
    return cachedInbox || {};
  }
}

function saveInbox(data) {
  ensureInboxDir();
  // Tulis atomik: ke .tmp dulu baru rename, biar gak pernah kebaca dalam
  // kondisi setengah tertulis kalau proses mati di tengah jalan.
  const tmpFile = INBOX_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, INBOX_FILE);
  cachedInbox = data;
}

// Migrasi otomatis dari lokasi lama (database/user/privateIds.json) ke
// database/idsaya/privateIds.json -- jalan sekali tiap server nyala (murah kalau
// file lama udah gak ada). Aman dari kehilangan data:
//   - file baru belum ada  -> file lama dipindah apa adanya
//   - dua-duanya ada (mis. restore backup lama nyalin file lama balik) -> digabung
//     per user tanpa duplikat, file baru gak pernah ditimpa mentah-mentah
//   - file baru korup -> berhenti, file lama TIDAK disentuh
// File lama akhirnya di-rename jadi privateIds.json.migrated (bukan dihapus).
function migrateLegacyInbox() {
  try {
    if (!fs.existsSync(LEGACY_INBOX_FILE)) return;
    const legacy = JSON.parse(fs.readFileSync(LEGACY_INBOX_FILE, 'utf8'));

    let current = {};
    if (fs.existsSync(INBOX_FILE)) {
      try { current = JSON.parse(fs.readFileSync(INBOX_FILE, 'utf8')); }
      catch (e) { console.error('[privateInbox] File baru korup, migrasi ditunda:', e.message); return; }
    }

    const keyOf = (e) => `${e.requestId || ''}|${e.id || ''}|${e.time || ''}`;
    let moved = 0;
    for (const [u, list] of Object.entries(legacy || {})) {
      if (!Array.isArray(list)) continue;
      const have = Array.isArray(current[u]) ? current[u] : [];
      const seen = new Set(have.map(keyOf));
      const extra = list.filter((e) => !seen.has(keyOf(e)));
      moved += extra.length;
      current[u] = have.concat(extra)
        .sort((a, b) => (b.time || 0) - (a.time || 0))
        .slice(0, MAX_ENTRIES_PER_USER);
    }

    saveInbox(current);
    fs.renameSync(LEGACY_INBOX_FILE, LEGACY_INBOX_FILE + '.migrated');
    console.log(`[privateInbox] ID Saya dimigrasi ke database/idsaya/ (${moved} entri dari lokasi lama)`);
  } catch (e) {
    console.error('[privateInbox] Migrasi ID Saya gagal (data lama tetap aman di tempatnya):', e.message);
  }
}
migrateLegacyInbox();

// Tambah 1 entri ID baru buat username tertentu -- dipanggil pas request
// VIP/VVIP di-ACC (gantinya kirim ke saluran WA publik).
//   entry.id        : ID asset utama (Roblox)
//   entry.ids       : (opsional) daftar SEMUA ID -- khusus Video Tron yang
//                      hasilnya banyak klip sekaligus
//   entry.title     : judul lagu/banner/video
//   entry.type      : 'song' | 'banner' | 'video'
//   entry.requestId : ID request internal (buat referensi silang)
function addPrivateId(username, entry) {
  if (!username) return;
  const u = username.trim().toLowerCase();
  const data = readInbox();
  if (!Array.isArray(data[u])) data[u] = [];
  data[u].unshift({
    id       : entry.id != null ? String(entry.id) : null,
    ids      : Array.isArray(entry.ids) ? entry.ids.map(String) : null,
    title    : entry.title || '-',
    type     : entry.type || 'song',
    requestId: entry.requestId || null,
    time     : Date.now(),
    seen     : false, // dipakai buat notifikasi "ID baru" di web/app
  });
  if (data[u].length > MAX_ENTRIES_PER_USER) data[u] = data[u].slice(0, MAX_ENTRIES_PER_USER);
  saveInbox(data);
}

function getPrivateIds(username) {
  if (!username) return [];
  const u = username.trim().toLowerCase();
  const data = readInbox();
  return data[u] || [];
}

// Tandai semua entri sebagai "sudah dilihat" -- dipanggil pas user buka tab
// "ID Saya", biar badge notifikasi gak nyala terus tiap kali polling.
function markAllSeen(username) {
  if (!username) return;
  const u = username.trim().toLowerCase();
  const data = readInbox();
  if (!Array.isArray(data[u]) || !data[u].length) return;
  let changed = false;
  for (const e of data[u]) { if (!e.seen) { e.seen = true; changed = true; } }
  if (changed) saveInbox(data);
}

function countUnseen(username) {
  return getPrivateIds(username).filter((e) => !e.seen).length;
}

// Format .txt polos buat di-download -- 1 baris per entri, ID mentah (video
// dgn banyak klip dipisah koma) biar gampang di-copy-paste ke script Roblox.
function formatPrivateIdsAsTxt(username) {
  const list = getPrivateIds(username);
  if (!list.length) return 'Belum ada ID request yang masuk.';
  return list.map((e) => {
    const idPart = e.ids && e.ids.length ? e.ids.join(',') : (e.id || '-');
    const tanggal = new Date(e.time).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const tipe = e.type === 'banner' ? 'Banner' : e.type === 'video' ? 'Video' : 'Lagu';
    return `[${tanggal}] (${tipe}) ${e.title} -> ${idPart}`;
  }).join('\n');
}

module.exports = {
  INBOX_DIR, INBOX_FILE, migrateLegacyInbox,
  addPrivateId, getPrivateIds, markAllSeen, countUnseen, formatPrivateIdsAsTxt,
};
