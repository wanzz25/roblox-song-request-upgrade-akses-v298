// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Routes Mobile — Endpoint REST untuk APK            ║
// ║                                                           ║
// ║   Semua endpoint di file ini khusus untuk APK Android.    ║
// ║   Autentikasi via header: x-mobile-key: <token>          ║
// ║   Token di-generate owner lewat /genmobilekey di Telegram ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');

const CFG = require('../config');
const { validateToken } = require('../lib/mobile-tokens');
const {
  readLogs, saveLogs, writeLog, findEntry,
  isBanned, isIpBanned, recordUserIp, readReqStatus, readAppStatus, readAnnounce,
  makeTicketId, findTicket, saveTicket, readTickets, saveTickets
} = require('../lib/store');
const { checkRateLimit, getBonus, RATE_LIMITS, RATE_WINDOW, readRates, isUnlimited, refundRateLimit, recordDurationViolation, checkSubmitCooldown, markSubmitted } = require('../lib/ratelimit');
const { canBypassSessionGate, canBypassAppMode, getRole, roleTitle, getDisplayName, isVvip, isPremium, roleLimit, VVIP_RESET_MS } = require('../lib/roles');
const { getTime, makeId, sanitizeFilename, escapeHtml } = require('../lib/util');
const {
  accRejKeyboard, uploadKeyboard, sendMessage, sendAudio, sendPhoto, sendDocument, broadcastToAdmins, notifyAdmins
} = require('../lib/telegram');
const { incrementCount } = require('../lib/songSchedule');
const { uploadAudio } = require('../lib/uploads');
const { neosoftYtDownload, downloadDirectUrl, getAudioDuration, reencodeToMp3 } = require('../lib/audio');
const { tmpPath, ensureBudget, TMP_DIR, respondServerError } = require('../lib/tempdir');
const { triggerAutoUpload } = require('../bot/robloxAudioRequest');   // mode /autoupload
const { getPrivateIds, markAllSeen, countUnseen, formatPrivateIdsAsTxt } = require('../lib/privateInbox');

const router = express.Router();

const mobileUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(TMP_DIR, 'rbx_mobile');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `mob_${Date.now()}_${Math.random().toString(36).slice(2,6)}${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

function mobileAuth(req, res, next) {
  const key = req.headers['x-mobile-key'];
  if (!validateToken(key)) {
    return res.status(401).json({ success: false, message: 'API key tidak valid atau tidak aktif. Hubungi owner untuk mendapatkan key baru.' });
  }
  next();
}

router.use('/api/mobile', mobileAuth);

router.get('/api/mobile/ping', (req, res) => {
  const appStat = readAppStatus();
  const reqStat = readReqStatus();
  const username = (req.query.username || '').trim();
  // Dicatat di sini juga (bukan cuma pas kirim request) -- ping dipanggil tiap app
  // dibuka, jadi ini titik paling sering buat nyatet "username ini kepakai dari IP
  // mana" (lihat recordUserIp di lib/store.js). Gak diblokir di sini (biar app tetap
  // kebuka normal); blokir beneran terjadi pas kirim request lagu/banner di bawah.
  if (username) recordUserIp(username, req.ip);
  const bypassSession = username ? canBypassSessionGate(username) : false;
  const bypassAppMode = username ? canBypassAppMode(username, appStat.mode) : false;
  res.json({
    success    : true,
    serverTime : getTime(),
    appMode    : bypassAppMode ? 'online' : (appStat.mode || 'online'),
    appMessage : bypassAppMode ? null : (appStat.message || null),
    // Saat maintenance, VIP/VVIP tetap kena (appMode = 'maintenance') TAPI halaman
    // "ID Saya" tetap boleh dibuka -- app cukup nampilin layar maintenance +
    // tombol/menu ke ID Saya kalau flag ini true.
    idSayaAccess: username ? isPremium(username) : false,
    songOpen   : bypassSession || reqStat?.lagu?.enabled !== false,
    bannerOpen : bypassSession || reqStat?.banner?.enabled !== false,
    announce   : readAnnounce()?.message || null,
    role       : username ? getRole(username) : 'member',
    roleTitle  : username ? roleTitle(username) : null,
    displayName: username ? getDisplayName(username) : null,
    version    : '1.0'
  });
});

router.get('/api/mobile/limits', (req, res) => {
  const username = (req.query.username || '').trim();
  if (!username) return res.json({ success: false, message: 'username wajib diisi.' });
  const rates  = readRates();
  const bucket = rates[`u:${username.toLowerCase()}`] || {};
  const unlimited = isUnlimited(username);
  function info(type) {
    if (unlimited) {
      return { limit: Infinity, used: 0, remaining: Infinity, resetInMs: 0, windowMs: RATE_WINDOW, unlimited: true };
    }
    if (isPremium(username)) {
      // VVIP: limit TETAP (10 lagu/5 banner), reset SEKALI SEHARI (24 jam).
      const cutoff = Date.now() - VVIP_RESET_MS;
      const hits = (bucket[type] || []).filter(t => t > cutoff);
      const limit = roleLimit(username, type);
      const remaining = Math.max(0, limit - hits.length);
      const oldest = hits.length ? Math.min(...hits) : null;
      const resetInMs = oldest ? Math.max(0, (oldest + VVIP_RESET_MS) - Date.now()) : 0;
      return { limit, used: hits.length, remaining, resetInMs, windowMs: VVIP_RESET_MS, resetMode: 'daily' };
    }
    const limit     = RATE_LIMITS[type] + getBonus(username, type);
    // Tidak ada lagi expiry berbasis waktu — limit cuma reset saat sesi
    // request global dibuka lagi, atau direset manual oleh admin.
    const hits      = bucket[type] || [];
    const remaining = Math.max(0, limit - hits.length);
    return { limit, used: hits.length, remaining, resetInMs: 0, windowMs: RATE_WINDOW, resetMode: 'session' };
  }
  res.json({ success: true, song: info('song'), banner: info('banner') });
});

router.get('/api/mobile/myrequests', (req, res) => {
  const username = (req.query.username || '').trim().toLowerCase();
  if (!username) return res.json({ success: false, message: 'username wajib diisi.' });
  const logs = readLogs().filter(l => (l.username || '').toLowerCase() === username);
  res.json({ success: true, requests: logs });
});

// ── "ID Saya" — inbox ID privat khusus VIP/VVIP (versi APK) ─────────────────
// Sama persis konsepnya kayak /api/my-private-ids di website: ID yang di-ACC
// buat user vip/vvip disimpen di sini (bukan ke saluran WA publik lagi).
router.get('/api/mobile/my-private-ids', (req, res) => {
  const username = (req.query.username || '').trim();
  if (!username || !isPremium(username)) return res.json({ success: true, isPremium: false, items: [] });
  const items = getPrivateIds(username);
  markAllSeen(username);
  res.json({ success: true, isPremium: true, items });
});

router.get('/api/mobile/my-private-ids/unseen-count', (req, res) => {
  const username = (req.query.username || '').trim();
  if (!username || !isPremium(username)) return res.json({ count: 0 });
  res.json({ count: countUnseen(username) });
});

router.get('/api/mobile/my-private-ids/download', (req, res) => {
  const username = (req.query.username || '').trim();
  if (!username || !isPremium(username)) return res.status(403).send('Halaman ini cuma buat user vip/vvip.');
  const txt = formatPrivateIdsAsTxt(username);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="id-saya-${username.toLowerCase()}.txt"`);
  res.send(txt);
});

router.get('/api/mobile/track/:id', (req, res) => {
  const entry = findEntry(req.params.id);
  if (!entry) return res.status(404).json({ success: false, message: 'Request tidak ditemukan.' });
  res.json({
    success : true,
    id      : entry.id,
    type    : entry.type,
    title   : entry.title || (entry.type === 'banner' ? 'Request Banner' : entry.type === 'video' ? 'Video Tron' : 'Request Lagu'),
    status  : entry.status,
    stage   : entry.stage || null,
    time    : entry.time,
    note    : entry.note || null,
    rating  : entry.rating || null
  });
});

router.post('/api/mobile/request', uploadAudio.single('song_file'), async (req, res) => {
  const { username, song_title, song_link, yt_title } = req.body;
  const file = req.file;
  if (!username) {
    if (file) fs.unlink(file.path, () => {});
    return res.status(400).json({ success: false, message: 'username wajib diisi.' });
  }

  const fullAccess = isUnlimited(username);
  recordUserIp(username, req.ip);
  const ipBanReq = isIpBanned(req.ip);
  if (ipBanReq && !fullAccess) {
    if (file) fs.unlink(file.path, () => {});
    return res.status(403).json({ success: false, message: `Kamu diblokir dari fitur request. Alasan: ${ipBanReq.reason || 'tidak disebutkan'}. Hubungi admin via menu Tiket.` });
  }

  const appStat = readAppStatus();
  if (appStat.mode !== 'online' && !fullAccess && !canBypassAppMode(username, appStat.mode)) {
    if (file) fs.unlink(file.path, () => {});
    return res.status(503).json({ success: false, message: appStat.message || 'Website sedang tidak tersedia.' });
  }
  const reqStat = readReqStatus();
  if (reqStat?.lagu?.enabled === false && !fullAccess && !canBypassSessionGate(username)) {
    if (file) fs.unlink(file.path, () => {});
    return res.status(403).json({ success: false, message: reqStat.lagu.message || 'Request lagu sedang ditutup.' });
  }
  if (isBanned(username) && !fullAccess) {
    if (file) fs.unlink(file.path, () => {});
    return res.status(403).json({ success: false, message: 'Kamu tidak diizinkan untuk request.' });
  }

  // Bug lama: checkRateLimit() dipanggil dengan string username doang (bukan objek
  // req), jadi req.body.login_username selalu undefined -> semua request APK dianggap
  // dari 1 kunci "ip:undefined" yang sama, dan hasilnya dibaca lewat properti `.ok`
  // yang gak pernah ada di return value checkRateLimit (isinya `.allowed`) -> SEMUA
  // request APK selalu ditolak "limit habis". Sekarang dipanggil dengan bentuk objek
  // yang benar, key-nya jadi per-username (konsisten sama web), dan baca `.allowed`.
  const rl = checkRateLimit({ body: { login_username: username }, ip: req.ip }, 'song');
  if (!rl.allowed && !fullAccess) {
    if (file) fs.unlink(file.path, () => {});
    return res.status(429).json({ success: false, message: rl.message || 'Limit request lagu kamu sudah habis.' });
  }

  // Anti-spam ke provider (sama kayak web) #1: cooldown antar submit.
  if (!fullAccess) {
    const cooldownCheck = checkSubmitCooldown({ body: { login_username: username }, ip: req.ip });
    if (!cooldownCheck.allowed) {
      if (file) fs.unlink(file.path, () => {});
      refundRateLimit(username, 'song');
      return res.status(429).json({ success: false, message: cooldownCheck.message });
    }
  }

  if (!file && !song_title && !song_link) {
    return res.status(400).json({ success: false, message: 'Upload file lagu, isi judul, atau link YouTube.' });
  }

  // Anti-spam ke provider #2: tolak link yang persis sama & masih pending/approved
  // -- gak usah didownload ulang dari provider, buang-buang kuota percuma.
  if (song_link?.trim()) {
    const dupEntry = readLogs().find(l =>
      l.link && l.link === song_link.trim() &&
      ['pending', 'approved'].includes(l.status)
    );
    if (dupEntry) {
      if (file) fs.unlink(file.path, () => {});
      refundRateLimit(username, 'song');
      return res.status(409).json({
        success: false,
        message: `Link ini sudah pernah di-request (status: ${dupEntry.status === 'approved' ? 'sudah di-ACC' : 'masih pending'}). Cek di tab Request Saya ya.`,
        duplicateId: dupEntry.id
      });
    }
  }

  markSubmitted({ body: { login_username: username }, ip: req.ip });

  try {
    const id          = makeId();
    const time        = getTime();

    // Sama persis kayak web: kalau gak ada file upload tapi ada link, coba
    // download dulu audionya (YouTube via Neosoft, atau link direct MP3/dll)
    // sebelum dikirim ke Telegram -- dulu di sini cuma dikirim sebagai teks
    // link doang, gak pernah beneran didownload.
    let ytDownloadedPath = null;
    let ytInfo = null;
    let ytFailure = null;   // error terakhir dari auto-download (bedain "link mati" vs "provider bermasalah")
    if (!file && song_link?.trim()) {
      const linkTrim = song_link.trim();
      const isYt     = /youtu\.?be|youtube\.com/i.test(linkTrim);
      const isDirect = !isYt && /^https?:\/\//i.test(linkTrim);
      ensureBudget(60 * 1024 * 1024, 'download audio YouTube');
      const tmpOut   = tmpPath(`yt_mobile_${makeId()}.mp3`);
      if (isYt) {
        try {
          ytInfo = await neosoftYtDownload(linkTrim, tmpOut);
          if (fs.existsSync(tmpOut)) ytDownloadedPath = tmpOut;
        } catch (ytErr) {
          ytFailure = ytErr;
          console.error('[Mobile Neosoft Downloader]', ytErr.message);
        }
      } else if (isDirect) {
        try {
          await downloadDirectUrl(linkTrim, tmpOut);
          if (fs.existsSync(tmpOut)) ytDownloadedPath = tmpOut;
          ytInfo = { title: null };
        } catch (dlErr) {
          console.error('[Mobile Direct Downloader]', dlErr.message);
        }
      }
    }

    const displayTitle = yt_title || song_title || (ytDownloadedPath && ytInfo?.title) || (file ? file.originalname : song_link);

    // Sama kayak di web: kalau semua provider gagal download, auto-reject
    // langsung + kembaliin limit, daripada bikin request nyangkut tanpa file.
    if (!file && !ytDownloadedPath) {
      if (username) refundRateLimit(username, 'song');
      writeLog({
        id, type: 'song', requester: username, username,
        title: displayTitle, link: song_link || null,
        status: 'rejected', stage: 'gagal', time, source: 'apk',
        tgChatId: null, tgMsgId: null, tgMsgs: []
      });
      sendMessage(
        `<b>⚠️ Auto-download Gagal (APK)</b>  <code>#${id}</code>\n\n` +
        `<b>Dari  :</b> ${escapeHtml(username)}\n` +
        `<b>Judul :</b> <code>${escapeHtml(displayTitle)}</code>\n` +
        (song_link ? `<b>Link  :</b> ${escapeHtml(song_link)}\n` : '') +
        `\n⏰ ${time}\n\n` +
        `📌 <b>Status:</b> ❌ Auto-ditolak (${ytFailure?.code === 'VIDEO_UNAVAILABLE' ? 'video tidak ditemukan / dihapus / privat' : 'semua provider download gagal'})\n` +
        `<i>User udah diminta request ulang, limit udah dikembalikan.</i>`
      ).catch(() => {});
      return res.json({
        success: false,
        message: ytFailure?.code === 'VIDEO_UNAVAILABLE'
          ? 'Video di link itu tidak ditemukan — kemungkinan sudah dihapus atau bersifat privat. Cek lagi linknya ya. Limit kamu udah dikembalikan.'
          : 'Gagal mengunduh audio dari link yang kamu kasih (semua server download lagi bermasalah). Limit kamu udah dikembalikan — coba lagi pakai link lain, atau upload file MP3 langsung ya.'
      });
    }

    // ── Validasi durasi: maksimal 7 menit (sama kayak di web) ──────────────
    const MAX_DURATION_SEC = 7 * 60;
    {
      const checkPath = file ? file.path : ytDownloadedPath;
      let durationSec = null;
      // Durasi hasil auto-download udah di-probe di lib/audio.js -- gak perlu ffprobe ulang.
      if (!file && ytInfo?.probedDuration) durationSec = ytInfo.probedDuration;
      else { try { durationSec = await getAudioDuration(checkPath); } catch (e) { console.warn('[Mobile DurationCheck]', e.message); } }
      if (durationSec && durationSec > MAX_DURATION_SEC) {
        if (file) fs.unlink(file.path, () => {});
        if (ytDownloadedPath) fs.unlink(ytDownloadedPath, () => {});
        if (username) refundRateLimit(username, 'song');

        const { count, penalized } = recordDurationViolation(username);
        const menit = (durationSec / 60).toFixed(1);
        writeLog({
          id, type: 'song', requester: username, username,
          title: displayTitle, link: song_link || null,
          status: 'rejected', stage: 'gagal', time, source: 'apk',
          tgChatId: null, tgMsgId: null, tgMsgs: []
        });
        sendMessage(
          `<b>⚠️ Lagu Terlalu Panjang (APK)</b>  <code>#${id}</code>\n\n` +
          `<b>Dari  :</b> ${escapeHtml(username)}\n` +
          `<b>Judul :</b> <code>${escapeHtml(displayTitle)}</code>\n` +
          `<b>Durasi:</b> ${menit} menit (maks 7 menit)\n` +
          `\n⏰ ${time}\n\n` +
          `📌 <b>Status:</b> ❌ Auto-ditolak (durasi kelebihan)\n` +
          `<i>Pelanggaran ke-${count}${penalized ? ' — limit song sesi ini dikurangi 1 (reset otomatis pas sesi baru dibuka).' : '.'}</i>`
        ).catch(() => {});
        return res.json({
          success: false,
          message: `Lagu ini durasinya ${menit} menit, melebihi batas maksimal 7 menit. ` +
            (penalized
              ? `Ini pelanggaran ke-${count} kamu — limit request lagu kamu buat sesi ini DIKURANGI 1 sebagai konsekuensi (otomatis normal lagi begitu sesi baru dibuka).`
              : `Ini pelanggaran pertama kamu (masih gratis) — tapi kalau diulang lagi, limit kamu bakal dikurangi.`)
        });
      }
    }

    // ── Paksa MP3 standar buat FILE YANG DIUPLOAD LANGSUNG (sama kayak web) ──
    // Hasil auto-download dari link (ytDownloadedPath) udah pasti mp3 standar
    // (di-reencode di dalam lib/audio.js). File upload manual dari APK belum,
    // jadi disamain di sini biar SEMUA jalur dijamin MP3 asli buat Roblox.
    if (file) {
      try {
        await reencodeToMp3(file.path);
      } catch (reencodeErr) {
        fs.unlink(file.path, () => {});
        if (username) refundRateLimit(username, 'song');
        console.error('[Mobile ReencodeCheck]', reencodeErr.message);
        return res.json({
          success: false,
          message: 'File yang kamu upload gagal dikonversi ke format MP3 (kemungkinan file rusak/bukan audio valid). Limit kamu udah dikembalikan — coba upload ulang pakai file MP3 lain.'
        });
      }
    }

    const caption =
      `🎵 <b>Request Lagu (APK)</b>\n\n` +
      `<b>ID:</b> <code>#${id}</code>\n` +
      `<b>Dari:</b> ${escapeHtml(username)}\n` +
      (displayTitle ? `<b>Judul:</b> ${escapeHtml(displayTitle)}\n` : '') +
      (song_link && !file && !ytDownloadedPath ? `<b>Link:</b> ${escapeHtml(song_link)}\n` : '') +
      (file ? `<b>File:</b> ${escapeHtml(file.originalname)}\n` : '') +
      (ytDownloadedPath ? `<i>(Auto-download dari YouTube ✅)</i>\n` : '') +
      `\n⏰ ${time}` +
      `\n\n📌 <b>Status:</b> ⏳ (tunggu upload)`;

    const keyboard = uploadKeyboard(id);
    let tgChatId = null, tgMsgId = null, tgMsgObj = null;

    {
      // Sama persis kayak upload file di web: kirim audio asli ke Telegram
      // (baik dari file yang diupload user, ATAU hasil auto-download link).
      // (kasus gagal total udah di-handle early-return di atas)
      const sendPath = file ? file.path : ytDownloadedPath;
      const audioExt = path.extname(sendPath) || '.mp3';
      const audioFilename = file
        ? sanitizeFilename(path.basename(file.originalname, path.extname(file.originalname)), audioExt)
        : sanitizeFilename(displayTitle || 'lagu', audioExt);
      let r;
      try { r = await sendAudio(sendPath, caption, keyboard, audioFilename, { card: true }); }
      catch { r = await sendDocument(sendPath, caption, keyboard, audioFilename, { card: true }); }
      tgChatId = r?.result?.chat?.id || null;
      tgMsgId  = r?.result?.message_id || null;
      tgMsgObj = r?.result || null;
      if (file) fs.unlink(file.path, () => {});
      if (ytDownloadedPath) fs.unlink(ytDownloadedPath, () => {});
    }

    const copies   = await broadcastToAdmins(tgChatId, tgMsgId, keyboard);
    const tgMsgs   = [{ chatId: tgChatId, msgId: tgMsgId }, ...copies];

    const entry = {
      id, type: 'song', requester: username, username,
      title: displayTitle, link: song_link || null,
      status: 'pending', stage: 'tunggu_upload', time, source: 'apk',
      tgChatId, tgMsgId, tgMsgs
    };
    writeLog(entry);
    triggerAutoUpload(id, tgMsgObj);   // mode /autoupload
    incrementCount('song').catch(e => console.warn('[songSchedule increment mobile song]', e.message));

    res.json({ success: true, message: 'Request berhasil dikirim!', id, time });
  } catch (err) {
    console.error('[Mobile Song Error]', err);
    if (file) fs.unlink(file.path, () => {});
    refundRateLimit(username, 'song');
    respondServerError(res, err);
  }
});

router.post('/api/mobile/banner', mobileUpload.single('banner_image'), async (req, res) => {
  const { username, quote_text, font_style } = req.body;
  const file = req.file;

  if (!username) return res.status(400).json({ success: false, message: 'username wajib diisi.' });
  if (!file && !quote_text) return res.status(400).json({ success: false, message: 'Upload gambar atau isi teks quote.' });

  const fullAccess = isUnlimited(username);
  recordUserIp(username, req.ip);
  const ipBanBanner = isIpBanned(req.ip);
  if (ipBanBanner && !fullAccess) {
    if (file) fs.unlink(file.path, () => {});
    return res.status(403).json({ success: false, message: `Kamu diblokir dari fitur request. Alasan: ${ipBanBanner.reason || 'tidak disebutkan'}. Hubungi admin via menu Tiket.` });
  }

  const appStat = readAppStatus();
  if (appStat.mode !== 'online' && !fullAccess && !canBypassAppMode(username, appStat.mode)) {
    return res.status(503).json({ success: false, message: appStat.message || 'Website sedang tidak tersedia.' });
  }
  const reqStat = readReqStatus();
  if (reqStat?.banner?.enabled === false && !fullAccess && !canBypassSessionGate(username)) {
    return res.status(403).json({ success: false, message: reqStat.banner.message || 'Request banner sedang ditutup.' });
  }
  if (isBanned(username) && !fullAccess) {
    if (file) fs.unlink(file.path, () => {});
    return res.status(403).json({ success: false, message: 'Kamu tidak diizinkan untuk request.' });
  }

  const rl = checkRateLimit({ body: { login_username: username }, ip: req.ip }, 'banner');
  if (!rl.allowed && !fullAccess) {
    if (file) fs.unlink(file.path, () => {});
    return res.status(429).json({ success: false, message: rl.message || 'Limit request banner kamu sudah habis.' });
  }

  const id   = makeId();
  const time = getTime();

  const caption =
    `🖼️ <b>Request Banner (APK)</b>\n\n` +
    `<b>ID:</b> <code>#${id}</code>\n` +
    `<b>Dari:</b> ${escapeHtml(username)}\n` +
    (quote_text  ? `<b>Quote:</b> ${escapeHtml(quote_text)}\n`      : '') +
    (font_style  ? `<b>Font:</b> ${escapeHtml(font_style)}\n`       : '') +
    `\n⏰ ${time}` +
    `\n\n📌 <b>Status:</b> ⏳ (tunggu upload)`;

  const keyboard = uploadKeyboard(id);
  let r, tgChatId, tgMsgId;

  if (file) {
    try {
      r = await sendPhoto(file.path, caption, keyboard, { card: true });
    } catch (e) {
      console.warn('[mobile banner sendPhoto]', e.message);
      try {
        r = await sendDocument(file.path, caption, keyboard, undefined, { card: true });
      } catch (e2) {
        console.error('[mobile banner sendDocument]', e2.message);
      }
    }
    fs.unlink(file.path, () => {});
  } else {
    try { r = await sendMessage(caption, keyboard, { card: true }); } catch (e) { console.error('[mobile banner sendMessage]', e.message); }
  }

  tgChatId = r?.result?.chat?.id || null;
  tgMsgId  = r?.result?.message_id || null;
  const tgMsgObj = r?.result || null;

  if (!tgChatId || !tgMsgId) {
    return res.status(502).json({ success: false, message: 'Gagal mengirim banner ke Telegram. Coba lagi atau hubungi admin.' });
  }

  const copies = await broadcastToAdmins(tgChatId, tgMsgId, keyboard);
  const tgMsgs = [{ chatId: tgChatId, msgId: tgMsgId }, ...copies];

  const entry = {
    id, type: 'banner', requester: username, username,
    quote: quote_text || null, font: font_style || null,
    status: 'pending', stage: 'tunggu_upload', time, source: 'apk',
    tgChatId, tgMsgId, tgMsgs
  };
  writeLog(entry);
  triggerAutoUpload(id, tgMsgObj);   // mode /autoupload
  incrementCount('banner').catch(e => console.warn('[songSchedule increment mobile banner]', e.message));

  res.json({ success: true, message: 'Request banner berhasil dikirim!', id, time });
});

router.post('/api/mobile/request/:id/rating', (req, res) => {
  const { rating } = req.body;
  const val = parseInt(rating, 10);
  if (!val || val < 1 || val > 5) return res.status(400).json({ success: false, message: 'Rating tidak valid (1-5).' });
  const logs  = readLogs();
  const entry = logs.find(l => String(l.id) === String(req.params.id));
  if (!entry) return res.status(404).json({ success: false, message: 'Request tidak ditemukan.' });
  if (entry.status !== 'approved') return res.status(400).json({ success: false, message: 'Rating hanya untuk request yang sudah disetujui.' });
  if (entry.rating) return res.status(400).json({ success: false, message: 'Sudah pernah dirating.' });
  entry.rating = val;
  saveLogs(logs);
  if (val <= 2) sendMessage(`⭐ <b>Rating Rendah (APK)</b>\nRequest <code>#${entry.id}</code> (${escapeHtml(entry.requester)}) dirating <b>${val}/5</b>.`).catch(() => {});
  res.json({ success: true, rating: val });
});

router.get('/api/mobile/ticket/:id', (req, res) => {
  const ticket = findTicket(req.params.id);
  if (!ticket) return res.status(404).json({ success: false, message: 'Tiket tidak ditemukan.' });
  res.json({ success: true, ticket });
});

router.post('/api/mobile/ticket', async (req, res) => {
  const { name, username, message } = req.body;
  if (!name || !message) return res.status(400).json({ success: false, message: 'name & message wajib diisi.' });

  const id   = makeTicketId();
  const time = getTime();

  const caption =
    `🎫 <b>Tiket Baru (APK)</b>  <code>#${id}</code>\n\n` +
    `<b>Nama:</b> ${escapeHtml(name)}\n` +
    (username ? `<b>Username:</b> ${escapeHtml(username)}\n` : '') +
    `\n<b>Pesan:</b>\n${escapeHtml(message.trim())}\n\n` +
    `<i>${time} WIB</i>\n\n` +
    `<i>💬 Balas (reply) pesan ini di Telegram untuk membalas user.</i>`;

  const r       = await notifyAdmins(caption);
  const tgChatId = r?.result?.chat?.id || null;
  const tgMsgId  = r?.result?.message_id || null;

  const ticket = {
    id, status: 'open', name: name.trim(),
    username: username?.trim() || null,
    source  : 'apk',
    messages: [{ from: 'user', text: message.trim(), time, tgMsgId }],
    tgChatId, tgMsgId
  };
  const tickets = readTickets();
  tickets.push(ticket);
  saveTickets(tickets);

  res.json({ success: true, message: 'Tiket berhasil dibuat.', id });
});

router.post('/api/mobile/ticket/:id/message', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ success: false, message: 'message wajib diisi.' });
  const ticket = findTicket(req.params.id);
  if (!ticket) return res.status(404).json({ success: false, message: 'Tiket tidak ditemukan.' });
  if (ticket.status === 'closed') return res.status(400).json({ success: false, message: 'Tiket sudah ditutup.' });

  const time = getTime();
  const caption =
    `💬 <b>Pesan Tiket (APK)  <code>#${ticket.id}</code></b>\n` +
    `Dari: ${escapeHtml(ticket.name)}\n\n` +
    `${escapeHtml(message.trim())}\n\n<i>${time}</i>`;

  const r = await notifyAdmins(caption);
  ticket.messages.push({ from: 'user', text: message.trim(), time, tgMsgId: r?.result?.message_id || null });
  saveTicket(ticket);

  res.json({ success: true, message: 'Pesan terkirim.' });
});

router.post('/api/mobile/ticket/:id/close', (req, res) => {
  const ticket = findTicket(req.params.id);
  if (!ticket) return res.status(404).json({ success: false, message: 'Tiket tidak ditemukan.' });
  ticket.status = 'closed';
  saveTicket(ticket);
  res.json({ success: true });
});

module.exports = router;
