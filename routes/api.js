// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Routes — Endpoint REST API Website                   ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝

const express = require('express');
const path    = require('path');
const os      = require('os');
const fs      = require('fs');
const fetch   = require('node-fetch');
const CFG = require('../config');
const API = require('../apis');

const { uploadAudio, uploadImage, uploadVideo } = require('../lib/uploads');
const { getVideoDuration, MAX_DURATION_SEC: VIDEO_MAX_DURATION_SEC } = require('../lib/robloxVideo');
const { requireAdmin } = require('../lib/auth');
const {
  readLogs, saveLogs, writeLog, LOGS_FILE,
  isBanned, isIpBanned, recordUserIp, readReqStatus, readAppStatus, readAnnounce,
  makeTicketId, findTicket, saveTicket,
  readChatMode, writeChatMode, activeGroupId
} = require('../lib/store');
const { RATE_LIMITS, RATE_WINDOW, readRates, readBonus, getBonus, checkRateLimit, checkVideoLimit, VIDEO_COOLDOWN_MS, VIDEO_WINDOW_MS, refundRateLimit, isUnlimited, recordDurationViolation, checkSubmitCooldown, markSubmitted } = require('../lib/ratelimit');
const { canBypassSessionGate, canBypassAppMode, getRole, roleTitle, getDisplayName, isVvip, isPremium, roleLimit, VVIP_RESET_MS } = require('../lib/roles');
const { getTime, makeId, sanitizeFilename, escapeHtml, sanitizeTitle } = require('../lib/util');
const {
  accRejKeyboard, uploadKeyboard, sendMessage, sendAudio, sendDocument, sendPhoto,
  broadcastToAdmins, notifyAdmins
} = require('../lib/telegram');
const { neosoftYtDownload, downloadDirectUrl, getAudioDuration, reencodeToMp3 } = require('../lib/audio');
const { tmpPath, ensureBudget, uploadsHasRoom, respondServerError } = require('../lib/tempdir');
const { triggerAutoUpload } = require('../bot/robloxAudioRequest');   // mode /autoupload
const { getPrivateIds, markAllSeen, countUnseen, formatPrivateIdsAsTxt } = require('../lib/privateInbox');
const { incrementSongSession, incrementCount, readSongSession } = require('../lib/songSchedule');

const router = express.Router();

// Kalau akun dev yang request, otomatis aktifkan mode "Group Allowed" secara GLOBAL
// (persis seperti command /grouponly) — jadi berlaku untuk SEMUA user & request
// berikutnya, bukan cuma request dev ini. Tidak melakukan apa-apa kalau mode
// sudah 'group', atau kalau admin belum pernah set grup tujuan sama sekali.
function autoEnableGroupOnlyIfNeeded(login_username) {
  if (!isUnlimited(login_username)) return;
  if (readChatMode().mode === 'group') return;
  if (!activeGroupId()) return;
  writeChatMode({ mode: 'group' });
  notifyAdmins(
    '🔓 <b>Mode otomatis diubah ke Group Allowed</b> (dipicu oleh request dev).\n\n' +
    `Mulai sekarang, request lagu &amp; banner serta tiket CS otomatis ikut dibroadcast ke grup <code>${activeGroupId()}</code> — berlaku untuk SEMUA user, sama seperti kalau admin ketik /grouponly.\n\n` +
    '<i>Ketik /privatonly kapan aja buat balikin ke mode private-only.</i>'
  ).catch(() => {});
}

// MAINTENANCE berdampak ke SEMUA user termasuk VIP/VVIP (cuma admin/owner/dev yang
// bebas). Dicek DI SERVER, bukan cuma overlay di frontend -- biar gak bisa
// ditembus lewat panggil API langsung. Halaman "ID Saya" & tiket CS sengaja gak
// lewat sini, jadi tetap bisa dipakai saat maintenance.
function blockIfMaintenance(username, file, res) {
  const st = readAppStatus();
  if (st.mode !== 'maintenance' || isUnlimited(username)) return false;
  if (file) fs.unlink(file.path, () => {});
  res.status(503).json({ success: false, maintenance: true, message: st.message || 'Website sedang maintenance. Coba lagi nanti.' });
  return true;
}

// Ban per-IP (lihat lib/store.js) -- beda dari isBanned(username) di atas, ini nempel ke
// perangkat/jaringannya. Dicek PALING DEPAN, sebelum apapun lain, jadi ganti akun/username
// berapa kali pun tetap ketolak selama masih dari IP yang sama.
function blockIfIpBanned(req, res, file) {
  const ban = isIpBanned(req.ip);
  if (!ban) return false;
  if (file) fs.unlink(file.path, () => {});
  res.status(403).json({ success: false, message: `Kamu diblokir dari fitur request. Alasan: ${ban.reason || 'tidak disebutkan'}. Hubungi admin via menu Tiket.` });
  return true;
}

router.post('/api/request', uploadAudio.single('song_file'), async (req, res) => {
  try {
    const { requester_name, song_title, song_link, login_username } = req.body;
    const file = req.file;
    recordUserIp(login_username, req.ip);
    if (blockIfIpBanned(req, res, file)) return;
    if (blockIfMaintenance(login_username, file, res)) return;

    if (!requester_name?.trim()) return res.status(400).json({ success: false, message: 'Nama pemohon wajib diisi.' });
    if (!song_title?.trim())     return res.status(400).json({ success: false, message: 'Judul lagu wajib diisi.' });
    if (!file && !song_link?.trim()) return res.status(400).json({ success: false, message: 'Harap unggah file lagu atau masukkan link lagu.' });

    const ban = isBanned(login_username);
    if (ban && !isUnlimited(login_username)) return res.status(403).json({ success: false, message: `Kamu diblokir dari fitur request. Alasan: ${ban.reason || 'tidak disebutkan'}. Hubungi admin via menu Tiket.` });

    autoEnableGroupOnlyIfNeeded(login_username);

    const reqStat = readReqStatus();
    if (reqStat.lagu?.enabled === false && !canBypassSessionGate(login_username))
      return res.status(503).json({ success: false, message: reqStat.lagu.message || 'Request lagu sedang ditutup oleh admin.' });

    const rl = checkRateLimit(req, 'song');
    if (!rl.allowed) return res.status(429).json({ success: false, message: rl.message });

    // Anti-spam ke provider #1: cooldown antar submit -- dicek SEBELUM apapun
    // yang nyentuh provider, biar spam-klik gak sempet nembak API sama sekali.
    const cooldownCheck = checkSubmitCooldown(req);
    if (!cooldownCheck.allowed) {
      if (login_username) refundRateLimit(login_username, 'song'); // gak jadi kepake limitnya, ini cuma ditolak cooldown
      return res.status(429).json({ success: false, message: cooldownCheck.message });
    }

    // Pengecekan "antrian penuh" DIHAPUS atas permintaan -- sekarang gerbang
    // satu-satunya buat request lagu cuma limit personal (di atas) + kuota
    // global sesi (lib/songSchedule.js). Gak ada lagi penolakan gara-gara
    // banyak request pending nunggu di-ACC admin.
    //
    // Duplikat link (pending/approved) sekarang DITOLAK LANGSUNG di sini (lihat
    // di atas), gak lagi cuma dikasih "warning tapi tetep lanjut" kayak
    // sebelumnya -- biar link yang sama gak nyoba di-download 2x dari provider.
    if (song_link?.trim()) {
      const dupEntry = readLogs().find(l =>
        l.link && l.link === song_link.trim() &&
        ['pending', 'approved'].includes(l.status)
      );
      if (dupEntry) {
        if (login_username) refundRateLimit(login_username, 'song');
        return res.status(409).json({
          success: false,
          message: `Link ini sudah pernah di-request (status: ${dupEntry.status === 'approved' ? 'sudah di-ACC' : 'masih pending'}). Cek di tab "Request Saya" ya, jangan kirim link yang sama berulang.`,
          duplicateId: dupEntry.id
        });
      }
    }

    markSubmitted(req); // dari titik ini request beneran diproses -- cooldown mulai dihitung dari sekarang

    let ytDownloadedPath = null;
    let ytInfo = null;
    let ytFailure = null;   // error terakhir dari auto-download (buat bedain "link mati" vs "provider bermasalah")
    if (!file && song_link?.trim()) {
      const isYt     = /youtu\.?be|youtube\.com/i.test(song_link.trim());
      const isDirect = !isYt && /^https?:\/\//i.test(song_link.trim());
      // Cek tempat dulu (file hasil download bisa sampai belasan MB + file antara dari provider)
      ensureBudget(60 * 1024 * 1024, 'download audio YouTube');
      const tmpOut   = tmpPath(`yt_${makeId()}.mp3`);
      if (isYt) {
        try {
          ytInfo = await neosoftYtDownload(song_link.trim(), tmpOut);
          if (fs.existsSync(tmpOut)) ytDownloadedPath = tmpOut;
        } catch (ytErr) {
          ytFailure = ytErr;
          console.error('[Neosoft Downloader]', ytErr.message);
        }
      } else if (isDirect) {
        try {
          await downloadDirectUrl(song_link.trim(), tmpOut);
          if (fs.existsSync(tmpOut)) ytDownloadedPath = tmpOut;
          ytInfo = { title: null };
        } catch (dlErr) {
          console.error('[Direct Downloader]', dlErr.message);
        }
      }
    }

    const displayTitle = (ytDownloadedPath && ytInfo?.title) ? ytInfo.title : song_title.trim();

    // Semua provider gagal download audio dari link (YouTube maupun direct URL)
    // -- daripada bikin request "nyangkut" nunggu admin proses padahal gak ada
    // file yang bisa diupload ke Roblox sama sekali, auto-reject aja & minta
    // user coba lagi. Limit personalnya juga dikembalikan (gak adil dipotong
    // gara-gara link/providernya yang bermasalah, bukan salah user).
    if (!file && !ytDownloadedPath) {
      if (login_username) refundRateLimit(login_username, 'song');
      const id = makeId();
      const time = getTime();
      writeLog({
        id, type: 'song', status: 'rejected', stage: 'gagal',
        requester: requester_name.trim(), username: login_username?.trim() || null,
        title: displayTitle, link: song_link?.trim() || null,
        hasFile: false, time, tgChatId: null, tgMsgId: null, tgMsgs: []
      });
      // Info doang ke admin (tanpa tombol -- gak ada file yang bisa diupload)
      sendMessage(
        `<b>⚠️ Auto-download Gagal</b>  <code>#${id}</code>\n\n` +
        `<b>Dari  :</b> ${escapeHtml(requester_name.trim())}\n` +
        `<b>Judul :</b> <code>${escapeHtml(displayTitle)}</code>\n` +
        (song_link ? `<b>Link  :</b> ${escapeHtml(song_link.trim())}\n` : '') +
        `\n<i>${time} WIB</i>\n\n` +
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

    // ── Validasi durasi: maksimal 7 menit ──────────────────────────────────
    // Cek FILE ASLINYA (bukan cuma data dari provider yang kadang gak akurat/
    // gak ada) -- berlaku buat file upload langsung MAUPUN hasil auto-download.
    // Pelanggaran ke-1: ditolak doang. Pelanggaran ke-2 dst: ditolak + limit
    // song-nya dikurangi 1 PERMANEN (sampai admin reset manual).
    const MAX_DURATION_SEC = 7 * 60;
    {
      const checkPath = file ? file.path : ytDownloadedPath;
      if (checkPath) {
        let durationSec = null;
        // Hasil auto-download udah di-probe sekali di lib/audio.js -- pakai lagi durasinya,
        // gak perlu ffprobe ulang (lebih cepat). File upload langsung tetap di-probe di sini.
        if (!file && ytInfo?.probedDuration) durationSec = ytInfo.probedDuration;
        else { try { durationSec = await getAudioDuration(checkPath); } catch (e) { console.warn('[DurationCheck]', e.message); } }
        if (durationSec && durationSec > MAX_DURATION_SEC) {
          if (file) fs.unlink(file.path, () => {});
          if (ytDownloadedPath) fs.unlink(ytDownloadedPath, () => {});
          if (login_username) refundRateLimit(login_username, 'song'); // percobaan ini sendiri gak dihitung kepake

          const { count, penalized } = recordDurationViolation(login_username);
          const id = makeId();
          const time = getTime();
          const menit = (durationSec / 60).toFixed(1);
          writeLog({
            id, type: 'song', status: 'rejected', stage: 'gagal',
            requester: requester_name.trim(), username: login_username?.trim() || null,
            title: displayTitle, link: song_link?.trim() || null,
            hasFile: false, time, tgChatId: null, tgMsgId: null, tgMsgs: []
          });
          sendMessage(
            `<b>⚠️ Lagu Terlalu Panjang</b>  <code>#${id}</code>\n\n` +
            `<b>Dari  :</b> ${escapeHtml(requester_name.trim())}\n` +
            `<b>Judul :</b> <code>${escapeHtml(displayTitle)}</code>\n` +
            `<b>Durasi:</b> ${menit} menit (maks 7 menit)\n` +
            `\n<i>${time} WIB</i>\n\n` +
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
    }

    // ── Paksa MP3 standar buat FILE YANG DIUPLOAD LANGSUNG ───────────────────
    // Hasil auto-download dari link (ytDownloadedPath) UDAH PASTI mp3 standar
    // (di-reencode paksa di dalam lib/audio.js sebelum sampai sini). Tapi file
    // yang diupload user sendiri (multer) belum pernah lewat proses itu --
    // kalau dibiarin, orang bisa upload M4A/OGG/WAV yang di-rename .mp3 doang,
    // dan itu yang bikin Roblox nolak "Invalid file type". Samain perlakuannya
    // di sini biar SEMUA jalur (link ATAUPUN upload manual) dijamin MP3 asli.
    if (file) {
      try {
        await reencodeToMp3(file.path);
      } catch (reencodeErr) {
        fs.unlink(file.path, () => {});
        if (login_username) refundRateLimit(login_username, 'song');
        console.error('[ReencodeCheck]', reencodeErr.message);
        return res.json({
          success: false,
          message: 'File yang kamu upload gagal dikonversi ke format MP3 (kemungkinan file rusak/bukan audio valid). Limit kamu udah dikembalikan — coba upload ulang pakai file MP3 lain.'
        });
      }
    }

    const id      = makeId();
    const time    = getTime();
    const keyboard = uploadKeyboard(id);

    let tgChatId = null, tgMsgId = null, tgMsgObj = null;

    const caption = `<b>Roblox Song Request</b>  <code>#${id}</code>\n\n` +
      `<b>Dari  :</b> ${escapeHtml(requester_name.trim())}\n` +
      `<b>Judul :</b> <code>${escapeHtml(displayTitle)}</code>\n` +
      (song_link && !file ? `<b>Link  :</b> ${escapeHtml(song_link.trim())}\n` : '') +
      `\n<i>${time} WIB</i>\n\n<i>— by wanz</i>`;
    const statusLine = '\n\n📌 <b>Status:</b> ⏳ (tunggu upload)';

    {
      const sendPath = file ? file.path : ytDownloadedPath;
      const captionFinal = caption + (ytDownloadedPath ? '\n<i>(Auto-download dari YouTube ✅)</i>' : '') + statusLine;

      const audioExt = path.extname(sendPath) || '.mp3';
      const audioFilename = file
        ? sanitizeFilename(path.basename(file.originalname, path.extname(file.originalname)), audioExt)
        : sanitizeFilename(displayTitle, audioExt);

      let r;
      try { r = await sendAudio(sendPath, captionFinal, keyboard, audioFilename, { card: true }); } catch { r = await sendDocument(sendPath, captionFinal, keyboard, audioFilename, { card: true }); }
      tgChatId = r?.result?.chat?.id; tgMsgId = r?.result?.message_id; tgMsgObj = r?.result || null;
      if (file)              fs.unlink(file.path, () => {});
      if (ytDownloadedPath)  fs.unlink(ytDownloadedPath, () => {});
    }

    const queuePosition = readLogs().filter(l => l.status === 'pending').length + 1;

    const tgMsgsInit = tgChatId && tgMsgId ? [{ chatId: String(tgChatId), msgId: tgMsgId }] : [];
    writeLog({
      id, type: 'song', status: 'pending', stage: 'tunggu_upload',
      requester: requester_name.trim(), username: login_username?.trim() || null,
      title: displayTitle, link: song_link?.trim() || null,
      hasFile: !!file, time, tgChatId, tgMsgId, tgMsgs: tgMsgsInit
    });
    triggerAutoUpload(id, tgMsgObj);   // mode /autoupload: langsung upload tanpa nunggu tombol admin
    if (!isUnlimited(login_username)) {
      incrementSongSession().catch(e => console.warn('[songSchedule increment]', e.message));
    }
    res.json({
      success: true,
      message: 'Request berhasil dikirim!',
      id,
      queuePosition,
      resetAt: rl.resetAt
    });

    if (tgChatId && tgMsgId) {
      broadcastToAdmins(tgChatId, tgMsgId, keyboard).then(copies => {
        if (!copies.length) return;
        const logs = readLogs();
        const entry = logs.find(l => String(l.id) === String(id));
        if (entry) { entry.tgMsgs = [...tgMsgsInit, ...copies]; saveLogs(logs); }
      }).catch(e => console.warn('[broadcast song]', e.message));
    }

  } catch (err) {
    console.error('[Song Error]', err);
    refundRateLimit(req.body?.login_username, 'song');
    respondServerError(res, err);
  }
});

router.post('/api/banner', uploadImage.single('banner_image'), async (req, res) => {
  try {
    const { requester_name, login_username, banner_image_url } = req.body;
    const file = req.file;
    recordUserIp(login_username, req.ip);
    if (blockIfIpBanned(req, res, file)) return;
    if (blockIfMaintenance(login_username, file, res)) return;

    if (!requester_name?.trim())   return res.status(400).json({ success: false, message: 'Nama pemohon wajib diisi.' });

    const ban = isBanned(login_username);
    if (ban && !isUnlimited(login_username)) return res.status(403).json({ success: false, message: `Kamu diblokir dari fitur request. Alasan: ${ban.reason || 'tidak disebutkan'}. Hubungi admin via menu Tiket.` });

    autoEnableGroupOnlyIfNeeded(login_username);

    const reqStat = readReqStatus();
    if (reqStat.banner?.enabled === false && !canBypassSessionGate(login_username))
      return res.status(503).json({ success: false, message: reqStat.banner.message || 'Request banner sedang ditutup oleh admin.' });

    const rl = checkRateLimit(req, 'banner');
    if (!rl.allowed) return res.status(429).json({ success: false, message: rl.message });

    // Sama kayak request lagu: pengecekan antrian penuh dihapus, cuma pakai
    // limit personal + kuota global.

    // Fallback kalau tombol upload file gak bisa dibuka (misal di WebView APK
    // yang gak support file chooser) — user tempel link gambar, kita yang download.
    let urlDownloadedPath = null;
    if (!file && banner_image_url?.trim() && /^https?:\/\//i.test(banner_image_url.trim())) {
      try {
        const ext = (path.extname(banner_image_url.trim().split('?')[0]) || '.jpg').slice(0, 5);
        ensureBudget(15 * 1024 * 1024, 'gambar banner');
        const tmpImg = tmpPath(`banner_${makeId()}${ext}`);
        await downloadDirectUrl(banner_image_url.trim(), tmpImg);
        if (fs.existsSync(tmpImg)) urlDownloadedPath = tmpImg;
      } catch (dlErr) {
        console.error('[Banner URL Download]', dlErr.message);
      }
    }

    const id      = makeId();
    const time    = getTime();
    const caption = `<b>Roblox Banner Request</b>  <code>#${id}</code>\n\n` +
      `<b>Dari     :</b> ${escapeHtml(requester_name.trim())}\n` +
      (urlDownloadedPath ? `<i>(Dari link gambar)</i>\n` : '') +
      `\n<i>${time} WIB</i>\n\n<i>— by wanz</i>\n\n` +
      `📌 <b>Status:</b> ⏳ (tunggu upload)`;
    const keyboard = uploadKeyboard(id);

    let tgChatId = null, tgMsgId = null, tgMsgObj = null;
    const imgPath = file ? file.path : urlDownloadedPath;
    if (imgPath) {
      let r;
      try { r = await sendPhoto(imgPath, caption, keyboard, { card: true }); } catch { r = await sendDocument(imgPath, caption, keyboard, undefined, { card: true }); }
      tgChatId = r?.result?.chat?.id; tgMsgId = r?.result?.message_id; tgMsgObj = r?.result || null;
      if (file)               fs.unlink(file.path, () => {});
      if (urlDownloadedPath)  fs.unlink(urlDownloadedPath, () => {});
    } else {
      const r = await sendMessage(caption, keyboard, { card: true });
      tgChatId = r?.result?.chat?.id; tgMsgId = r?.result?.message_id; tgMsgObj = r?.result || null;
    }

    const tgMsgsInit = tgChatId && tgMsgId ? [{ chatId: String(tgChatId), msgId: tgMsgId }] : [];

    const queuePosition = readLogs().filter(l => l.status === 'pending').length + 1;

    writeLog({
      id, type: 'banner', status: 'pending', stage: 'tunggu_upload',
      requester: requester_name.trim(), username: login_username?.trim() || null,
      hasImage: !!file || !!urlDownloadedPath, time, tgChatId, tgMsgId, tgMsgs: tgMsgsInit
    });
    triggerAutoUpload(id, tgMsgObj);   // mode /autoupload
    if (!isUnlimited(login_username)) {
      incrementCount('banner').catch(e => console.warn('[songSchedule increment banner]', e.message));
    }
    res.json({ success: true, message: 'Request banner berhasil dikirim!', id, queuePosition, resetAt: rl.resetAt });

    if (tgChatId && tgMsgId) {
      broadcastToAdmins(tgChatId, tgMsgId, keyboard).then(copies => {
        if (!copies.length) return;
        const logs = readLogs();
        const entry = logs.find(l => String(l.id) === String(id));
        if (entry) { entry.tgMsgs = [...tgMsgsInit, ...copies]; saveLogs(logs); }
      }).catch(e => console.warn('[broadcast banner]', e.message));
    }

  } catch (err) {
    console.error('[Banner Error]', err);
    refundRateLimit(req.body?.login_username, 'banner');
    respondServerError(res, err);
  }
});

// ── /api/video — request "video" (Roblox video berbayar, jadi dipecah jadi
// banyak klip gambar yang diproses admin lewat tombol "Upload ke Roblox" yang
// sama, lib/robloxVideo.js yang urus pecah+upload semua klipnya). SENGAJA
// nebeng kuota "banner" (bukan kategori limit baru sendiri) biar lebih
// simpel -- video jauh lebih jarang dipakai drpd banner/lagu.
router.post('/api/video', uploadVideo.single('video_file'), async (req, res) => {
  try {
    const { requester_name, login_username, video_title } = req.body;
    const file = req.file;
    recordUserIp(login_username, req.ip);
    if (blockIfIpBanned(req, res, file)) return;
    if (blockIfMaintenance(login_username, file, res)) return;
    // Video disimpan di uploads/ sampai admin memprosesnya -- kalau foldernya sudah melewati
    // batas (UPLOADS_MAX_MB) dan gak ada sisa/yatim yang bisa dibersihkan, tolak dulu
    // (sebelum limit harian kepakai) daripada bikin server kehabisan tempat.
    if (file && !uploadsHasRoom()) {
      fs.unlink(file.path, () => {});
      return res.status(503).json({ success: false, message: 'Penyimpanan server sedang penuh, video belum bisa diterima. Coba lagi beberapa saat lagi ya (admin sudah diberi tahu). Limit kamu tidak terpakai.' });
    }

    if (!requester_name?.trim()) return res.status(400).json({ success: false, message: 'Nama pemohon wajib diisi.' });
    if (!file) return res.status(400).json({ success: false, message: 'File video wajib diupload.' });

    // Validasi DURASI di awal (bukan ukuran MB) -- ukuran file cuma dibatasi
    // 60 MB oleh multer (lib/uploads.js), selama di bawah itu video BOLEH
    // masuk. Yang jadi patokan adalah durasinya (maks VIDEO_MAX_DURATION_SEC).
    // Dicek SEBELUM limit harian kepakai, jadi video yang kepanjangan gak
    // ngabisin jatah user. Kalau ffprobe gagal baca, dilewati (admin-side di
    // lib/robloxVideo.js tetap ngecek lagi pas upload).
    let videoDurationSec = null;
    try { videoDurationSec = await getVideoDuration(file.path); }
    catch (e) { console.warn('[VideoDurationCheck]', e.message); }
    if (videoDurationSec && videoDurationSec > VIDEO_MAX_DURATION_SEC) {
      fs.unlink(file.path, () => {});
      return res.status(400).json({
        success: false,
        message: `Video ini durasinya ${videoDurationSec.toFixed(1)} detik, melebihi batas maksimal ${VIDEO_MAX_DURATION_SEC} detik. Pendekin videonya dulu (ukuran file boleh sampai 60 MB).`
      });
    }

    const ban = isBanned(login_username);
    if (ban && !isUnlimited(login_username)) return res.status(403).json({ success: false, message: `Kamu diblokir dari fitur request. Alasan: ${ban.reason || 'tidak disebutkan'}. Hubungi admin via menu Tiket.` });

    autoEnableGroupOnlyIfNeeded(login_username);

    const reqStat = readReqStatus();
    if (reqStat.banner?.enabled === false && !canBypassSessionGate(login_username))
      return res.status(503).json({ success: false, message: reqStat.banner.message || 'Request video sedang ditutup oleh admin.' });

    const rl = checkVideoLimit(login_username?.trim());
    if (!rl.allowed) return res.status(rl.locked ? 403 : 429).json({ success: false, message: rl.message, locked: !!rl.locked });

    const title = (video_title?.trim() || file.originalname || 'Video Tron').slice(0, 80);
    const id      = makeId();
    const time    = getTime();
    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    const caption = `<b>Roblox Video Tron</b>  <code>#${id}</code>\n\n` +
      `<b>Dari     :</b> ${escapeHtml(requester_name.trim())}\n` +
      `<b>Judul    :</b> ${escapeHtml(title)}\n` +
      `<b>Video    :</b> ${sizeMb} MB` + (videoDurationSec ? ` • ${videoDurationSec.toFixed(1)} detik` : '') + `\n` +
      `\n<i>${time} WIB</i>\n\n<i>— by wanz</i>\n\n` +
      `⚠️ <i>Video bakal dipecah jadi banyak klip gambar (bukan video asli) -- proses bisa makan waktu lebih lama drpd audio/banner biasa.</i>\n\n` +
      `📌 <b>Status:</b> ⏳ (tunggu upload)`;
    const keyboard = uploadKeyboard(id);

    // File video DISIMPAN di disk server sampai admin memprosesnya (path-nya
    // dicatat di log: videoPath). Alasannya: Bot API Telegram cuma ngizinin
    // bot DOWNLOAD file sampai 20 MB, jadi kalau file diambil balik dari
    // Telegram, video 21-60 MB selalu gagal ("file is too big"). Kirim ke
    // Telegram juga cuma bisa sampai ~50 MB, jadi video yang lebih gede dari
    // TG_SEND_MAX_BYTES gak dilampirin -- kartunya berupa teks doang, file
    // aslinya tetap ada di server.
    const TG_SEND_MAX_BYTES = 45 * 1024 * 1024;
    let r = null;
    if (file.size <= TG_SEND_MAX_BYTES) {
      try { r = await sendDocument(file.path, caption, keyboard, undefined, { card: true }); }
      catch (e) { console.warn('[Video] kirim dokumen ke Telegram gagal, pakai kartu teks:', e.message); }
    }
    if (!r?.ok) {
      const note = file.size > TG_SEND_MAX_BYTES
        ? `\n📎 <i>Video (${sizeMb} MB) gak dilampirin di sini karena kegedean buat dikirim lewat Telegram -- file aslinya aman tersimpan di server & tetap diproses lewat tombol Upload.</i>`
        : `\n📎 <i>Video gagal dilampirin ke Telegram -- file aslinya tersimpan di server & tetap diproses lewat tombol Upload.</i>`;
      try { r = await sendMessage(caption + note, keyboard, { card: true }); }
      catch (e) { console.warn('[Video] kirim kartu teks gagal:', e.message); }
    }
    if (!r?.ok) {
      fs.unlink(file.path, () => {});
      throw new Error('Gagal kirim kartu request video ke Telegram: ' + (r?.description || 'tanpa respon'));
    }
    const tgChatId = r?.result?.chat?.id, tgMsgId = r?.result?.message_id;
    const tgMsgObj = r?.result || null;
    const tgMsgsInit = tgChatId && tgMsgId ? [{ chatId: String(tgChatId), msgId: tgMsgId }] : [];

    const queuePosition = readLogs().filter(l => l.status === 'pending').length + 1;

    writeLog({
      id, type: 'video', status: 'pending', stage: 'tunggu_upload', title,
      requester: requester_name.trim(), username: login_username?.trim() || null,
      hasImage: true, time, tgChatId, tgMsgId, tgMsgs: tgMsgsInit,
      videoPath: file.path
    });
    triggerAutoUpload(id, tgMsgObj);   // mode /autoupload
    res.json({ success: true, message: 'Request video berhasil dikirim!', id, queuePosition, resetAt: rl.resetAt });

    if (tgChatId && tgMsgId) {
      broadcastToAdmins(tgChatId, tgMsgId, keyboard).then(copies => {
        if (!copies.length) return;
        const logs = readLogs();
        const entry = logs.find(l => String(l.id) === String(id));
        if (entry) { entry.tgMsgs = [...tgMsgsInit, ...copies]; saveLogs(logs); }
      }).catch(e => console.warn('[broadcast video]', e.message));
    }

  } catch (err) {
    console.error('[Video Error]', err);
    refundRateLimit(req.body?.login_username, 'video');
    respondServerError(res, err);
  }
});

router.get('/api/limits', (req, res) => {
  const username = req.query.username?.trim();
  const key = username ? `u:${username.toLowerCase()}` : `ip:${req.ip}`;
  const rates = readRates();
  const bucket = rates[key] || {};
  const unlimited = isUnlimited(username);

  function info(type) {
    if (unlimited) {
      return { limit: Infinity, used: 0, remaining: Infinity, resetInMs: 0, windowMs: RATE_WINDOW, unlimited: true };
    }
    if (isPremium(username)) {
      // VVIP: limit TETAP (10 lagu/5 banner), reset SEKALI SEHARI (24 jam),
      // bukan permanen-sampai-sesi-dibuka kayak member biasa.
      const cutoff = Date.now() - VVIP_RESET_MS;
      const hits = (bucket[type] || []).filter(t => t > cutoff);
      const limit = roleLimit(username, type);
      const remaining = Math.max(0, limit - hits.length);
      const oldest = hits.length ? Math.min(...hits) : null;
      const resetInMs = oldest ? Math.max(0, (oldest + VVIP_RESET_MS) - Date.now()) : 0;
      return { limit, used: hits.length, remaining, resetInMs, windowMs: VVIP_RESET_MS, resetMode: 'daily' };
    }
    const limit = RATE_LIMITS[type] + getBonus(username, type);
    // Tidak ada lagi expiry berbasis waktu — limit cuma reset saat sesi
    // request global dibuka lagi, atau direset manual oleh admin.
    const hits = bucket[type] || [];
    const remaining = Math.max(0, limit - hits.length);
    return { limit, used: hits.length, remaining, resetInMs: 0, windowMs: RATE_WINDOW, resetMode: 'session' };
  }

  function globalInfo(type) {
    const t = songSession[type];
    if (!t || t.quota == null) return null; // sesi ini gak pakai kuota global buat tipe ini
    return { active: t.active, label: songSession.label || null, quota: t.quota, count: t.count };
  }
  const songSession = readSongSession();

  // Video Tron: aturan sendiri (2x/24 jam + jeda 2 jam antar-request, cuma
  // VVIP/admin/owner) -- gak cocok masuk fungsi info() generik di atas
  // (yang logic-nya buat song/banner), jadi dihitung terpisah di sini.
  // Kalau non-VVIP (dikunci), sengaja return null -- panel-nya emang udah
  // dikunci total di frontend, gak perlu nampilin angka limit yang
  // menyesatkan (bukan soal "kuota abis", tapi emang gak boleh akses).
  function videoInfo() {
    if (isUnlimited(username)) return { limit: Infinity, used: 0, remaining: Infinity, resetInMs: 0, windowMs: VIDEO_WINDOW_MS, unlimited: true };
    if (!isPremium(username)) return null;

    const vKey = username ? `u:${username.toLowerCase()}` : null;
    const vBucket = vKey ? (rates[vKey] || {}) : {};
    const hits = (vBucket.video || []).filter(t => t > Date.now() - VIDEO_WINDOW_MS);
    const maxPerDay = roleLimit(username, 'video');

    let resetInMs = 0;
    let windowMs  = VIDEO_WINDOW_MS;
    if (hits.length >= maxPerDay) {
      // Kuota harian abis -- reset sebenarnya nunggu window 24 jam abis
      // pakai yang TERTUA (ini SELALU lebih lama drpd cooldown 2 jam, jadi
      // dicek duluan -- jangan kebalik nunjukin cooldown yang lebih pendek
      // padahal kuota hariannya sendiri masih abis).
      const oldest = Math.min(...hits);
      resetInMs = Math.max(0, (oldest + VIDEO_WINDOW_MS) - Date.now());
      windowMs  = VIDEO_WINDOW_MS;
    } else if (hits.length) {
      // Kuota masih ada sisa, tapi lagi kena jeda 2 jam dari pemakaian terakhir.
      const lastHit = Math.max(...hits);
      const sinceLast = Date.now() - lastHit;
      if (sinceLast < VIDEO_COOLDOWN_MS) {
        resetInMs = VIDEO_COOLDOWN_MS - sinceLast;
        windowMs  = VIDEO_COOLDOWN_MS;
      }
    }
    const remaining = Math.max(0, maxPerDay - hits.length);
    // Chip cuma nampilin "bisa dipakai SEKARANG" (maks 1), BUKAN sisa kuota
    // harian mentah-mentah -- soalnya walau kuotanya 2x/hari, gara-gara jeda
    // 2 jam gak akan pernah bisa kepake 2-2nya sekaligus. Nampilin "2/2"
    // pas belum kepake sama sekali bikin kesan salah kayak bisa langsung
    // dipakai 2x beruntun. Jadi cuma ada 2 kemungkinan tampilan: "1/2"
    // (boleh pakai sekarang) atau "0/2" (lagi nunggu jeda/kuota abis).
    const displayRemaining = resetInMs > 0 ? 0 : Math.min(1, remaining);
    return { limit: maxPerDay, used: hits.length, remaining: displayRemaining, resetInMs, windowMs };
  }

  res.json({
    success: true,
    song: info('song'), banner: info('banner'), video: videoInfo(),
    globalSong: globalInfo('song'), globalBanner: globalInfo('banner')
  });
});

router.get('/api/lyrics', async (req, res) => {
  const title = (req.query.q || '').trim();
  if (!title) return res.status(400).json({ success: false, message: 'Judul wajib diisi.' });
  
  try {
    const url = `${API.DANZY_SEARCH_PLAY}?q=${encodeURIComponent(title)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return res.status(404).json({ success: false, message: 'Lirik tidak ditemukan.' });
    
    const d = await r.json();
    if (!Array.isArray(d) || !d.length) 
      return res.status(404).json({ success: false, message: 'Lirik tidak ditemukan.' });
    
    const song = d[0];
    res.json({
      success: true,
      title: song.title || title,
      artist: song.artist || '',
      lyrics: song.lyrics || song.lyric || ''
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Gagal mengambil lirik: ' + e.message });
  }
});

router.get('/api/yt/filename', async (req, res) => {
  const url = (req.query.url || '').trim();
  console.log('[yt/filename] Request:', url);
  
  if (!url) {
    console.log('[yt/filename] URL kosong');
    return res.status(400).json({ success: false, message: 'URL wajib diisi.' });
  }
  
  try {
    // Catatan: provider Danzy (api.danzy.web.id) udah mati (DNS ENOTFOUND) —
    // dulu dicoba duluan di sini tapi cuma nambah delay nunggu gagal.
    // Sekarang langsung oEmbed resmi YouTube aja, jauh lebih cepat & reliable.
    let fullUrl = url;
    if (url.includes('youtu.be/')) {
      const vid = url.split('youtu.be/')[1]?.split(/[?&]/)[0];
      if (vid) fullUrl = `https://www.youtube.com/watch?v=${vid}`;
    }
    
    const oembed = await fetch(
      `${API.YOUTUBE_OEMBED}?url=${encodeURIComponent(fullUrl)}&format=json`,
      { signal: AbortSignal.timeout(8000) }
    );
    
    console.log('[yt/filename] oEmbed status:', oembed.status);
    
    if (oembed.ok) {
      const od = await oembed.json();
      if (od.title) {
        const cleanTitle = sanitizeTitle(od.title).slice(0, 100);
        console.log('[yt/filename] oEmbed title:', od.title.slice(0, 50), '-> clean:', cleanTitle);
        return res.json({ success: true, title: cleanTitle });
      }
    }
    
    const vid = url.split('youtu.be/')[1]?.split(/[?&]/)[0] || 
                url.split('v=')[1]?.split('&')[0];
    const fallbackTitle = vid ? `Video ${vid}` : 'Lagu dari YouTube';
    console.log('[yt/filename] Fallback title:', fallbackTitle);
    res.json({ success: true, title: fallbackTitle });
    
  } catch (e) {
    console.error('[yt/filename] ERROR:', e.message);
    res.json({ 
      success: true,
      title: 'Lagu dari YouTube'
    });
  }
});

router.get('/api/yt/info', async (req, res) => {
  let url = (req.query.url || '').trim();
  if (!url) return res.status(400).json({ success: false, message: 'URL wajib diisi.' });
  
  if (url.includes('youtu.be/')) {
    const vid = url.split('youtu.be/')[1]?.split(/[?&]/)[0];
    if (vid) url = `https://www.youtube.com/watch?v=${vid}`;
  }
  
  try {
    const r = await fetch(
      `${API.YOUTUBE_OEMBED}?url=${encodeURIComponent(url)}&format=json`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return res.status(404).json({ success: false, message: 'Video tidak ditemukan atau URL tidak valid.' });
    const d = await r.json();
    res.json({ success: true, title: sanitizeTitle(d.title || ''), author: d.author_name || '' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Gagal mengambil info video: ' + e.message });
  }
});

router.get('/api/yt/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ success: false, message: 'Query kosong.' });
  try {
    const r = await fetch(`${API.NANZZ_YTMUSIC_SEARCH}?q=${encodeURIComponent(q)}`, { timeout: 12000 });
    if (!r.ok) throw new Error('Nanzz ytmusic API HTTP ' + r.status);
    const d = await r.json();
    res.json(d);
  } catch (err) {
    console.error('[YT Search Error]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/api/admin/login', (req, res) => {
  const { key } = req.body;
  if (!key || key !== CFG.ADMIN_KEY) {
    return res.status(401).json({ success: false, message: 'Admin key salah.' });
  }
  res.json({
    success: true,
    username: CFG.ADMIN_USERNAME,
    displayName: CFG.ADMIN_DISPLAY_NAME,
    title: CFG.ADMIN_TITLE
  });
});

router.get('/api/logs', requireAdmin, (req, res) => {
  res.json(readLogs());
});

router.get('/api/myrequests', (req, res) => {
  const uname = (req.query.username || '').trim().toLowerCase();
  if (!uname) return res.json([]);
  const logs = readLogs().filter(l => (l.username || '').toLowerCase() === uname);
  res.json(logs);
});

router.get('/api/queue-position/:id', (req, res) => {
  const logs = readLogs();
  const entry = logs.find(l => String(l.id) === String(req.params.id));
  if (!entry) return res.status(404).json({ success: false, message: 'Request tidak ditemukan.' });
  if (entry.status !== 'pending') return res.json({ success: true, status: entry.status, position: 0, total: 0 });

  // Cuma hitung request PENDING yang masuk SEJAK sesi ini dibuka -- request
  // pending lama dari sesi sebelumnya (belum sempat di-acc/tolak admin) gak
  // ikut numpuk bikin nomor posisi kelihatan gede padahal sesinya udah baru.
  // Riwayatnya sendiri tetap utuh di logs.json, cuma gak dihitung ke antrian.
  const session = readSongSession();
  const openedAtTs = session[entry.type]?.openedAtTs;
  const sessionFilter = openedAtTs
    ? (l) => (l.ts === undefined || l.ts >= openedAtTs) // fallback: log lama tanpa `ts` dianggap masih dihitung
    : () => true; // belum ada info sesi (server baru nyala / data lama) -> jaga perilaku lama

  const pendingSameType = logs.filter(l => l.status === 'pending' && l.type === entry.type && sessionFilter(l));
  const idx = pendingSameType.findIndex(l => String(l.id) === String(entry.id));

  // Request ini sendiri kelewat dari filter (berarti dia request LAMA dari sesi
  // sebelum ini) -- tetap kasih tau statusnya (bukan hilang), tapi posisinya gak
  // relevan lagi dihitung terhadap sesi yang sedang berjalan sekarang.
  if (idx === -1) {
    return res.json({
      success: true,
      status: entry.status,
      position: 0,
      total: pendingSameType.length,
      estimateMinutes: null,
      note: 'Request ini dari sesi sebelumnya, masih menunggu diproses admin.'
    });
  }

  res.json({
    success: true,
    status: entry.status,
    position: idx + 1,
    total: pendingSameType.length,
    estimateMinutes: Math.max(1, (idx + 1) * 5)
  });
});

router.get('/api/track/:id', (req, res) => {
  const entry = readLogs().find(l => String(l.id) === String(req.params.id));
  if (!entry) return res.status(404).json({ success: false, message: 'Request tidak ditemukan.' });
  res.json({
    success: true,
    id: entry.id,
    type: entry.type,
    title: entry.title || (entry.type === 'banner' ? 'Request Banner' : entry.type === 'video' ? 'Video Tron' : 'Request Lagu'),
    status: entry.status,
    stage: entry.stage || null,
    time: entry.time,
    rating: entry.rating || null
  });
});

router.post('/api/request/:id/rating', (req, res) => {
  const { rating } = req.body;
  const val = parseInt(rating, 10);
  if (!val || val < 1 || val > 5) return res.status(400).json({ success: false, message: 'Rating tidak valid (1-5).' });
  const logs = readLogs();
  const entry = logs.find(l => String(l.id) === String(req.params.id));
  if (!entry) return res.status(404).json({ success: false, message: 'Request tidak ditemukan.' });
  if (entry.status !== 'approved') return res.status(400).json({ success: false, message: 'Rating hanya untuk request yang sudah disetujui.' });
  if (entry.rating) return res.status(400).json({ success: false, message: 'Request ini sudah pernah dirating.' });
  entry.rating = val;
  saveLogs(logs);
  if (val <= 2) {
    sendMessage(`⭐ <b>Rating Rendah Diterima</b>\n\nRequest <code>#${entry.id}</code> (${escapeHtml(entry.requester)}) dirating <b>${val}/5</b> oleh user.`).catch(() => {});
  }
  res.json({ success: true, rating: val });
});

router.delete('/api/logs', requireAdmin, (req, res) => {
  fs.writeFileSync(LOGS_FILE, '[]');
  res.json({ success: true });
});

router.get('/api/announce', (req, res) => {
  res.json({ success: true, announce: readAnnounce() });
});

router.get('/api/status', (req, res) => {
  res.json(readAppStatus());
});

// Site key + status on/off Turnstile dikasih ke frontend lewat endpoint (bukan
// hardcode di HTML) biar gampang diatur dari config.js doang tanpa perlu edit
// file publik. Kalau ENABLE_CAPTCHA false, frontend gak akan nampilin widget-nya
// sama sekali dan login jalan normal kayak biasa (tanpa CAPTCHA).
router.get('/api/turnstile-sitekey', (req, res) => {
  res.json({ enabled: !!CFG.ENABLE_CAPTCHA, siteKey: CFG.TURNSTILE_SITE_KEY });
});

// Verifikasi token CAPTCHA Turnstile ke server Cloudflare -- WAJIB di server,
// verifikasi cuma di browser gak ada gunanya karena bisa gampang dipalsuin
// (bot bisa langsung skip widget-nya dan kirim request tanpa token sama sekali).
router.post('/api/verify-turnstile', async (req, res) => {
  // Jaga-jaga: kalau CAPTCHA lagi dimatikan dari config tapi ada request nyasar
  // ke sini (misal cache lama di browser), langsung anggap lolos -- jangan
  // sampai orang malah kejebak gak bisa login gara-gara fitur yang lagi off.
  if (!CFG.ENABLE_CAPTCHA) return res.json({ success: true });

  const token = (req.body?.token || '').trim();
  if (!token) return res.status(400).json({ success: false, message: 'Token CAPTCHA tidak ada.' });

  try {
    const r = await fetch(API.TURNSTILE_VERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: CFG.TURNSTILE_SECRET_KEY, response: token, remoteip: req.ip }),
      signal: AbortSignal.timeout(10000)
    });
    const d = await r.json();
    if (d.success) return res.json({ success: true });
    console.warn('[Turnstile] Verifikasi gagal:', d['error-codes']);
    return res.status(400).json({ success: false, message: 'Verifikasi CAPTCHA gagal, coba lagi.' });
  } catch (e) {
    console.error('[Turnstile] Error verifikasi:', e.message);
    return res.status(500).json({ success: false, message: 'Gagal menghubungi server verifikasi CAPTCHA.' });
  }
});

// Role/titel/bypass user tertentu -- dipakai website buat nampilin titel di
// user-bar & buat nge-skip lock UI sesi tertutup, generalisasi dari yang
// sebelumnya cuma hardcode 1 username doang.
router.get('/api/my-role', (req, res) => {
  const username = (req.query.username || '').trim();
  if (!username) return res.json({ role: 'member', title: null, displayName: null, bypassSession: false, bypassAppMode: false });
  // Dipanggil tiap halaman dibuka -- titik paling sering buat nyatet "username ini
  // kepakai dari IP mana" (lihat recordUserIp di lib/store.js), tanpa nge-block apapun
  // di sini (biar UI tetap kebuka normal; blokir beneran terjadi pas request lagu/banner/video).
  recordUserIp(username, req.ip);
  res.json({
    role         : getRole(username),
    title        : roleTitle(username),
    displayName  : getDisplayName(username),
    bypassSession: canBypassSessionGate(username),
    bypassAppMode: canBypassAppMode(username, readAppStatus().mode),
    idSayaAccess : isPremium(username)   // VIP/VVIP: halaman "ID Saya" tetap bisa dibuka walau maintenance
  });
});

// ── "ID Saya" — inbox ID privat khusus VIP/VVIP ─────────────────────────────
// ID request yang di-ACC buat user vip/vvip GAK LAGI otomatis nyasar ke
// saluran WA publik -- disimpen di sini, cuma yang bersangkutan yang bisa
// lihat (dicek isPremium tiap request, bukan cuma percaya query username).
router.get('/api/my-private-ids', (req, res) => {
  const username = (req.query.username || '').trim();
  if (!username || !isPremium(username)) return res.json({ success: true, isPremium: false, items: [] });
  const items = getPrivateIds(username);
  markAllSeen(username);
  res.json({ success: true, isPremium: true, items });
});

// Endpoint ringan buat polling badge notifikasi ("ada ID baru") tanpa perlu
// narik & nandain semua entri jadi "sudah dilihat" tiap 5 detik.
router.get('/api/my-private-ids/unseen-count', (req, res) => {
  const username = (req.query.username || '').trim();
  if (!username || !isPremium(username)) return res.json({ count: 0 });
  res.json({ count: countUnseen(username) });
});

router.get('/api/my-private-ids/download', (req, res) => {
  const username = (req.query.username || '').trim();
  if (!username || !isPremium(username)) return res.status(403).send('Halaman ini cuma buat user vip/vvip.');
  const txt = formatPrivateIdsAsTxt(username);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="id-saya-${username.toLowerCase()}.txt"`);
  res.send(txt);
});

router.get('/api/req-status', (req, res) => {
  res.json(readReqStatus());
});

router.get('/api/user-limit-info', (req, res) => {
  const username = (req.query.username || '').trim().toLowerCase();
  if (!username) return res.json({ song: { used: 0, max: RATE_LIMITS.song, resetAt: null }, banner: { used: 0, max: RATE_LIMITS.banner, resetAt: null } });

  if (isUnlimited(username)) {
    return res.json({
      song  : { used: 0, max: '∞', resetAt: null },
      banner: { used: 0, max: '∞', resetAt: null }
    });
  }

  const key   = `u:${username}`;
  const rates = readRates();
  const bonus = readBonus();
  const now   = Date.now();
  const bucket = rates[key] || {};
  const vip    = isPremium(username);

  const calc = (type) => {
    if (vip) {
      // VVIP: limit TETAP (10 lagu/5 banner), window 24 jam (bukan RATE_WINDOW
      // lama), hits di luar 24 jam dianggap udah reset sendiri.
      const cutoff = now - VVIP_RESET_MS;
      const hits   = (bucket[type] || []).filter(t => t > cutoff);
      const max    = roleLimit(username, type);
      const resetAt = hits.length > 0 ? Math.min(...hits) + VVIP_RESET_MS : null;
      return { used: hits.length, max, resetAt };
    }
    // Member biasa: permanen sampai sesi dibuka lagi / direset manual --
    // TIDAK difilter berdasarkan waktu (konsisten sama checkRateLimit()).
    const hits = bucket[type] || [];
    const max  = RATE_LIMITS[type] + ((bonus[username] || {})[type] || 0);
    return { used: hits.length, max, resetAt: null };
  };

  res.json({ song: calc('song'), banner: calc('banner') });
});

router.get('/api/stats-public', (req, res) => {
  const logs = readLogs();
  const now  = new Date();
  const todayStr = now.toDateString();
  res.json({
    pendingSong  : logs.filter(l => l.type === 'song'   && l.status === 'pending').length,
    pendingBanner: logs.filter(l => l.type === 'banner' && l.status === 'pending').length,
    totalToday   : logs.filter(l => new Date(l.time || '').toDateString() === todayStr).length
  });
});

router.post('/api/ticket', async (req, res) => {
  try {
    const { name, username, message } = req.body;
    if (!name?.trim())    return res.status(400).json({ success: false, message: 'Nama wajib diisi.' });
    if (!message?.trim()) return res.status(400).json({ success: false, message: 'Pesan wajib diisi.' });

    const id   = makeTicketId();
    const time = getTime();
    const appStat = readAppStatus();

    const caption =
      `<b>🎫 Tiket Baru</b>  <code>#${id}</code>\n\n` +
      `<b>Dari    :</b> ${escapeHtml(name.trim())}\n` +
      (username?.trim() ? `<b>Username:</b> ${escapeHtml(username.trim())}\n` : '') +
      (appStat.mode !== 'online' ? `<b>Status App:</b> ${appStat.mode === 'maintenance' ? '🔧 maintenance' : '🔴 offline'}\n` : '') +
      `\n<b>Pesan:</b>\n${escapeHtml(message.trim())}\n\n` +
      `<i>${time} WIB</i>\n\n` +
      `<i>💬 Balas (reply) pesan ini di Telegram untuk membalas user.</i>`;

    const r = await notifyAdmins(caption);
    const tgChatId = r?.result?.chat?.id || null;
    const tgMsgId  = r?.result?.message_id || null;

    const ticket = {
      id, status: 'open', name: name.trim(), username: username?.trim() || null,
      createdAt: time, tgChatId,
      messages: [{ from: 'user', text: message.trim(), time, tgMsgId }]
    };
    saveTicket(ticket);
    res.json({ success: true, id, ticket });
  } catch (err) {
    console.error('[Ticket Create Error]', err);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan saat membuat tiket.' });
  }
});

router.post('/api/ticket/:id/message', async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ success: false, message: 'Pesan kosong.' });

    const ticket = findTicket(id);
    if (!ticket) return res.status(404).json({ success: false, message: 'Tiket tidak ditemukan.' });
    if (ticket.status === 'closed') return res.status(400).json({ success: false, message: 'Tiket ini sudah ditutup.' });

    const time = getTime();
    const caption =
      `<b>💬 Balasan User</b>  <code>#${id}</code>\n\n` +
      `<b>Dari:</b> ${escapeHtml(ticket.name)}\n\n${escapeHtml(message.trim())}\n\n<i>${time} WIB</i>`;

    let tgMsgId = null;
    try {
      const r = await notifyAdmins(caption);
      tgMsgId = r?.result?.message_id || null;
    } catch (e) { console.error('[Ticket Msg TG Error]', e.message); }

    ticket.messages.push({ from: 'user', text: message.trim(), time, tgMsgId });
    saveTicket(ticket);
    res.json({ success: true, ticket });
  } catch (err) {
    console.error('[Ticket Message Error]', err);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan.' });
  }
});

router.get('/api/ticket/:id', (req, res) => {
  const ticket = findTicket(req.params.id);
  if (!ticket) return res.status(404).json({ success: false, message: 'Tiket tidak ditemukan.' });
  res.json({ success: true, ticket });
});

router.post('/api/ticket/:id/close', (req, res) => {
  const ticket = findTicket(req.params.id);
  if (!ticket) return res.status(404).json({ success: false, message: 'Tiket tidak ditemukan.' });
  ticket.status = 'closed';
  saveTicket(ticket);
  res.json({ success: true, ticket });
});

module.exports = router;
