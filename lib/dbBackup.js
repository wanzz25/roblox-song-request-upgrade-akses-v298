// ╔═══════════════════════════════════════════════════════════╗
// ║   DB Backup — zip SELURUH database/ + data aplikasi,       ║
// ║   simpen lokal + kirim ke Telegram.                        ║
// ║                                                           ║
// ║   Dipakai oleh:                                            ║
// ║     • /backupdb  (manual)                                  ║
// ║     • auto-backup terjadwal (lib/backup.js, tiap interval) ║
// ║     • auto-backup tiap ada perubahan user (/setrole dst)   ║
// ╚═══════════════════════════════════════════════════════════╝

const fs       = require('fs');
const path     = require('path');
const archiver = require('archiver');

const { USER_DB_DIR } = require('./roles');
const { sendDocument } = require('./telegram');
const { getTime } = require('./util');
const { BACKUP_MAX_FILES, BACKUP_EXCLUDE_FILES } = require('../backup-config');

const ROOT       = path.join(__dirname, '..');
const DB_DIR     = path.join(ROOT, 'database');
const BACKUPS_DIR = path.join(USER_DB_DIR, 'backups');

// Isi backup: SELURUH folder database/ TANPA TERKECUALI -- sekarang SEMUA data aplikasi
// ada di sana (user, idsaya, vvip, api/ [akun user & sesi login], logs.json, tickets.json,
// admins.json, rate_limits.json, roblox_audio_history.json, dst; lihat lib/dataPaths.js) dan
// folder apa pun yang ditambah nanti ikut otomatis. Yang dilewati cuma:
//   - folder salinan backup-nya sendiri (BACKUPS_DIR) -- biar gak zip di dalam zip
//   - file yang secara eksplisit dikecualikan lewat BACKUP_EXCLUDE_FILES di backup-config.js
//     (default: roblox_upload_jobs.json = antrean upload sementara; direstore malah bisa
//     upload dobel)
// Isi zip = folder database/ persis -> RESTORE = ekstrak zip ke folder utama project, atau
// cukup ganti folder database/ dengan folder database/ dari zip.
const BACKUP_EXCLUDE = new Set((BACKUP_EXCLUDE_FILES || []).map(f => String(f).replace(/\\/g, '/')));

function ensureDirs() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.mkdirSync(USER_DB_DIR, { recursive: true });
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

function walkFiles(dir, skipDir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (skipDir && path.resolve(full) === path.resolve(skipDir)) continue;
    if (ent.isDirectory()) out.push(...walkFiles(full, skipDir));
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

// Daftar file yang bakal masuk zip, sebagai [{ abs, rel }] (rel = path di
// dalam zip, pakai "/" biar sama di semua OS).
function collectBackupFiles() {
  const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
  const files = [];
  for (const abs of walkFiles(DB_DIR, BACKUPS_DIR)) {
    const r = rel(abs);                                   // mis. database/logs.json
    if (r.endsWith('.tmp')) continue;                     // sisa tulis-atomik yang belum selesai
    if (BACKUP_EXCLUDE.has(r.slice('database/'.length))) continue;
    files.push({ abs, rel: r });
  }
  return files;
}

// Ringkasan singkat isi zip buat caption Telegram (batas caption 1024 karakter,
// jadi dikelompokin per folder, bukan daftar semua file).
function summarizeFiles(files) {
  const groups = {};
  const top = [];
  for (const f of files) {
    const parts = f.rel.split('/');            // ['database', ..., nama]
    if (parts.length === 2) { top.push(parts[1]); continue; }
    const g = `${parts[0]}/${parts[1]}`;
    groups[g] = (groups[g] || 0) + 1;
  }
  const lines = Object.entries(groups).sort().map(([g, n]) => `• <code>${g}/</code> — ${n} file`);
  if (top.length) {
    let names = top.sort().join(', ');
    if (names.length > 300) names = names.slice(0, 297) + '...';
    lines.push(`• <code>database/</code> — ${top.length} file: ${names}`);
  }
  return lines.join('\n');
}

// Ringkasan isi data penting buat caption: jumlah role tersimpan (VVIP + VIP + staff) & order pembelian
// per tier -- supaya jelas bahwa VIP ikut ke-backup (bukan cuma VVIP).
function dataStats() {
  const out = { roles: {}, orders: {} };
  try {
    const t = JSON.parse(fs.readFileSync(path.join(USER_DB_DIR, 'titel.json'), 'utf8'));
    for (const v of Object.values(t)) out.roles[v.role || 'member'] = (out.roles[v.role || 'member'] || 0) + 1;
  } catch {}
  try {
    const o = JSON.parse(fs.readFileSync(path.join(DB_DIR, 'vvip', 'orders.json'), 'utf8'));
    for (const x of o) { const k = String(x.tier || 'vvip').toUpperCase(); out.orders[k] = (out.orders[k] || 0) + 1; }
  } catch {}
  return out;
}
function statsLine(st) {
  const order = ['vvip', 'vip', 'admin', 'owner', 'dev', 'member'];
  const names = { vvip: 'VVIP', vip: 'VIP', admin: 'admin', owner: 'owner', dev: 'dev', member: 'member' };
  const r = order.filter(k => st.roles[k]).map(k => `${st.roles[k]} ${names[k]}`).join(' · ');
  const o = Object.entries(st.orders).map(([k, n]) => `${n} ${k}`).join(' · ');
  return (r ? `👥 Role tersimpan: ${r}\n` : '') + (o ? `🧾 Order pembelian: ${o} (VIP + VVIP)\n` : '');
}

// Hapus salinan lokal paling lama kalau lebih dari BACKUP_MAX_FILES
// (auto-backup tiap jam bakal nge-numpuk kalau gak dibatasi).
function pruneLocalBackups() {
  try {
    const all = fs.readdirSync(BACKUPS_DIR).filter(f => f.startsWith('database-') && f.endsWith('.zip')).sort();
    if (all.length > BACKUP_MAX_FILES) {
      all.slice(0, all.length - BACKUP_MAX_FILES).forEach(f => { try { fs.unlinkSync(path.join(BACKUPS_DIR, f)); } catch {} });
    }
  } catch {}
}

// Bikin zip yang STRUKTUR FOLDERNYA DIPERTAHANKAN persis kayak aslinya
// (database/user/titel.json, database/idsaya/privateIds.json, logs.json, dst),
// simpen 1 salinan di database/user/backups/, DAN kirim ke Telegram. Restore =
// ekstrak zip-nya ke folder utama project.
// Balikin { localPath, fileName, files, sent, sendError } -- gak nge-throw kalau
// cuma gagal kirim (salinan lokal tetap ada); yang gagal bikin zip tetap throw.
async function createDbBackup({ note = null, sendToTelegram = true } = {}) {
  ensureDirs();

  const ts        = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName  = `database-${ts}.zip`;
  const localPath = path.join(BACKUPS_DIR, fileName);
  const files     = collectBackupFiles();

  await new Promise((resolve, reject) => {
    const output  = fs.createWriteStream(localPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    for (const f of files) archive.file(f.abs, { name: f.rel });
    archive.finalize();
  });

  pruneLocalBackups();

  let sent = false, sendError = null;
  if (sendToTelegram) {
    try {
      // Batas caption Telegram = 1024 karakter: bagian tetap dihitung dulu, daftar folder dipotong per BARIS
      // (bukan di tengah tag HTML) kalau kepanjangan.
      const head = `📦 <b>Backup database</b> (seluruh folder database)\n\n` + (note ? `${note}\n\n` : '') + statsLine(dataStats()) + `📁 Total <b>${files.length}</b> file:\n`;
      const tail = `\n\n💾 Salinan lokal: <code>database/user/backups/${fileName}</code>\n♻️ Restore: ekstrak zip ke folder utama project (atau ganti folder database/ dgn isi zip)\n🕐 ${getTime()}`;
      let listing = '';
      for (const line of summarizeFiles(files).split('\n')) {
        if ((head + listing + line + '\n…' + tail).length > 1000) { listing += '…'; break; }
        listing += (listing ? '\n' : '') + line;
      }
      await sendDocument(localPath, head + listing + tail, null, fileName);
      sent = true;
    } catch (e) { sendError = e; }
  }

  return { localPath, fileName, files, sent, sendError };
}

// Versi lama (dipakai /backupdb): balikin path, dan throw kalau gagal kirim.
async function backupUserDb(opts = {}) {
  const r = await createDbBackup(opts);
  if (r.sendError) throw r.sendError;
  return r.localPath;
}

// Auto-backup tiap ada penambahan/perubahan user (dipanggil abis setRole()
// berhasil). Gak nge-throw kalau gagal, biar command utama (/setrole) tetep
// sukses walau backup-nya gagal karena alasan apapun.
async function autoBackupOnUserChange(note) {
  try {
    await backupUserDb({ note: `🔔 Auto-backup: ${note}` });
  } catch (e) {
    console.error('[autoBackupOnUserChange]', e.message);
  }
}

module.exports = { createDbBackup, backupUserDb, autoBackupOnUserChange, collectBackupFiles, BACKUPS_DIR, BACKUP_EXCLUDE };
