// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Roblox Song Request — Konfigurasi Backup            ║
// ║                                                           ║
// ║   File ini KHUSUS untuk pengaturan lokasi & jadwal backup. ║
// ║   Dipisah dari lib/backup.js supaya kalau mau pindahin     ║
// ║   folder backup ke disk lain, ganti jadwal, atau ubah      ║
// ║   batas maksimal file, tinggal edit di sini saja — tanpa   ║
// ║   perlu buka-buka kode logic backup-nya.                   ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝

const path = require('path');

const ROOT = path.join(__dirname);

module.exports = {

  // ── Lokasi folder backup LAMA ────────────────────────────────────────────
  // CATATAN: auto-backup sekarang berupa zip seluruh database (sama kayak
  // /backupdb) yang disimpen di database/user/backups/ -- BUKAN di folder ini
  // lagi. BACKUP_DIR cuma dipakai /listbackup & /getbackup buat baca file
  // snapshot lama (backup_*.json) yang mungkin masih ada.
  // Default: folder "backups" di root project (sejajar dengan server.js).
  // Bisa diganti ke path absolut lain, contoh:
  //   BACKUP_DIR: '/home/container/storage/backups'
  BACKUP_DIR: path.join(ROOT, 'backups'),

  // ── Jadwal auto-backup ───────────────────────────────────────────────────
  // Interval rutin (ms) — tiap 1 jam (sebelumnya 30 menit, kelamaan jadi
  // numpuk banyak file kalau digabung sama restart harian).
  BACKUP_INTERVAL_MS: 60 * 60 * 1000,

  // Delay sebelum backup pertama kali jalan setelah server start (ms).
  BACKUP_INITIAL_DELAY_MS: 2 * 60 * 1000,

  // ── File yang DIKECUALIKAN dari zip backup (relatif terhadap folder database/) ────
  // Default: cuma antrean upload sementara. Isi juga kalau mau file sensitif TIDAK ikut
  // terkirim ke Telegram, mis. ['roblox_upload_jobs.json', 'mobile_tokens.json', 'api/keyList.json']
  // (token login app & sesi login web) -- konsekuensinya: setelah restore, user perlu login ulang.
  BACKUP_EXCLUDE_FILES: ['roblox_upload_jobs.json'],

  // ── Retensi file backup ──────────────────────────────────────────────────
  // Jumlah maksimal salinan zip backup (database-*.zip) yang disimpan di
  // server; lebih dari ini, yang terlama otomatis dihapus. (Salinan yang
  // sudah terkirim ke Telegram tetap ada di sana.)
  BACKUP_MAX_FILES: 48,

};
