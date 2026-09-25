// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Bot Roblox Audio — Command /upload dkk               ║
// ║        (diintegrasikan dari project roblox-audio-bot-v22)   ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝

const fs   = require('fs');

const { sendMessageTo, editMessageText, downloadTgFile, notifyAdmins } = require('../lib/telegram');
const { sendChannelMessage } = require('../lib/whatsapp');
const { escapeHtml } = require('../lib/util');
const { findEntry } = require('../lib/store');
const { isVvip, isPremium } = require('../lib/roles');
const { addPrivateId } = require('../lib/privateInbox');
const RA = require('../lib/robloxAudio');

const {
  loadHistory, upsertHistory, loadPendingList, addPending, removePending,
  fileTracker, runQueued, getQueuePosition,
  archiveAssetOnRoblox,
  uploadAssetToRoblox, waitForAssetCreated, fastCheckModeration, getAsset,
  normalizeModerationState, autoGrantPermission, describePermError, sleep,
  moderationPollDelay, moderationExpired, moderationIsSlow, pendingStartedAt,
} = RA;

// Kalau Roblox balikin 401/403, kasih tau owner -- TAPI dikasih jeda (cooldown)
// biar gak spam kalau errornya kejadian berkali-kali beruntun (misal lagi ada
// beberapa upload bareng, semua bakal collision di error yang sama).
let lastAccountAlertAt = 0;
const ACCOUNT_ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 menit

async function notifyRobloxAccountIssueIfNeeded(err) {
  if (!err?.suspectedAccountIssue) return;
  const now = Date.now();
  if (now - lastAccountAlertAt < ACCOUNT_ALERT_COOLDOWN_MS) return;
  lastAccountAlertAt = now;

  const status = err.robloxStatus;
  const detail = err?.response?.data?.message || err?.response?.data?.error?.message || err.message;
  await notifyAdmins(
    `⚠️ <b>Roblox API menolak akses (HTTP ${status})</b>\n\n` +
    `Detail: <code>${escapeHtml(String(detail).slice(0, 300))}</code>\n\n` +
    `Kemungkinan penyebabnya:\n` +
    `• Akun Roblox kena <b>warning/restrict/ban</b> dari Roblox\n` +
    `• Token API expired / di-revoke\n` +
    `• Scope/permission token kurang\n\n` +
    `<i>Bot gak bisa mastiin persis yang mana dari respons doang — cek langsung ke Roblox Creator Dashboard &amp; email dari Roblox buat pastiin.</i>`
  ).catch(() => {});
}

// Kalau caption/teks-nya ada kode "#idrequest" (kode yang sama kayak di kartu
// request Telegram, misal "#msmi6swxmbd9"), cari judul ASLI dari data request-nya
// (logs.json) dan pakai itu — supaya nggak salah ketik ulang & konsisten sama
// judul yang di-request user, bukan caption manual/nama file mp3.
function resolveRequestTitle(rawTitle) {
  if (!rawTitle) return { title: rawTitle, requestId: null };
  const idMatch = rawTitle.match(/#([a-zA-Z0-9_-]{4,})/);
  if (!idMatch) return { title: rawTitle, requestId: null };
  const entry = findEntry(idMatch[1]);
  return entry ? { title: entry.title || rawTitle, requestId: idMatch[1] } : { title: rawTitle, requestId: null };
}

// Wrapper di atas extractMediaFromMessage bawaan (lib/robloxAudio.js) — habis
// judul mentah (caption/filename) didapat, coba upgrade ke judul asli request
// kalau ketemu kode #id di dalamnya, sekaligus catat requestId-nya (dipakai
// buat cek privilege VVIP pas share nanti).
function extractMediaFromMessage(message) {
  const media = RA.extractMediaFromMessage(message);
  if (media) {
    const { title, requestId } = resolveRequestTitle(media.title);
    media.title = title;
    media.requestId = requestId;
  }
  return media;
}

// ── Format & kirim status ──
function formatInfo({ title, status, id, extraLines = [] }) {
  let text = `📄 <b>Judul:</b> ${escapeHtml(title)}\n📌 <b>Status:</b> ${escapeHtml(status)}`;
  if (id) text += `\n🆔 <b>ID:</b> <code>${escapeHtml(id)}</code>`;
  for (const line of extraLines) {
    if (line) text += `\n${escapeHtml(line)}`;
  }
  return text;
}

async function sendInfoFast(chatId, opts) {
  const r = await sendMessageTo(chatId, formatInfo(opts));
  return r?.result || null;
}

async function editInfo(chatId, statusMsg, opts, keyboard) {
  if (!statusMsg) return;
  await editMessageText(chatId, statusMsg.message_id, formatInfo(opts), keyboard);
}

function createAnimator(chatId, statusMsg, title) {
  return {
    setPhase(label) { editInfo(chatId, statusMsg, { title, status: label, id: null }).catch(() => {}); },
    stop() {}
  };
}

// Lock in-flight + penanda permanen di history -- SAMA PERSIS pola yang dipakai
// performRequestShare() di robloxAudioRequest.js. Sebelumnya fungsi ini gak ada
// pengaman sama sekali: kalau admin gak sengaja tap tombol "✅ Done" 2x (misal
// koneksi lemot), ID yang sama bisa nyasar 2x ke "ID Saya" / ke saluran WA.
const sharingNow = new Set();

// Share judul + Asset ID — kalau requester-nya VIP/VVIP, ID-nya GAK LAGI
// otomatis nyasar ke saluran WA publik. Sekarang disimpen ke inbox privat
// ("ID Saya" di web/app, lihat lib/privateInbox.js) supaya cuma yang
// bersangkutan yang bisa lihat. TIDAK ADA lagi pengiriman ke WhatsApp
// (saluran maupun DM pribadi) buat VIP/VVIP -- satu-satunya tempat ID
// mereka cuma halaman "ID Saya". User biasa (bukan vip/vvip) tetap ke
// saluran publik seperti biasa, gak ada perubahan buat mereka.
async function shareApprovedToWaChannel(title, assetId, requestId) {
  assetId = String(assetId);
  if (sharingNow.has(assetId)) return { ok: false, busy: true, reason: 'sedang diproses' };
  sharingNow.add(assetId);
  try {
    // Sudah pernah kekonfirmasi dibagikan sebelumnya (persisten di history.json,
    // jadi tetap kedeteksi walau server sempat restart di antara 2 tap) -> JANGAN
    // kirim/simpan ID lagi, cukup kasih tau ini ID duplikat/udah pernah.
    const prev = loadHistory().find((e) => e.assetId === assetId);
    if (prev && prev.shared) {
      return { ok: true, already: true, viaPersonal: prev.viaPersonal || false, reason: null };
    }

    let result;
    if (requestId) {
      const reqEntry = findEntry(requestId);
      if (reqEntry && reqEntry.username && isPremium(reqEntry.username)) {
        addPrivateId(reqEntry.username, {
          id: assetId, title, type: reqEntry.type === 'banner' ? 'banner' : 'song', requestId
        });
        result = { ok: true, viaPersonal: true, reason: null };
      }
    }
    if (!result) {
      const ok = await sendChannelMessage(`📄 Judul: ${title}\n🆔 ID: ${assetId}`);
      result = { ok, viaPersonal: false, reason: ok ? null : 'WA belum terhubung / gagal kirim ke saluran' };
    }
    if (result.ok) upsertHistory({ assetId, shared: true, viaPersonal: result.viaPersonal });
    return result;
  } finally {
    sharingNow.delete(assetId);
  }
}

function checkDuplicate(chatId, media) {
  if (!media.fileUniqueId) return false;
  const existing = fileTracker.get(media.fileUniqueId);
  if (!existing) return false;

  if (existing.status === 'processing') {
    sendInfoFast(chatId, { title: media.title, status: '⏳ File ini sudah/masih diproses, tunggu update sebelumnya ya.', id: null });
    return true;
  }
  if (existing.status === 'approved') {
    sendInfoFast(chatId, { title: existing.title || existing.fileName, status: '✅ Sudah pernah diupload & lolos sebelumnya (tidak diupload ulang)', id: existing.assetId });
    return true;
  }
  if (existing.status === 'rejected') {
    sendInfoFast(chatId, { title: existing.title || existing.fileName, status: '🚫❌ Sudah pernah ditolak moderasi sebelumnya (tidak diupload ulang)', id: null });
    return true;
  }
  return false;
}

// ── Proses utama: download dari Telegram -> upload ke Roblox -> tunggu moderasi ──
async function handleAssetUpload(chatId, fileId, fileName, title, fileUniqueId, assetType, contentType, existingStatusMsg, requestId) {
  title = title || fileName;
  const tempPath = await downloadTgFile(fileId);
  let keepFileForBackground = false;

  const statusMsg = existingStatusMsg || await sendInfoFast(chatId, { title, status: '⏳ Memproses', id: null });
  const animator = createAnimator(chatId, statusMsg, title);

  if (fileUniqueId) fileTracker.set(fileUniqueId, { status: 'processing', assetId: null, fileName, title });

  try {
    animator.setPhase(`Mengunduh & upload ${assetType} ke Roblox`);
    const created = await uploadAssetToRoblox(tempPath, title, assetType, contentType);
    animator.setPhase('Menunggu moderasi Roblox');

    const asset = await waitForAssetCreated(created.path, {}, assetType);
    const assetId = asset.assetId;
    const initialState = asset?.moderationResult?.moderationState;
    const state = await fastCheckModeration(assetId, initialState, {}, assetType);

    if (normalizeModerationState(state) === 'APPROVED') {
      await finalizeApproved(chatId, statusMsg, fileName, title, assetId, fileUniqueId, animator, assetType, requestId);
    } else if (normalizeModerationState(state) === 'REJECTED') {
      await finalizeRejected(chatId, statusMsg, fileName, title, tempPath, fileUniqueId, animator, assetId);
    } else {
      keepFileForBackground = true;
      animator.setPhase('Masih direview Roblox');
      addPending({ assetId, fileName, title, tempPath, fileUniqueId: fileUniqueId || null, chatId, statusMessageId: statusMsg.message_id, assetType, requestId: requestId || null });
      backgroundPollModeration(chatId, statusMsg, fileName, title, assetId, tempPath, fileUniqueId, animator, assetType, requestId).catch((err) =>
        console.error('Background poll error:', err.message)
      );
    }
  } catch (err) {
    animator.stop();
    if (fileUniqueId) fileTracker.delete(fileUniqueId);
    console.error(err?.response?.data || err.message);
    const errMsg = err?.response?.data?.message || err.message;
    await editInfo(chatId, statusMsg, { title, status: '❌ Gagal upload', id: null, extraLines: [`Detail: ${errMsg}`] }).catch(() => {});
    notifyRobloxAccountIssueIfNeeded(err);
  } finally {
    if (!keepFileForBackground) fs.unlink(tempPath, () => {});
  }
}

async function backgroundPollModeration(chatId, statusMsg, fileName, title, assetId, tempPath, fileUniqueId, animator, assetType, requestId) {
  title = title || fileName;
  // 90 menit pertama tiap 15 dtk, lalu tiap 5 menit, menyerah setelah 48 jam (lihat lib/robloxAudio.js).
  const startedAt = pendingStartedAt(assetId);
  let errorNotified = false;
  let notedSlow = false;

  while (!moderationExpired(startedAt)) {
    await sleep(moderationPollDelay(startedAt));
    if (!notedSlow && moderationIsSlow(startedAt)) { notedSlow = true; if (animator) animator.setPhase('Masih direview Roblox (>90 menit) — tetap dipantau'); }
    let asset;
    try {
      asset = await getAsset(assetId, assetType);
      if (errorNotified) { errorNotified = false; if (animator) animator.setPhase('Masih direview Roblox'); }
    } catch (e) {
      const status = e?.response?.status;
      const errDetail = e?.response?.data?.message || e.message;
      console.error(`Gagal cek status asset ${assetId} (HTTP ${status}):`, errDetail);
      if (!errorNotified) { errorNotified = true; if (animator) animator.setPhase(`⚠️ Gagal cek status (HTTP ${status}: ${errDetail})`); }
      continue;
    }
    const state = asset?.moderationResult?.moderationState;
    if (normalizeModerationState(state) === 'APPROVED') {
      removePending(assetId);
      await finalizeApproved(chatId, statusMsg, fileName, title, assetId, fileUniqueId, animator, assetType, requestId);
      fs.unlink(tempPath, () => {});
      return;
    }
    if (normalizeModerationState(state) === 'REJECTED') {
      removePending(assetId);
      await finalizeRejected(chatId, statusMsg, fileName, title, tempPath, fileUniqueId, animator, assetId);
      return;
    }
  }
  removePending(assetId);
  if (animator) animator.stop();
  if (fileUniqueId) fileTracker.delete(fileUniqueId);
  await editInfo(chatId, statusMsg, { title, status: '⚠️ Moderasi Roblox >48 jam tanpa hasil — cek manual di Creator Dashboard', id: null }).catch(() => {});
  fs.unlink(tempPath, () => {});
}

async function finalizeApproved(chatId, statusMsg, fileName, title, assetId, fileUniqueId, animator, assetType, requestId) {
  title = title || fileName;
  if (animator) animator.stop();

  let permissionLine = '';
  let permissionGranted = false;

  if (assetType === 'Image') {
    permissionLine = 'ℹ️ Gambar defaultnya "Open Use" — bisa langsung dipakai, nggak perlu izin kolaborasi.';
    permissionGranted = true;
  } else {
    try {
      const perm = await autoGrantPermission(assetId);
      if (perm.skipped) {
        permissionLine = `⚠️ Auto-permission dilewati: ${perm.reason}`;
      } else {
        const list = perm.subjects.map((s) => `${s.subjectType} (${s.subjectId})`).join(', ');
        permissionLine = `🔓 Izin otomatis berhasil: Use → ${list}`;
        permissionGranted = true;
      }
    } catch (permErr) {
      const permErrMsg = describePermError(permErr);
      permissionLine = `⚠️ Auto-grant gagal (${permErrMsg}). Kasih izin manual di sini:\nhttps://create.roblox.com/dashboard/creations/store/${assetId}/permissions`;
      notifyRobloxAccountIssueIfNeeded(permErr);
    }
  }

  if (fileUniqueId) fileTracker.set(fileUniqueId, { status: 'approved', assetId, fileName, title });
  upsertHistory({ fileName, title, assetId, status: 'approved', archived: false, permissionGranted, tempPath: null, assetType: assetType || 'Audio', requestId: requestId || null });

  if (permissionGranted) {
    const shareResult = await shareApprovedToWaChannel(title, assetId, requestId);
    const shareLine = shareResult.already
      ? '📢 ID ini duplikat -- udah pernah dibagikan sebelumnya, gak dikirim ulang.'
      : shareResult.ok
      ? (shareResult.viaPersonal
          ? '📢 ID otomatis masuk ke halaman "ID Saya" (privilege VIP/VVIP).'
          : '📢 Otomatis udah dibagikan ke saluran WA.')
      : `⚠️ Belum dibagikan: ${shareResult.reason}`;
    await editInfo(chatId, statusMsg, { title, status: `✅🎉 Lolos (${assetType || 'Audio'})`, id: assetId, extraLines: [permissionLine, shareLine] });
  } else {
    await editInfo(
      chatId, statusMsg,
      { title, status: `✅🎉 Lolos (${assetType || 'Audio'})`, id: assetId, extraLines: [permissionLine, '👉 Setelah kamu kasih izin manual lewat link di atas, tap tombol di bawah ini:'] },
      { inline_keyboard: [[{ text: '✅ Done, sudah dikasih izin', callback_data: `raDone:${assetId}` }]] }
    );
  }
}

async function finalizeRejected(chatId, statusMsg, fileName, title, tempPath, fileUniqueId, animator, assetId) {
  title = title || fileName;
  if (animator) animator.stop();

  let archiveNote = '';
  let archived = false;

  if (assetId) {
    try {
      await archiveAssetOnRoblox(assetId);
      archiveNote = '📦 Asset sudah diarsipkan di Roblox.';
      archived = true;
    } catch (archErr) {
      const detail = archErr?.response?.data?.error?.message || archErr?.response?.data?.message || archErr.message;
      archiveNote = `⚠️ Gagal arsipkan di Roblox: ${detail}`;
    }
  }

  // Backup lokal file audio yang ditolak DIHAPUS -- gak nyimpen audio apapun
  // di disk server biar gak numpuk/penuhin memori panel. Cukup diarsipkan di
  // sisi Roblox (di atas) aja, file lokalnya langsung dihapus.
  fs.unlink(tempPath, () => {});

  if (fileUniqueId) fileTracker.set(fileUniqueId, { status: 'rejected', assetId: assetId || null, fileName, title });
  if (assetId) upsertHistory({ fileName, title, assetId, status: 'rejected', archived, permissionGranted: false, tempPath: null });

  await editInfo(chatId, statusMsg, { title, status: '🚫❌ Ditolak moderasi', id: null, extraLines: [archiveNote] });
}

// Dipanggil dari tombol "Done" (callback_query) setelah izin dikasih manual
async function handleDoneButton(chatId, assetId) {
  const history = loadHistory();
  const entry = history.find((e) => e.assetId === assetId);
  if (!entry) return { ok: false, alert: 'Data asset ini tidak ketemu di history.' };

  upsertHistory({ assetId, permissionGranted: true });
  const shareResult = await shareApprovedToWaChannel(entry.title || entry.fileName, assetId, entry.requestId);

  if (shareResult.busy) return { ok: false, alert: '⏳ Lagi diproses, jangan tap dobel ya.' };
  if (!shareResult.ok) return { ok: false, alert: `⚠️ Gagal share: ${shareResult.reason}` };
  if (shareResult.already) return { ok: true, alert: 'ℹ️ ID ini duplikat -- udah pernah dibagikan sebelumnya.' };
  return { ok: true, alert: shareResult.viaPersonal ? '✅ ID sudah masuk ke halaman "ID Saya"!' : '✅ Sudah dibagikan ke saluran WA!' };
}

// Dipanggil sekali pas server start — lanjutkan pemantauan yang masih pending sebelum restart
function resumePendingChecks() {
  const list = loadPendingList().filter((e) => !e.isRequestUpload);
  for (const entry of list) {
    if (!fs.existsSync(entry.tempPath)) {
      console.warn(`[resume] File temp ${entry.tempPath} udah gak ada, skip assetId ${entry.assetId}`);
      removePending(entry.assetId);
      continue;
    }
    const statusMsgShim = { message_id: entry.statusMessageId };
    backgroundPollModeration(entry.chatId, statusMsgShim, entry.fileName, entry.title, entry.assetId, entry.tempPath, entry.fileUniqueId, null, entry.assetType || 'Audio')
      .catch((err) => console.error('Resume poll error:', err.message));
  }
  if (list.length) console.log(`[RobloxAudio] Lanjutin pemantauan ${list.length} asset yang masih pending...`);
}

module.exports = {
  formatInfo, sendInfoFast, editInfo, checkDuplicate,
  handleAssetUpload, handleDoneButton, resumePendingChecks,
  extractMediaFromMessage, getQueuePosition, runQueued,
  notifyRobloxAccountIssueIfNeeded,
};
