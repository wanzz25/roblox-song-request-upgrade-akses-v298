// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║   Quota Schedule — Jadwal Sesi & Kuota Global Lagu+Banner    ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝
//
// Fitur terpisah dari scheduler.js (yang buka/tutup SELURUH app).
// Modul ini mengatur request LAGU & BANNER dalam 1 jadwal/sesi yang sama:
//   • Buka otomatis di jam terjadwal (misal 14:00 & 19:00 WIB)
//   • Kuota global per sesi, TERPISAH untuk lagu & banner
//     (misal sesi Siang: 25 ID lagu pertama + 5 ID banner pertama)
//   • Begitu kuota salah satu tipe habis → tipe itu SAJA ditutup otomatis
//     (bukan appoff — sisanya tetap jalan normal)
//   • Bisa dibuka/ditutup manual kapan saja lewat command,
//     tapi jadwal berikutnya tetap jalan seperti biasa
//     (manual cuma override sementara, bukan menghapus jadwal).
//   • Lagu/banner yang DITOLAK admin → kuota tipe itu balik +1.

const fs   = require('fs');
const path = require('path');

const { dataFile } = require('./dataPaths');
const { readReqStatus, writeReqStatus } = require('./store');
const { resetAllRates } = require('./ratelimit');
const { sendMessage } = require('./telegram');
const { sendChannelMessage, CHANNEL_LINK } = require('./whatsapp');
const { getTime } = require('./util');

const ROOT = path.join(__dirname, '..');
const MAX_SLOTS = 3;
const TYPE_KEY = { song: 'lagu', banner: 'banner' }; // mapping ke field reqStatus
const TYPE_LABEL = { song: 'lagu', banner: 'banner' };

const SCHEDULE_FILE = dataFile('song_schedule.json');
const SESSION_FILE  = dataFile('song_session.json');

// Jadwal default — dipakai kalau song_schedule.json belum ada.
// Asumsi: kuota banner 5 berlaku di kedua sesi (cuma 1 angka yang dikasih).
const DEFAULT_SCHEDULE = [
  { slot: 1, label: 'Sesi Siang', openTime: '15:00', songQuota: 25, bannerQuota: 5 },
  { slot: 2, label: 'Sesi Malam', openTime: '21:00', songQuota: 10, bannerQuota: 5 }
];

function readSongSchedule() {
  try {
    const data = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
    // Dulu: array kosong ([]) dianggap "belum pernah diisi" -> balik ke
    // DEFAULT_SCHEDULE lagi. Bug: /clearsongslot buat ngosongin semua slot
    // jadi PERCUMA, soalnya begitu file-nya kesave [], baca berikutnya
    // otomatis balik ke default. Sekarang array kosong yang VALID (file-nya
    // beneran ada isinya berupa []) dihormati apa adanya -- artinya user
    // sengaja gak mau ada sesi otomatis sama sekali. DEFAULT_SCHEDULE cuma
    // dipakai kalau file-nya belum ada / corrupt (lihat catch di bawah).
    return Array.isArray(data) ? data : DEFAULT_SCHEDULE;
  } catch {
    return DEFAULT_SCHEDULE;
  }
}
function saveSongSchedule(d) { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(d, null, 2)); }

function setSongSlot(slot, { openTime, songQuota, bannerQuota, label }) {
  const schedules = readSongSchedule().map(s => ({ ...s })); // clone (biar default tidak ke-mutate)
  let entry = schedules.find(s => s.slot === slot);
  if (!entry) {
    entry = { slot, label: label || `Sesi ${slot}`, openTime: null, songQuota: null, bannerQuota: null };
    schedules.push(entry);
    schedules.sort((a, b) => a.slot - b.slot);
  }
  if (openTime    !== undefined) entry.openTime    = openTime;
  if (songQuota   !== undefined) entry.songQuota   = songQuota;
  if (bannerQuota !== undefined) entry.bannerQuota = bannerQuota;
  if (label       !== undefined && label !== null) entry.label = label;
  saveSongSchedule(schedules);
  return entry;
}

function clearSongSlot(slot) {
  const schedules = readSongSchedule().filter(s => s.slot !== slot);
  saveSongSchedule(schedules);
}

function clearAllSongSchedule() { saveSongSchedule([]); }

function fmtQuota(q, label) {
  return (q || q === 0) ? `<b>${q} ID ${label} pertama</b>` : `— (${label} unlimited)`;
}
function fmtSongSlot(s) {
  const open = s.openTime ? `🟢 Buka  : <b>${s.openTime}</b> WIB` : '🟢 Buka  : —';
  return `<b>${s.label || 'Sesi ' + s.slot} (slot ${s.slot})</b>\n${open}\n` +
    `🎵 Kuota lagu   : ${fmtQuota(s.songQuota, 'lagu')}\n` +
    `🖼️ Kuota banner : ${fmtQuota(s.bannerQuota, 'banner')}`;
}

function defaultTypeState() { return { quota: null, count: 0, active: false, closedAt: null, closedBy: null, openedAtTs: null }; }
function defaultSession() {
  return {
    active: false, slot: null, label: null, source: null, openedAt: null, closedAt: null,
    song: defaultTypeState(), banner: defaultTypeState()
  };
}
function readSongSession() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    return { ...defaultSession(), ...raw, song: { ...defaultTypeState(), ...(raw.song || {}) }, banner: { ...defaultTypeState(), ...(raw.banner || {}) } };
  } catch { return defaultSession(); }
}
function writeSongSession(d) { fs.writeFileSync(SESSION_FILE, JSON.stringify(d, null, 2)); }

function isBannerPaused() { return !!readReqStatus().bannerPaused; }

// Pause banner SECARA PERMANEN lintas jadwal — beda dari closeSession('banner')
// yang cuma nutup sesi SEKARANG doang (bakal kebuka lagi otomatis pas jadwal
// berikutnya karena jadwal punya kuota banner sendiri). Dipakai kalau upload
// gambar lagi bermasalah dan banner perlu OFF total sampai di-resume manual.
function pauseBanner(reason) {
  const stat = readReqStatus();
  stat.bannerPaused = true;
  writeReqStatus(stat);
  closeSession('banner', reason || 'Fitur request banner sedang dinonaktifkan sementara oleh admin (ada masalah upload gambar).', 'manual-pause');
}
function resumeBanner() {
  const stat = readReqStatus();
  delete stat.bannerPaused;
  writeReqStatus(stat);
  // Gak otomatis buka sesi banner — admin perlu /openbanner manual atau tunggu jadwal berikutnya.
}

// Buka sesi (dipanggil scheduler otomatis ATAU command manual).
// songQuota/bannerQuota undefined = tipe itu gak disentuh sama sekali (biarin apa adanya).
function openSession({ slot = null, label = null, songQuota, bannerQuota, source = 'manual' } = {}) {
  if (isBannerPaused()) bannerQuota = undefined; // banner lagi di-pause admin, jangan disentuh jadwal/command manapun

  const stat = readReqStatus();
  const session = readSongSession();

  session.slot = slot; session.label = label; session.source = source;
  session.openedAt = getTime(); session.closedAt = null;

  if (songQuota !== undefined) {
    delete stat.lagu;
    // openedAtTs = penanda "mulai dari sini" -- request PENDING lama dari sesi
    // sebelumnya gak ikut ke-hitung lagi di nomor antrian sesi baru (lihat
    // /api/queue-position di routes/api.js), tapi tetep utuh sebagai riwayat
    // di logs.json, gak ada yang dihapus.
    session.song = { quota: songQuota, count: 0, active: true, closedAt: null, closedBy: null, openedAtTs: Date.now() };
    resetAllRates('song');
  }
  if (bannerQuota !== undefined) {
    delete stat.banner;
    session.banner = { quota: bannerQuota, count: 0, active: true, closedAt: null, closedBy: null, openedAtTs: Date.now() };
    resetAllRates('banner');
  }
  session.active = !!(session.song.active || session.banner.active);

  writeReqStatus(stat);
  writeSongSession(session);

  // Notif ke saluran WA — "sudah bisa req"
  const opened = [];
  if (songQuota !== undefined)   opened.push(`🎵 Lagu (${songQuota == null ? 'unlimited' : songQuota + ' ID pertama'})`);
  if (bannerQuota !== undefined) opened.push(`🖼️ Banner (${bannerQuota == null ? 'unlimited' : bannerQuota + ' ID pertama'})`);
  if (opened.length) {
    sendChannelMessage(
      `🟢 REQUEST SUDAH DIBUKA!\n\n` +
      (label ? `Sesi: ${label}\n\n` : '') +
      opened.join('\n') + `\n\n` +
      `Yuk buruan request sebelum kuota penuh! 🚀`
    ).catch(() => {});
  }
}

// Backward-compat: buka sesi lagu doang (dipakai /opensong lama)
function openSongSession({ slot = null, label = null, quota = null, source = 'manual' } = {}) {
  openSession({ slot, label, songQuota: quota, source });
}

// Tutup 1 tipe ('song'|'banner') secara manual atau auto.
function closeSession(type, reason, source = 'manual') {
  const key = TYPE_KEY[type];
  const stat = readReqStatus();
  stat[key] = { enabled: false, message: reason || `Request ${TYPE_LABEL[type]} sedang ditutup.` };
  writeReqStatus(stat);

  const session = readSongSession();
  session[type] = { ...session[type], active: false, closedAt: getTime(), closedBy: source };
  session.active = !!(session.song.active || session.banner.active);
  writeSongSession(session);
}
function closeSongSession(reason, source = 'manual') { closeSession('song', reason, source); }

// Dipanggil tiap ada 1 request (lagu/banner) baru yang berhasil masuk.
async function incrementCount(type) {
  const session = readSongSession();
  const t = session[type];
  if (!t || !t.active || t.quota == null) return;

  t.count += 1;
  writeSongSession(session);

  if (t.count >= t.quota) {
    const label = session.label || 'sesi ini';
    const typeLabel = TYPE_LABEL[type];
    const reason = `Kuota ${typeLabel} "${label}" sudah penuh (${t.count}/${t.quota} ID). Request ${typeLabel} ditutup otomatis — akan dibuka lagi sesuai jadwal berikutnya.`;
    closeSession(type, reason, 'auto-quota');
    sendMessage(
      `🔴 <b>Kuota ${typeLabel === 'lagu' ? 'Lagu' : 'Banner'} Habis — Ditutup Otomatis</b>\n\n` +
      `Sesi   : <b>${label}</b>\n` +
      `Kuota  : <b>${t.count}/${t.quota}</b>\n\n` +
      `Request ${typeLabel === 'lagu' ? 'banner' : 'lagu'} & website lainnya tetap normal.\n` +
      `Request ${typeLabel} akan buka lagi otomatis sesuai jadwal berikutnya, atau ketik <code>${type === 'song' ? '/opensong' : '/openbanner'}</code> untuk buka manual sekarang.`
    ).catch(() => {});
    sendChannelMessage(
      `🔴 REQUEST ${typeLabel.toUpperCase()} PENUH!\n\n` +
      `Sesi: ${label}\n` +
      `Kuota: ${t.count}/${t.quota} sudah terisi semua.\n\n` +
      `Request ${typeLabel} ditutup sementara, buka lagi sesuai jadwal berikutnya ya. Terima kasih udah request! 🙏`
    ).catch(() => {});
  }
}
async function incrementSongSession()   { return incrementCount('song'); }
async function incrementBannerSession() { return incrementCount('banner'); }

// Dipanggil HANYA saat request GAGAL (error teknis saat upload ke Roblox) -- kuota tipe itu
// dikembalikan. Request yang DITOLAK (admin/moderasi Roblox) TIDAK memanggil ini: kuota sesi
// global tetap terpakai, hanya limit pribadi user yang dikembalikan.
// Kalau tipe itu sempat auto-tutup gara-gara kuota penuh, dan sekarang ada slot kosong lagi → buka lagi.
function decrementCount(type) {
  const session = readSongSession();
  const t = session[type];
  if (!t || t.quota == null) return; // gak ada tracking kuota → tidak ada yang perlu direfund
  if (t.count <= 0) return;

  t.count -= 1;

  if (!t.active && t.closedBy === 'auto-quota' && t.count < t.quota) {
    const key = TYPE_KEY[type];
    const stat = readReqStatus();
    delete stat[key];
    writeReqStatus(stat);
    t.active = true; t.closedAt = null; t.closedBy = null;
    session.active = true;
    writeSongSession(session);
    sendMessage(
      `🟢 <b>Request ${TYPE_LABEL[type] === 'lagu' ? 'Lagu' : 'Banner'} Dibuka Lagi</b>\n\n` +
      `Ada request yang ditolak admin, kuota sesi <b>"${session.label || 'ini'}"</b> kembali tersedia (${t.count}/${t.quota}).`
    ).catch(() => {});
    return;
  }

  writeSongSession(session);
}
function decrementSongSession() { return decrementCount('song'); }

function getNowWIB() {
  const now = new Date();
  const wib = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  const h = String(wib.getHours()).padStart(2, '0');
  const m = String(wib.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

// Gerbang otomatis: kalau gak ada sesi kuota aktif buat lagu/banner, PAKSA tertutup.
// Jadi default-nya adalah TERTUTUP, bukan kebuka — cuma kebuka kalau memang lagi
// ada sesi kuota yang aktif (baik dari jadwal, /opensong, /openbanner, atau /setgloballimit).
// Gak akan menimpa pesan close manual yang udah ada (cuma isi kalau sebelumnya "terbuka").
function enforceSessionGate() {
  const session = readSongSession();
  const stat = readReqStatus();
  let changed = false;

  for (const type of ['song', 'banner']) {
    const key = TYPE_KEY[type];
    const t = session[type];
    if (!t || !t.active) {
      if (stat[key]?.enabled !== false) {
        stat[key] = {
          enabled: false,
          message: `Belum ada sesi kuota ${TYPE_LABEL[type]} yang aktif saat ini. Tunggu jadwal berikutnya atau hubungi admin.`,
          _gate: true
        };
        changed = true;
      }
    } else if (stat[key]?._gate === true) {
      // Sesi udah aktif tapi masih ke-tag gate lama -> bersihin (harusnya udah dihapus openSession, ini jaga-jaga)
      delete stat[key];
      changed = true;
    }
  }
  if (changed) writeReqStatus(stat);
}

function startSongScheduler() {
  enforceSessionGate(); // langsung cek pas server nyala, jangan nunggu 1 menit

  setInterval(() => {
    const nowTime = getNowWIB();
    const schedules = readSongSchedule();

    for (const s of schedules) {
      if (s.openTime && s.openTime === nowTime) {
        openSession({ slot: s.slot, label: s.label, songQuota: s.songQuota, bannerQuota: s.bannerQuota, source: 'schedule' });
        const bannerLine = isBannerPaused()
          ? `Kuota banner  : ⏸️ <i>di-pause admin, dilewati</i>`
          : `Kuota banner  : ${fmtQuota(s.bannerQuota, 'banner')}`;
        sendMessage(
          `🟢 <b>${s.label || 'Sesi ' + s.slot} Dibuka Otomatis</b>\n` +
          `Waktu         : <b>${nowTime} WIB</b>\n` +
          `Kuota lagu    : ${fmtQuota(s.songQuota, 'lagu')}\n` +
          bannerLine
        ).catch(() => {});
        console.log(`[SongScheduler] Slot ${s.slot} (${s.label}) -> buka ${nowTime} WIB, lagu ${s.songQuota ?? '∞'}, banner ${isBannerPaused() ? 'PAUSED' : (s.bannerQuota ?? '∞')}`);
      }
    }

    enforceSessionGate(); // jaga-jaga tiap menit: kalau gak ada sesi aktif, pastikan tetap tertutup
  }, 60 * 1000);

  console.log('  Scheduler jadwal & kuota lagu+banner aktif');
}

module.exports = {
  MAX_SLOTS,
  readSongSchedule, saveSongSchedule, setSongSlot, clearSongSlot, clearAllSongSchedule, fmtSongSlot,
  readSongSession, writeSongSession,
  openSession, closeSession, incrementCount, decrementCount, enforceSessionGate,
  openSongSession, closeSongSession, incrementSongSession, decrementSongSession, incrementBannerSession,
  isBannerPaused, pauseBanner, resumeBanner,
  startSongScheduler
};
