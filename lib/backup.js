// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Backup — Auto-backup Berkala (zip seluruh database)  ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝

const fs   = require('fs');
const path = require('path');
const { createDbBackup, BACKUPS_DIR } = require('./dbBackup');
const { BACKUP_DIR, BACKUP_INTERVAL_MS, BACKUP_INITIAL_DELAY_MS } = require('../backup-config');

// PERUBAHAN: auto-backup SEKARANG SAMA dengan /backupdb -- bukan lagi
// snapshot JSON (backup_*.json), tapi zip berisi SELURUH folder database/
// -- semua data aplikasi (user, idsaya, vvip, api, logs.json, tickets.json,
// dst) sekarang ada di sana. Zip-nya dikirim ke chat Owner di Telegram, dan 1
// salinan lokal disimpan di database/user/backups/ (dibatasi
// BACKUP_MAX_FILES). Detail isi & pengecualian: lib/dbBackup.js.
// BACKUP_DIR (folder backups/ lama) tidak dipakai lagi buat backup baru,
// cuma tetap dibaca /listbackup & /getbackup biar file snapshot lama masih bisa diambil.
async function runBackup(note = '⏰ Backup otomatis terjadwal') {
  try {
    const r = await createDbBackup({ note });
    if (r.sendError) console.error('[Backup] Gagal kirim ke Telegram, salinan lokal dipertahankan:', r.sendError.message);
    console.log(`[Backup] ${r.sent ? 'Terkirim ke Telegram' : 'GAGAL kirim ke Telegram -- disimpen lokal'}: ${r.fileName} (${r.files.length} file)`);
    return { file: r.localPath, sentToTelegram: r.sent, fileCount: r.files.length };
  } catch (e) {
    console.error('[Backup Error]', e.message);
    throw e;
  }
}

function msSinceLastBackup() {
  try {
    const all = fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.startsWith('database-') && f.endsWith('.zip'))
      .sort();
    if (!all.length) return Infinity;
    return Date.now() - fs.statSync(path.join(BACKUPS_DIR, all[all.length - 1])).mtimeMs;
  } catch {
    return Infinity;
  }
}

setInterval(() => runBackup().catch(() => {}), BACKUP_INTERVAL_MS);
setTimeout(() => {
  // Jangan bikin backup awal kalau backup terakhir masih baru (mis. server
  // baru aja auto-restart) -- cukup nunggu jadwal interval biasa, biar gak
  // spam kirim zip dobel ke Telegram tiap restart.
  if (msSinceLastBackup() < BACKUP_INTERVAL_MS / 2) {
    console.log('[Backup] Lewatin backup awal -- backup terakhir masih cukup baru (baru aja restart).');
    return;
  }
  runBackup().catch(() => {});
}, BACKUP_INITIAL_DELAY_MS);

module.exports = { runBackup, BACKUP_DIR, BACKUPS_DIR };
