// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Roblox Request Panel — by wanz                     ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝

// Jaring pengaman: kalau ada error async yang gak ketangkep try-catch di
// manapun (misal dari proses koneksi WhatsApp), JANGAN biarkan itu mematikan
// seluruh server. Cukup di-log, server & bot Telegram tetap jalan.
process.on('unhandledRejection', (reason) => {
  console.error('  [unhandledRejection]', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('  [uncaughtException]', err.stack || err);
});

const CFG     = require('./config');
const express = require('express');
const path    = require('path');

const apiRoutes       = require('./routes/api');
const apiMobileRoutes = require('./routes/api-mobile');
const apiVvipRoutes   = require('./routes/vvip');
const apiRouter        = require('./api/router');
const { pollTelegram } = require('./bot/poller');
const { startScheduler } = require('./lib/scheduler');
const { startUploadsSweeper } = require('./lib/uploads');
const { startTempSweeper, setNoSpaceNotifier } = require('./lib/tempdir');
const { sendMessage: tgSendOwner } = require('./lib/telegram');
const { startSongScheduler } = require('./lib/songSchedule');
const { initWhatsApp, closeWhatsApp } = require('./lib/whatsapp');

// Graceful shutdown -- dipanggil Pterodactyl tiap kali admin klik
// restart/stop manual di panel (bukan cuma restart terjadwal kita sendiri).
// Tutup sesi WA RAPI dulu sebelum proses beneran mati, biar file sesinya
// gak kepotong nulis di tengah jalan.
let shuttingDown = false;
process.on('SIGTERM', async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('  [Shutdown] SIGTERM diterima, menutup sesi WhatsApp dengan rapi...');
  await closeWhatsApp().catch(() => {});
  process.exit(0);
});
const { resetAllRates } = require('./lib/ratelimit');
const { sendMessage } = require('./lib/telegram');
const { resumePendingChecks } = require('./bot/robloxAudio');
const { resumeRequestPendingChecks, resumeUploadJobs } = require('./bot/robloxAudioRequest');

const app  = express();
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-mobile-key, x-admin-key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Webhook VVIP (BuatQris) butuh BODY MENTAH buat verifikasi tanda tangan HMAC
// -- harus dipasang SEBELUM express.json() global di bawah. body-parser lain
// otomatis skip path ini karena body udah "ke-mark" terparse (lihat
// routes/vvip.js untuk verifikasinya).
app.use('/api/vvip/webhook', express.raw({ type: '*/*' }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/', apiRoutes);
app.use('/', apiMobileRoutes);
app.use('/', apiVvipRoutes);
app.use('/mobile-api', apiRouter);

app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  [wanz] Roblox Request Panel');
  console.log('  ─────────────────────────────────────────');
  console.log(`  Akses : http://${CFG.WEB_DOMAIN}:${PORT}`);
  console.log(`  Logs  : http://${CFG.WEB_DOMAIN}:${PORT}/logs.html`);
  console.log(`  APK   : http://${CFG.WEB_DOMAIN}:${PORT}/mobile-api`);
  console.log('  ─────────────────────────────────────────');
  if (!CFG.TELEGRAM_BOT_TOKEN || CFG.TELEGRAM_BOT_TOKEN === 'isi_token_bot_kamu_disini')
    console.warn('  PERINGATAN: TELEGRAM_BOT_TOKEN belum diatur di config.js');
  if (!CFG.TELEGRAM_CHAT_ID || CFG.TELEGRAM_CHAT_ID === 'isi_chat_id_kamu_disini')
    console.warn('  PERINGATAN: TELEGRAM_CHAT_ID belum diatur di config.js');
  console.log('');

  // Setiap kali server nyala (restart manual, crash-recovery, ATAU update/deploy),
  // reset limit personal SEMUA user (lagu & banner). Sebelumnya limit cuma reset
  // saat sesi request dibuka ulang, jadi user yang udah kena limit sebelum restart
  // tetap ketahan meski quota global masih longgar -> bikin banyak tiket bingung
  // ("masih 18/25 kok gak bisa request"). Sekarang restart/update selalu ngasih
  // jatah limit personal yang fresh ke semua orang.
  resetAllRates();
  console.log('  [RateLimit] Limit personal semua user direset otomatis (server baru nyala)');
  sendMessage(
    '🔄 <b>Server baru saja restart/update.</b>\n\n' +
    'Limit request personal (lagu &amp; banner) untuk <b>semua user</b> sudah direset otomatis. ' +
    'Kalau ada user lapor kena limit sebelum ini, minta mereka coba request lagi.'
  ).catch(() => {});

  pollTelegram();
  startScheduler();
  apiVvipRoutes.startOrderReconciler();   // cek ulang order VIP/VVIP yang belum tercatat lunas (jaring pengaman pembayaran)
  startUploadsSweeper();
  setNoSpaceNotifier((text) => tgSendOwner(text));   // alarm penyimpanan penuh -> chat Owner
  startTempSweeper();
  startSongScheduler();
  initWhatsApp().catch(e => console.warn('[WhatsApp init]', e.message));
  resumePendingChecks();
  resumeRequestPendingChecks();
  resumeUploadJobs();

  // Auto-restart tiap hari jam 00:00 Asia/Jakarta -- biar memori server gak
  // numpuk lama-lama, tapi cuma sekali sehari (bukan tiap jam).
  // Proses cuma exit(0) di sini; Pterodactyl yang otomatis nyalain ulang
  // (asalkan restart-on-exit di panel nyala, yang emang defaultnya begitu).
  // CATATAN: upload dari kartu request (audio/banner/video) TAHAN RESTART --
  // tiap upload dicatat sebagai job di roblox_upload_jobs.json dan dilanjutin
  // otomatis dari titik terakhir (resumeUploadJobs di atas): yang masih
  // antre/download/upload diulang, asset yang udah sempat dibuat di Roblox
  // GAK diupload ulang, video lanjut dari klip terakhir yang terupload, dan
  // yang lagi nunggu moderasi tetap dipantau (resumeRequestPendingChecks).
  // Jam 00:00 WIB dipilih karena biasanya jam paling sepi trafik.
  //
  // Dihitung ulang dari waktu SEKARANG tiap kali server ini nyala (bukan
  // interval tetap dari start) -- jadi walau server sempat direstart manual
  // di tengah hari, jadwalnya tetap balik pas ke jam 00:00 WIB berikutnya,
  // gak geser/nge-drift.
  function msUntilNextJakartaMidnight() {
    const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000; // WIB = UTC+7, gak ada DST
    const now = new Date();
    const jakartaNow = new Date(now.getTime() + JAKARTA_OFFSET_MS);
    const nextJakartaMidnightAsUtc = Date.UTC(
      jakartaNow.getUTCFullYear(), jakartaNow.getUTCMonth(), jakartaNow.getUTCDate() + 1, 0, 0, 0, 0
    );
    return (nextJakartaMidnightAsUtc - JAKARTA_OFFSET_MS) - now.getTime();
  }

  const msUntilRestart = msUntilNextJakartaMidnight();
  console.log(`  [AutoRestart] Restart terjadwal berikutnya dalam ${Math.round(msUntilRestart / 60000)} menit (jam 00:00 WIB).`);
  setTimeout(() => {
    console.log('  [AutoRestart] Waktunya restart terjadwal (00:00 WIB)...');
    sendMessage('🔄 Auto-restart terjadwal harian (00:00 WIB) buat jaga performa & memori server. Bakal nyala lagi dalam beberapa detik.').catch(() => {});
    setTimeout(async () => {
      await closeWhatsApp().catch(() => {}); // tutup sesi WA RAPI dulu, baru exit
      process.exit(0);
    }, 3000); // jeda dikit biar notifnya sempet kekirim
  }, msUntilRestart);
});
