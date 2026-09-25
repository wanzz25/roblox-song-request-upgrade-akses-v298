// ╔═══════════════════════════════════════════════════════════╗
// ║   Data Paths — SEMUA file data ada di folder database/      ║
// ║                                                           ║
// ║   Dulu file data tersebar: logs.json, tickets.json, admins.  ║
// ║   json, dst di folder utama, api/database.json (akun user)   ║
// ║   di folder api/, plus folder database/. Ribet: waktu ganti   ║
// ║   file/update, ada yang ketimpa/ketinggalan.                 ║
// ║                                                           ║
// ║   SEKARANG: satu-satunya tempat data = folder database/.      ║
// ║   Ganti/tempel folder database/ (mis. dari backup) = semua    ║
// ║   data ikut kembali. Kode lain cukup pakai dataFile('nama').  ║
// ║                                                           ║
// ║   MIGRASI OTOMATIS: pas server nyala, file lama di lokasi     ║
// ║   lama (folder utama / api/) dipindah ke database/ kalau      ║
// ║   file tujuannya belum ada. Kalau sudah ada (mis. dari        ║
// ║   backup), yang di database/ yang dipakai & file lama         ║
// ║   dibiarkan (gak ditimpa, gak dihapus).                       ║
// ╚═══════════════════════════════════════════════════════════╝

const fs   = require('fs');
const path = require('path');

const ROOT     = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'database');

// Path absolut file data di dalam database/ (folder induknya dibuatkan kalau belum ada).
// Contoh: dataFile('logs.json'), dataFile('api/database.json')
function dataFile(rel) {
  const p = path.join(DATA_DIR, rel);
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
  return p;
}

// File data yang dulu ada di FOLDER UTAMA project (sekarang di database/).
const LEGACY_ROOT_FILES = [
  'app_status.json', 'logs.json', 'tickets.json', 'banlist.json', 'announce.json',
  'chat_mode.json', 'req_status.json', 'admins.json', 'claims.json', 'pins.json',
  'audit.json', 'group_override.json', 'queue_config.json',
  'song_schedule.json', 'song_session.json', 'schedule.json',
  'roblox_audio_history.json', 'roblox_audio_pending.json', 'roblox_perm_variant.json',
  'roblox_upload_jobs.json',
  'rate_limits.json', 'limit_bonus.json', 'duration_violations.json', 'limits_config.json',
  'mobile_tokens.json',
];
// File data yang dulu ada di folder api/ (akun user web/APK + sesi login).
const LEGACY_API_FILES = ['database.json', 'keyList.json'];

function moveFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.renameSync(src, dest); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;            // beda volume: salin lalu hapus
    fs.copyFileSync(src, dest); fs.unlinkSync(src);
  }
}

// Jalan SEKALI saat modul ini pertama di-require (sebelum modul data mana pun membaca file).
function migrateLegacyDataFiles() {
  const pairs = [
    ...LEGACY_ROOT_FILES.map(f => [path.join(ROOT, f), path.join(DATA_DIR, f), f]),
    ...LEGACY_API_FILES.map(f => [path.join(ROOT, 'api', f), path.join(DATA_DIR, 'api', f), `api/${f}`]),
  ];
  const moved = [], kept = [];
  for (const [src, dest, label] of pairs) {
    try {
      if (!fs.existsSync(src)) continue;
      if (fs.existsSync(dest)) { kept.push(label); continue; }   // yang di database/ menang
      moveFile(src, dest); moved.push(label);
    } catch (e) { console.error(`[dataPaths] Gagal memindahkan ${label}:`, e.message); }
  }
  if (moved.length) console.log(`[dataPaths] ${moved.length} file data dipindah ke database/: ${moved.join(', ')}`);
  if (kept.length)  console.log(`[dataPaths] ${kept.length} file lama di lokasi lama DIBIARKAN (sudah ada versi di database/ yang dipakai): ${kept.join(', ')}`);
  return { moved, kept };
}

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const MIGRATION = migrateLegacyDataFiles();

module.exports = { DATA_DIR, dataFile, migrateLegacyDataFiles, MIGRATION, LEGACY_ROOT_FILES, LEGACY_API_FILES };
