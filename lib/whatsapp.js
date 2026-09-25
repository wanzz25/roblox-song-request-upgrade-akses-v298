// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║   WhatsApp — Notifikasi Saluran (Channel)                    ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝
//
// Login WhatsApp CUMA lewat kode pairing (gak pakai QR sama sekali) —
// diminta lewat command Telegram: /addwa 62xxxxxxxxxx
//
// Kode diminta LANGSUNG pas socket pertama kali dibuat (sesuai cara resmi
// Baileys), bukan ditempel belakangan ke socket yang udah kadung jalan.
// Session tersimpan di folder wa_auth/ — sekali login, gak perlu ulang lagi
// selama folder itu gak dihapus / gak logout dari HP.
//
// Kalau butuh login ulang dari nol (ganti akun dsb): hapus folder wa_auth/
// lalu restart server, terus /addwa lagi.

const fs   = require('fs');
const path = require('path');

let makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers;
try {
  ({ default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys'));
} catch {
  // Dependency belum di-install (npm install belum dijalankan) — modul ini
  // akan no-op sampai dependency-nya ada, biar server tetap bisa jalan.
}

const { sendMessage } = require('./telegram');

const ROOT       = path.join(__dirname, '..');
const AUTH_DIR   = path.join(ROOT, 'wa_auth');
const CREDS_FILE = path.join(AUTH_DIR, 'creds.json');

// Baileys defaultnya pakai logger pino yang super detail (level info ke atas) --
// tiap koneksi/pre-key/query internal ke-log semua sebagai JSON mentah, bikin
// console keliatan "ngespam". Kita ganti pakai logger BISU biar rapi: status
// penting (connect/disconnect/error asli) tetap kita log manual sendiri lewat
// console.log/console.warn di bawah, cuma noise internal Baileys-nya yang dibungkam.
const silentLogger = (() => {
  const noop = () => {};
  const base = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, level: 'silent' };
  base.child = () => base;
  return base;
})();

// Saluran (Channel) WhatsApp tujuan notifikasi "sudah bisa req" & "req penuh".
const CHANNEL_JID  = '120363432111846477@newsletter';
const CHANNEL_LINK = 'https://whatsapp.com/channel/0029Vb9EjSgGehEFaFM5M43s';

let sock = null;
let credsSaveInFlight = null; // guard: jangan sampe proses exit pas lagi nulis file sesi
let isReady = false;

// Baca langsung dari file creds — paling akurat, gak tergantung state modul.
function isRegistered() {
  try {
    return !!JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')).registered;
  } catch {
    return false;
  }
}

function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

const PAIRING_WINDOW_MS = 5 * 60 * 1000; // jendela waktu pairing tetap dicoba nyambung ulang
let pairingInProgress = false;
let pairingStartedAt  = null;
let pairingPhone      = null;

// ── Reconnect dengan exponential backoff ─────────────────────────────────
// Sebelumnya reconnect selalu fixed 5 detik SETIAP kali putus, tanpa batas.
// Kalau koneksi lagi goyang (network jelek / lagi di-throttle WA), ini bisa
// nembak reconnect puluhan kali per menit terus-terusan -- yang justru bikin
// WA makin curiga & MEMPERBURUK pembatasan akun (bukan bikin "makin kuat").
// Sekarang delay-nya naik bertahap tiap gagal beruntun (5s → 10s → 20s ...
// max 60s), dan balik ke 5s lagi begitu berhasil connect normal.
let reconnectAttempts = 0;
function nextReconnectDelayMs() {
  const base = 5000 * Math.pow(2, reconnectAttempts);
  const capped = Math.min(base, 60000);
  reconnectAttempts++;
  // sedikit jitter biar gak nembak barengan persis tiap kelipatan detik
  return capped + Math.floor(Math.random() * 1000);
}

async function clearAuthDir() {
  try {
    await fs.promises.rm(AUTH_DIR, { recursive: true, force: true });
  } catch (e) {
    console.warn('  [WhatsApp] Gagal hapus wa_auth/ otomatis:', e.message);
  }
}

// ── Watchdog: deteksi koneksi "zombie" ───────────────────────────────────
// Diadaptasi dari pola yang sama dipakai bot WA lain (Wanzzai) -- tapi versi
// di sini disesuaikan: bot kita SEND-ONLY (kirim notifikasi ke Owner, gak
// pernah proses pesan MASUK dari customer), jadi gak bisa pakai patokan
// "udah berapa lama gak ada pesan masuk" kayak bot chat pada umumnya.
// Sebagai gantinya, watchdog ini AKTIF NANYA ke socket tiap beberapa menit
// (kirim presence update, hal paling ringan) -- kalau socket gak jawab
// dalam waktu wajar, itu tandanya koneksi diam-diam mati (WebSocket-nya
// kebuka tapi gak beneran nyambung ke server WA) TANPA sempat memicu event
// 'close' -- kasus yang gak ketangkep sama sekali sama reconnect logic yang
// nunggu event 'close'. Watchdog ini maksa tutup & reconnect kalau itu kejadian.
//
// FIX PENTING: sebelumnya SEKALI gagal jawab (>15 detik) langsung dianggap
// zombie & dipaksa reconnect. Ini ternyata jadi TEMBAK SENDIRI KAKI --
// jaringan server yang sesaat lambat/jitter (wajar di VPS kecil) bisa bikin
// 1 kali cek "telat" doang, PADAHAL koneksinya beneran masih sehat. Watchdog
// yang harusnya NYEGAH disconnect malah jadi PENYEBAB disconnect baru.
// Sekarang butuh GAGAL 2 KALI BERTURUT-TURUT (~10 menit gak respon total)
// baru dianggap beneran zombie, dan timeout per-cek dilonggarin ke 20 detik.
const WATCHDOG_INTERVAL_MS   = 5 * 60 * 1000;  // cek tiap 5 menit
const WATCHDOG_TIMEOUT_MS    = 20 * 1000;      // kasih waktu 20 detik buat "jawab"
const WATCHDOG_MAX_FAILS     = 2;              // baru dianggap zombie kalau gagal 2x BERTURUT-TURUT
let watchdogTimer = null;
let watchdogFailCount = 0;

function startWatchdog() {
  stopWatchdog();
  watchdogFailCount = 0;
  watchdogTimer = setInterval(async () => {
    if (!isReady || !sock) return;
    try {
      await Promise.race([
        sock.sendPresenceUpdate('available'),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`watchdog timeout ${WATCHDOG_TIMEOUT_MS / 1000}s`)), WATCHDOG_TIMEOUT_MS))
      ]);
      watchdogFailCount = 0; // sehat lagi -- reset hitungan gagal
    } catch (e) {
      watchdogFailCount++;
      console.warn(`  [WhatsApp] Watchdog: gak respon (percobaan gagal ke-${watchdogFailCount}/${WATCHDOG_MAX_FAILS}):`, e.message);
      if (watchdogFailCount < WATCHDOG_MAX_FAILS) return; // sekali gagal -- kasih kesempatan lagi, jangan langsung reconnect
      console.warn('  [WhatsApp] Watchdog: koneksi kelihatan BENERAN zombie (gagal beruntun), maksa reconnect...');
      isReady = false;
      watchdogFailCount = 0;
      try { sock.end(new Error('watchdog restart -- koneksi zombie')); } catch {}
      // .end() bakal mancing event 'connection.update' (close) sendiri,
      // yang otomatis nyambungin ulang lewat logic reconnect yang udah ada.
    }
  }, WATCHDOG_INTERVAL_MS);
  if (watchdogTimer.unref) watchdogTimer.unref(); // jangan sampe nahan proses exit
}

function stopWatchdog() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
}

function attachConnectionHandlers(s) {
  s.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      isReady = true;
      pairingInProgress = false;
      pairingStartedAt  = null;
      reconnectAttempts = 0; // reset backoff -- sesi lagi sehat
      startWatchdog();
      console.log('  [WhatsApp] Berhasil login & terhubung.');
      sendMessage('✅ <b>WhatsApp berhasil terhubung</b> ke Roblox Request Panel.\nNotifikasi saluran (channel) siap dipakai.').catch(() => {});
    }

    if (connection === 'close') {
      isReady = false;
      stopWatchdog();
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const wasRegisteredBefore = isRegistered();
      // loggedOut cuma dianggap "beneran logout" kalau sebelumnya udah pernah
      // kelar login. Kalau belum pernah (masih proses pairing), WA sering
      // motong koneksi sesaat — itu NORMAL, harus reconnect biar pairing lanjut.
      const genuineLogout = statusCode === DisconnectReason.loggedOut && wasRegisteredBefore;

      if (genuineLogout) {
        console.warn('  [WhatsApp] Logged out.');
        pairingInProgress = false;
        pairingStartedAt  = null;
        sendMessage('⚠️ <b>WhatsApp logged out.</b>\nHapus folder <code>wa_auth/</code> di server lalu restart, terus /addwa &lt;nomor&gt; lagi buat login ulang.').catch(() => {});
        return;
      }

      // FIX (balik ke cara lama): sebelumnya badSession otomatis MENGHAPUS
      // wa_auth/ dan maksa /addwa ulang tiap kali kejadian -- ternyata ini
      // kejadian cukup sering & jadi ganggu (harus scan/pairing ulang
      // berkali-kali). Sekarang badSession diperlakukan SAMA kayak putus
      // biasa di bawah -- coba reconnect pakai sesi yang ada dulu (dengan
      // backoff), BUKAN langsung dianggap rusak permanen. Kalau sesi itu
      // beneran gak bisa dipulihkan, ujung-ujungnya toh bakal muncul
      // 'loggedOut' asli yang tetap ditangani di atas (minta /addwa ulang).

      if (wasRegisteredBefore) {
        // connectionReplaced = ada device/sesi LAIN yang login pakai nomor
        // yang sama di tempat lain (mis. server lain / HP-nya sendiri buka
        // WA Web manual, atau ada instance lama project ini yang masih
        // jalan di server lain pakai wa_auth/ yang sama) -- reconnect tetap
        // dicoba, tapi dikasih tau ke Telegram juga (bukan cuma log server
        // yang mungkin gak kecek) karena ini penyebab paling umum "koneksi
        // sering putus padahal WA di HP kelihatan normal-normal aja" -- WA
        // di HP emang gak kena efek konflik sesi WEB kayak gini.
        if (statusCode === DisconnectReason.connectionReplaced) {
          console.warn('  [WhatsApp] Sesi digantikan device/tempat lain (connectionReplaced) -- kemungkinan nomor ini lagi dipakai login WA Web di tempat lain juga.');
          sendMessage(
            '⚠️ <b>Koneksi WhatsApp digantikan sesi lain</b> (connectionReplaced).\n\n' +
            'Ini biasanya artinya nomor ini SEDANG login WhatsApp Web/Desktop di tempat lain juga ' +
            '(browser lain, HP-nya sendiri, atau ada instance lama bot ini yang masih jalan di server lain pakai sesi yang sama).\n\n' +
            'Bot bakal coba reconnect otomatis, tapi kalau ini kejadian terus-menerus, coba cek: <b>Pengaturan → Perangkat Tertaut</b> di WhatsApp HP kamu, dan logout semua sesi Web/Desktop yang gak dikenal.'
          ).catch(() => {});
        } else {
          const reasonName = Object.keys(DisconnectReason).find(k => DisconnectReason[k] === statusCode) || 'tidak diketahui';
          console.warn(`  [WhatsApp] Terputus (statusCode: ${statusCode}, reason: ${reasonName}), mencoba reconnect...`);
        }
        const wait = nextReconnectDelayMs();
        console.warn(`  [WhatsApp] Reconnect dalam ${Math.round(wait / 1000)}s (percobaan ke-${reconnectAttempts}).`);
        setTimeout(() => connectExisting().catch(e => console.warn('[WA reconnect]', e.message)), wait);
        return;
      }

      if (pairingInProgress) {
        const elapsed = Date.now() - (pairingStartedAt || Date.now());
        if (elapsed < PAIRING_WINDOW_MS) {
          // Ini bagian normal dari alur pairing code: WA motong koneksi abis
          // kode diminta, dan bakal nyambung beneran begitu kode dimasukin di HP.
          // Terus nyambung ulang selama masih dalam jendela 5 menit.
          console.warn(`  [WhatsApp] Koneksi ditutup sementara (bagian normal dari proses pairing), nyambung ulang... (${Math.round(elapsed / 1000)}s / ${PAIRING_WINDOW_MS / 1000}s)`);
          setTimeout(() => connectExisting().catch(e => console.warn('[WA reconnect pairing]', e.message)), 2000);
        } else {
          console.warn('  [WhatsApp] Kode pairing kemungkinan sudah expired (>5 menit).');
          pairingInProgress = false;
          pairingStartedAt  = null;
          sendMessage(`⌛ <b>Kode pairing sudah lewat 5 menit</b> dan kemungkinan expired.\nKetik <code>/addwa ${pairingPhone || '&lt;nomor&gt;'}</code> lagi buat minta kode baru.`).catch(() => {});
        }
        return;
      }

      console.warn('  [WhatsApp] Koneksi ditutup. Ketik /addwa <nomor> lagi buat minta kode baru.');
    }
  });
}

async function ensureAuthDir() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// Opsi socket yang dipakai di KEDUA tempat pembuatan koneksi (existing &
// pairing baru) -- bikin sesi lebih "kuat" bertahan: keep-alive lebih rapat
// biar cepat ketahuan kalau koneksi diam-diam mati (bukan nunggu OS/timeout
// jaringan yang bisa lama), timeout connect lebih longgar buat jaringan
// server yang kadang lambat, dan auto-retry query internal Baileys sendiri.
const RESILIENT_SOCKET_OPTS = {
  keepAliveIntervalMs:     15_000, // ping tiap 15s -- default Baileys 30s, ini lebih rapat biar cepat sadar kalau putus diam-diam
  connectTimeoutMs:        60_000, // toleransi jaringan server yang kadang lambat pas awal connect
  defaultQueryTimeoutMs:   undefined, // jangan timeout query internal secara agresif (biar gak dikira "gagal" padahal cuma lambat)
  retryRequestDelayMs:     2_000,  // kalau ada request internal gagal, retry otomatis
  markOnlineOnConnect:     false,  // jangan pamer status "online" terus -- lebih mirip pola pemakaian wajar, bukan bot 24/7
};

// Reconnect pakai session yang udah ada (dipanggil saat server start kalau
// udah pernah login, atau saat reconnect otomatis abis putus koneksi).
async function connectExisting() {
  await ensureAuthDir();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  // SENGAJA gak pakai fetchLatestBaileysVersion() lagi -- itu nanya versi
  // WhatsApp Web "terbaru" ke server WA tiap connect, TAPI versi terbaru itu
  // kadang belum kompatibel sama versi library Baileys yang kepasang
  // (^6.7.9), dan ini penyebab umum connection-loop/bad-session yang
  // dilaporkan banyak orang di komunitas Baileys. Sekarang biarin kosong
  // (undefined) -- otomatis pakai versi bawaan/default yang UDAH DIUJI cocok
  // sama rilis Baileys ini, jauh lebih stabil buat sesi yang tertaut lama.

  sock = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    logger: silentLogger,
    ...RESILIENT_SOCKET_OPTS
  });
  sock.ev.on('creds.update', (...args) => {
    // Lacak proses simpan sesi yang lagi jalan -- dipakai closeWhatsApp() di
    // bawah biar shutdown (restart terjadwal / SIGTERM dari Pterodactyl) gak
    // motong proses nulis file di tengah jalan, yang salah satu penyebab
    // paling umum sesi jadi 'bad session' abis restart.
    credsSaveInFlight = Promise.resolve(saveCreds(...args));
    credsSaveInFlight.finally(() => { credsSaveInFlight = null; });
  });
  attachConnectionHandlers(sock);
  return sock;
}

// Bikin socket BARU dan langsung minta kode pairing buat nomor tsb —
// persis alur resmi Baileys (kode diminta begitu socket dibuat, bukan
// belakangan). Dipakai khusus buat login pertama kali / ganti akun.
async function connectAndRequestPairingCode(phoneNumber) {
  // Kalau ada percobaan sebelumnya yang masih nyantol, tutup dulu biar gak dobel koneksi.
  if (sock) {
    try { sock.end(new Error('restart pairing')); } catch {}
    sock = null;
  }

  await ensureAuthDir();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  // SENGAJA gak pakai fetchLatestBaileysVersion() lagi -- itu nanya versi
  // WhatsApp Web "terbaru" ke server WA tiap connect, TAPI versi terbaru itu
  // kadang belum kompatibel sama versi library Baileys yang kepasang
  // (^6.7.9), dan ini penyebab umum connection-loop/bad-session yang
  // dilaporkan banyak orang di komunitas Baileys. Sekarang biarin kosong
  // (undefined) -- otomatis pakai versi bawaan/default yang UDAH DIUJI cocok
  // sama rilis Baileys ini, jauh lebih stabil buat sesi yang tertaut lama.

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    logger: silentLogger,
    ...RESILIENT_SOCKET_OPTS
  });
  sock.ev.on('creds.update', (...args) => {
    // Lacak proses simpan sesi yang lagi jalan -- dipakai closeWhatsApp() di
    // bawah biar shutdown (restart terjadwal / SIGTERM dari Pterodactyl) gak
    // motong proses nulis file di tengah jalan, yang salah satu penyebab
    // paling umum sesi jadi 'bad session' abis restart.
    credsSaveInFlight = Promise.resolve(saveCreds(...args));
    credsSaveInFlight.finally(() => { credsSaveInFlight = null; });
  });
  attachConnectionHandlers(sock);

  // Kasih jeda dulu sebelum minta kode — kalau diminta langsung sesaat
  // setelah socket dibuat, WebSocket-nya sering belum kebuka penuh dan
  // requestPairingCode() gagal dengan error "Connection Closed".
  await delay(3000);

  pairingInProgress = true;
  pairingStartedAt  = Date.now();
  pairingPhone      = phoneNumber;
  try {
    const code = await sock.requestPairingCode(phoneNumber);
    return code;
  } catch (e) {
    // 1x retry kalau masih gagal karena koneksi belum siap.
    if (/connection closed/i.test(e.message || '')) {
      await delay(3000);
      const code = await sock.requestPairingCode(phoneNumber);
      return code;
    }
    pairingInProgress = false;
    pairingStartedAt  = null;
    throw e;
  }
}

// Dipanggil sekali di server start. Kalau udah pernah login → reconnect
// otomatis. Kalau belum → TIDAK bikin koneksi apapun, nunggu admin ketik
// /addwa <nomor> di Telegram buat mulai pairing.
async function initWhatsApp() {
  if (!makeWASocket) {
    console.warn('  [WhatsApp] Dependency belum ke-install. Jalankan: npm install');
    return null;
  }
  if (isRegistered()) {
    return connectExisting();
  }
  console.log('  [WhatsApp] Belum login. Ketik /addwa <nomor> di Telegram (private chat, contoh: /addwa 6281234567890) buat mulai.');
  return null;
}

// Dipanggil dari command /addwa <nomor> di bot Telegram.
async function requestPairingCode(phoneNumber) {
  if (!makeWASocket) throw new Error('Dependency WhatsApp belum ke-install di server (jalankan npm install).');
  if (isRegistered()) {
    throw new Error('WhatsApp sudah login. Kalau mau ganti akun: hapus folder wa_auth/ di server, restart server, baru /addwa lagi.');
  }
  const cleaned = String(phoneNumber).replace(/[^0-9]/g, '');
  if (!cleaned || cleaned.length < 8) {
    throw new Error('Nomor gak valid. Format: kode negara + nomor tanpa "+" atau "0" di depan, contoh 6281234567890.');
  }
  return connectAndRequestPairingCode(cleaned);
}

function isWhatsAppReady() { return isReady; }

// Kirim teks ke saluran (channel) WA yang sudah ditentukan di atas.
async function sendChannelMessage(text) {
  if (!sock || !isReady) {
    console.warn('[WA] Belum terhubung, notifikasi saluran dilewati:', text.slice(0, 60));
    return false;
  }
  try {
    await sock.sendMessage(CHANNEL_JID, { text });
    return true;
  } catch (e) {
    console.warn('[WA sendChannelMessage]', e.message);
    return false;
  }
}

// Kirim GAMBAR ke saluran (channel) WA — dipakai buat share banner/Image yang
// udah lolos upload Roblox (fisik gambarnya, bukan cuma teks doang).
async function sendChannelImage(filePath, caption) {
  if (!sock || !isReady) {
    console.warn('[WA] Belum terhubung, gambar ke saluran dilewati');
    return false;
  }
  try {
    const buffer = fs.readFileSync(filePath);
    await sock.sendMessage(CHANNEL_JID, { image: buffer, caption });
    return true;
  } catch (e) {
    console.warn('[WA sendChannelImage]', e.message);
    return false;
  }
}

// Kirim teks LANGSUNG ke nomor WA pribadi seseorang (bukan ke saluran) —
// dipakai buat privilege VVIP yang udah daftar nomor WA-nya (lihat /setwa).
// number harus format internasional tanpa "+"/spasi, contoh: 6281234567890
async function sendDirectMessage(number, text) {
  if (!sock || !isReady) {
    console.warn('[WA] Belum terhubung, DM pribadi dilewati:', text.slice(0, 60));
    return false;
  }
  const clean = String(number || '').replace(/[^0-9]/g, '');
  if (!clean) return false;
  try {
    await sock.sendMessage(`${clean}@s.whatsapp.net`, { text });
    return true;
  } catch (e) {
    console.warn('[WA sendDirectMessage]', number, e.message);
    return false;
  }
}

// Sama kayak sendDirectMessage tapi buat gambar (privilege VVIP buat banner).
async function sendDirectImage(number, filePath, caption) {
  if (!sock || !isReady) {
    console.warn('[WA] Belum terhubung, gambar DM pribadi dilewati');
    return false;
  }
  const clean = String(number || '').replace(/[^0-9]/g, '');
  if (!clean) return false;
  try {
    const buffer = fs.readFileSync(filePath);
    await sock.sendMessage(`${clean}@s.whatsapp.net`, { image: buffer, caption });
    return true;
  } catch (e) {
    console.warn('[WA sendDirectImage]', number, e.message);
    return false;
  }
}

// Kirim VIDEO ke saluran (channel) WA -- dipakai buat share hasil Video Tron
// (fisik video ASLI yang di-upload user, bukan klip-klipnya -- klip cuma buat
// dikirim ke Roblox, gak enak ditonton satu-satu di WA).
async function sendChannelVideo(filePath, caption) {
  if (!sock || !isReady) {
    console.warn('[WA] Belum terhubung, video ke saluran dilewati');
    return false;
  }
  try {
    const buffer = fs.readFileSync(filePath);
    await sock.sendMessage(CHANNEL_JID, { video: buffer, caption });
    return true;
  } catch (e) {
    console.warn('[WA sendChannelVideo]', e.message);
    return false;
  }
}

async function sendDirectVideo(number, filePath, caption) {
  if (!sock || !isReady) {
    console.warn('[WA] Belum terhubung, video DM pribadi dilewati');
    return false;
  }
  const clean = String(number || '').replace(/[^0-9]/g, '');
  if (!clean) return false;
  try {
    const buffer = fs.readFileSync(filePath);
    await sock.sendMessage(`${clean}@s.whatsapp.net`, { video: buffer, caption });
    return true;
  } catch (e) {
    console.warn('[WA sendDirectVideo]', number, e.message);
    return false;
  }
}

// Tutup koneksi WA dengan RAPI -- dipanggil sebelum proses server exit
// (baik restart terjadwal 00:00 WIB maupun SIGTERM dari Pterodactyl pas
// admin klik restart/stop manual di panel). Nunggu dulu kalau lagi ada
// proses simpan sesi yang jalan, BARU tutup socket-nya -- biar gak ada
// file sesi yang kepotong nulis di tengah jalan (salah satu penyebab
// paling umum "bad session" abis restart, walau BUKAN satu-satunya
// penyebab -- WA sendiri juga bisa motong sesi sepihak kapan aja).
async function closeWhatsApp() {
  stopWatchdog();
  try {
    if (credsSaveInFlight) await credsSaveInFlight.catch(() => {});
  } catch {}
  try { sock?.end(undefined); } catch {}
}

module.exports = {
  initWhatsApp, requestPairingCode, isRegistered, isWhatsAppReady,
  sendChannelMessage, sendChannelImage, sendChannelVideo, sendDirectMessage, sendDirectImage, sendDirectVideo,
  CHANNEL_JID, CHANNEL_LINK, closeWhatsApp
};
