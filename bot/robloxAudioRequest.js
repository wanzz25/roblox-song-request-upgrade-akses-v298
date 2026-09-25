// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║   Roblox Audio — Upload dipicu dari kartu Request            ║
// ║   (tombol "⬆️ Upload ke Roblox" pengganti ACC/Tolak/Pending) ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { editMessageCaption, editMessageText, editMessageMarkup, answerCallback: _answerCallback, downloadTgFile, deleteMessage, sendDocumentTo } = require('../lib/telegram');
const { sendChannelMessage, sendChannelImage, sendChannelVideo } = require('../lib/whatsapp');
const { findEntry, updateLogStatus, removeClaim } = require('../lib/store');
const { addJob, getJob, updateJob, removeJob, loadJobs } = require('../lib/uploadJobs');
const { tmpPath, isNoSpaceError, handleNoSpace } = require('../lib/tempdir');
const { isVvip, isPremium } = require('../lib/roles');
const { addPrivateId } = require('../lib/privateInbox');
const { getAutoMode } = require('../lib/autoMode');
const { refundRateLimit } = require('../lib/ratelimit');
const { decrementCount } = require('../lib/songSchedule');
const { notifyRobloxAccountIssueIfNeeded } = require('./robloxAudio');
const RA = require('../lib/robloxAudio');

const {
  addPending, removePending, loadPendingList,
  archiveAssetOnRoblox,
  uploadAssetToRoblox, waitForAssetCreated, fastCheckModeration, getAsset,
  normalizeModerationState, autoGrantPermission, describePermError, extractMediaFromMessage, sleep, upsertHistory,
  moderationPollDelay, moderationExpired, moderationIsSlow, pendingStartedAt,
  runQueued, getQueuePosition
} = RA;

// Ganti baris "📌 Status: ..." di caption/teks yang udah ada, sisanya (Dari/Judul/Link/dst) dibiarin apa adanya.
function replaceStatusLine(text, newStatus) {
  if (/📌 <b>Status:<\/b>.*/i.test(text)) {
    return text.replace(/📌 <b>Status:<\/b>.*/i, `📌 <b>Status:</b> ${newStatus}`);
  }
  return text + `\n\n📌 <b>Status:</b> ${newStatus}`;
}

async function editCard(chatId, messageId, isCaption, text, keyboard) {
  const fn = isCaption ? editMessageCaption : editMessageText;
  await fn(chatId, messageId, text, keyboard || { inline_keyboard: [] });
}

// Dipanggil dari callback_query "raUpload:<id>" — admin tap tombol Upload di kartu request
async function handleRequestUploadButton(cq) {
  const id = cq.data.split(':')[1];
  // cq.auto = dipicu OTOMATIS (mode /autoupload), bukan tombol yang ditekan admin -> gak ada
  // callback_query yang perlu dijawab.
  const answerCallback = (cbId, text) => (cq.auto ? Promise.resolve() : _answerCallback(cbId, text));
  const entry = findEntry(id);
  if (!entry) { await answerCallback(cq.id, '⚠️ Data request ini tidak ketemu (mungkin udah lama/keapus).'); return; }
  if (entry.status !== 'pending') {
    // Request ini kemungkinan udah diproses admin lain (kartu ini kan di-broadcast
    // ke beberapa admin, masing-masing punya tombol sendiri) -- cegah upload dobel.
    await answerCallback(cq.id, `⚠️ Request ini udah diproses duluan (status: ${entry.status}).`);
    return;
  }

  // Upload request ini udah berjalan/antre (termasuk yang dilanjutin otomatis
  // abis server restart) -- cegah admin lain (kartu di-broadcast ke beberapa
  // admin) nembak upload dobel & bikin asset kembar di Roblox.
  if (getJob(id)) {
    await answerCallback(cq.id, '⚠️ Request ini lagi diproses (upload ke Roblox sedang berjalan/antre).');
    return;
  }

  const msg = cq.message;
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const isCaption = !!msg.caption;
  const rawText = msg.caption || msg.text || '';

  let media = extractMediaFromMessage(msg);
  // Video: kartunya bisa berupa TEKS doang (video kegedean buat dilampirin ke
  // Telegram) -- file aslinya ada di disk server (entry.videoPath), jadi gak
  // perlu media di pesan. Lihat routes/api.js -> /api/video.
  if (!media && entry.type === 'video' && entry.videoPath && fs.existsSync(entry.videoPath)) {
    const vName = entry.title || `video_${Date.now()}.mp4`;
    media = { fileId: null, fileUniqueId: null, fileName: vName, title: vName, assetType: 'VideoFrames', contentType: 'video/mp4' };
  }
  if (!media) {
    if (cq.auto) console.warn(`[AutoUpload] #${id}: tidak ada file di kartu (mungkin cuma link) -- dibiarkan menunggu upload manual.`);
    await answerCallback(cq.id, '⚠️ Gak ada file audio di pesan ini buat diupload (mungkin cuma link doang) — upload manual pakai /upload ya.');
    return;
  }

  const title = entry.title || media.title || media.fileName;
  const assetType = entry.type === 'banner' ? 'Image' : entry.type === 'video' ? 'VideoFrames' : 'Audio';

  // Kasih tau posisi antrian kalau lagi rame -- runQueued ini SATU antrian yang
  // sama dipakai bareng /upload command & kirim audio langsung (lib/robloxAudio.js),
  // biar gak ada 2 sistem antrian ngebut nembak Roblox bersamaan sampai kena 429.
  const queuePos = getQueuePosition();

  updateLogStatus(id, 'pending', { stage: 'pending' });

  let text = replaceStatusLine(rawText, queuePos === 0 ? '🔄 (pending) — sedang upload ke Roblox...' : `📥 (antre posisi ${queuePos})...`);

  // Catat JOB ke disk SEBELUM proses dimulai -- kalau server restart di
  // tengah download/upload/antrean, job ini dilanjutin otomatis pas server
  // nyala lagi (resumeUploadJobs di bawah), bukan ilang & kartunya nyangkut
  // di "sedang upload" selamanya.
  addJob({
    requestId: id, type: entry.type, assetType, title,
    chatId, messageId, isCaption, text, media,
    stage: 'queued',
  });

  await answerCallback(cq.id, queuePos === 0 ? '⏳ Mulai upload ke Roblox...' : `📥 Antre di posisi ${queuePos}...`);
  await editCard(chatId, messageId, isCaption, text, { inline_keyboard: [] });
  stripOtherCopies(entry, chatId, messageId);   // salinan kartu di admin lain: tombolnya dilepas (gak bisa ditekan lagi)

  // SENGAJA gak di-await di titik pemanggilannya (lihat bot/callback.js) --
  // biar poller Telegram gak nunggu upload+moderasi Roblox kelar dulu (bisa
  // belasan detik~menitan) sebelum proses update/command lain.
  runQueued(() => runUploadJob(id))
    .catch((err) => handleUploadJobFailure(id, err));
}

// Jalanin 1 job dari catatan di disk. Dipakai bareng oleh tombol Upload
// (job baru) & resumeUploadJobs (job yang kepotong restart). Job dihapus
// dari disk HANYA kalau perform*Upload selesai tanpa error -- kalau error,
// handleUploadJobFailure yang ngurus (refund limit + update kartu + hapus job).
async function runUploadJob(id) {
  const job = getJob(id);
  if (!job) return;
  const entry = findEntry(id) || {};
  if (job.stage === 'queued') updateJob(id, { stage: 'uploading' });

  const perform = () => job.type === 'video'
    ? performVideoUpload(job.chatId, job.messageId, job.isCaption, job.text, id, entry, job.media, job.title)
    : performRequestUpload(job.chatId, job.messageId, job.isCaption, job.text, id, entry, job.media, job.title, job.assetType);

  try {
    await perform();
  } catch (err) {
    // ENOSPC (penyimpanan penuh): bersihin file sementara yang numpuk + kabari Owner, lalu
    // coba SEKALI LAGI otomatis -- user gak perlu request ulang cuma gara-gara tempat penuh sesaat.
    if ((isNoSpaceError(err) || err.code === 'NO_SPACE') && !(getJob(id) || {}).noSpaceRetried) {
      updateJob(id, { noSpaceRetried: true });
      if (err.code !== 'NO_SPACE') handleNoSpace('upload ke Roblox');
      await new Promise(r => setTimeout(r, 1500));
      await perform();
    } else {
      throw err;
    }
  }
  removeJob(id);
}

async function handleUploadJobFailure(id, err) {
  console.error('[RequestUpload] Upload error:', err?.response?.data || err.message);
  const noSpace = isNoSpaceError(err) || err.code === 'NO_SPACE';
  if (noSpace && err.code !== 'NO_SPACE') handleNoSpace('upload ke Roblox');
  const errMsg = noSpace ? 'penyimpanan server penuh — admin sudah diberi tahu, coba lagi sebentar lagi' : (err?.response?.data?.message || err.message);
  const job = getJob(id);
  const entry = findEntry(id) || {};

  // Gagal upload (error teknis: koneksi, Roblox lagi down, dsb) --
  // BUKAN ditolak moderasi, tapi user tetap kudu dapetin balik limitnya,
  // sama kayak kalau ditolak. Status log juga ditandain biar gak
  // nyangkut selamanya di "pending".
  updateLogStatus(id, 'rejected', { stage: 'gagal' });
  removeClaim(id);
  // GAGAL (error teknis, BUKAN ditolak) = DUA-DUANYA dikembalikan: limit pribadi user + kuota sesi
  // GLOBAL (hitungan sesi lagu/banner), karena request-nya tidak pernah benar-benar diproses.
  // (Beda dengan DITOLAK admin/moderasi Roblox: cuma limit pribadi yang dikembalikan -- lihat
  // finalizeRequestRejected & bot/apply-status.js.) Video punya limit sendiri & tidak punya kuota sesi global.
  if (entry.type === 'video') {
    if (entry.username) refundRateLimit(entry.username, 'video');
  } else {
    const limitType = entry.type === 'banner' ? 'banner' : 'song';
    if (entry.username) refundRateLimit(entry.username, limitType);
    decrementCount(limitType);
  }
  removeJob(id);

  if (job) {
    const failText = replaceStatusLine(job.text, `❌ Gagal upload (${errMsg})\n\n💡 Limit request udah dikembalikan, boleh coba request ulang.`);
    await editCard(job.chatId, job.messageId, job.isCaption, failText, { inline_keyboard: [] }).catch(() => {});
  }
  notifyRobloxAccountIssueIfNeeded(err);
}

const MAX_RESUME_ATTEMPTS = 3;

// Dipanggil sekali pas server start -- lanjutin SEMUA upload yang kepotong
// restart (masih antre, lagi download file, lagi upload ke Roblox, atau video
// yang klipnya baru terupload sebagian). Lanjutnya dari titik terakhir:
//   - asset udah dibuat di Roblox  -> gak upload ulang, langsung nunggu hasil
//   - video sebagian klip terupload -> klip yang udah ada dilewati
// Job yang udah kepotong restart > MAX_RESUME_ATTEMPTS kali dianggap gagal
// (biar job "beracun" gak bikin server loop restart-lanjut terus).
function resumeUploadJobs() {
  const jobs = loadJobs().sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
  let resumed = 0;
  for (const job of jobs) {
    const entry = findEntry(job.requestId);
    // Request-nya udah gak pending (udah selesai/dihapus/dibatalkan) -- job
    // sisa gak perlu dilanjutin.
    if (!entry || entry.status !== 'pending') { removeJob(job.requestId); continue; }

    const attempts = (job.attempts || 0) + 1;
    if (attempts > MAX_RESUME_ATTEMPTS) {
      handleUploadJobFailure(job.requestId, new Error(`server restart berulang kali (${MAX_RESUME_ATTEMPTS}x) saat upload ini berjalan`))
        .catch((e) => console.error('[RequestUpload] Gagal nutup job:', e.message));
      continue;
    }
    updateJob(job.requestId, { attempts });
    resumed++;

    const note = replaceStatusLine(job.text, '🔄 (pending) — server sempat restart, upload dilanjutkan otomatis...');
    editCard(job.chatId, job.messageId, job.isCaption, note, { inline_keyboard: [] }).catch(() => {});

    runQueued(() => runUploadJob(job.requestId))
      .catch((err) => handleUploadJobFailure(job.requestId, err));
  }
  if (resumed) console.log(`[RobloxAudioRequest] Melanjutkan ${resumed} upload yang kepotong restart...`);
}

// Video: pecah jadi banyak klip gambar & upload berurutan (lihat lib/robloxVideo.js).
// Beda dari performRequestUpload -- gak ada 1 assetId tunggal & gak ada tahap
// moderasi tunggu-berlarut (setiap klip udah dicek satu-satu di dalam
// uploadVideoAsFrames), hasil akhirnya LANGSUNG list semua assetId sekaligus.
async function performVideoUpload(chatId, messageId, isCaption, text, id, entry, media) {
  const title = entry.title || media.title || media.fileName;
  // Pakai file yang tersimpan di server dulu (gak ada batas 20 MB kayak
  // download dari Telegram). Cuma kalau file lokalnya udah gak ada (kehapus
  // sweeper / server dipindah) baru coba ambil dari Telegram -- yang cuma
  // berhasil buat video <= 20 MB.
  const localPath = entry.videoPath && fs.existsSync(entry.videoPath) ? entry.videoPath : null;
  if (!localPath && !media.fileId) {
    throw new Error('File video sudah tidak ada di server. Minta user request ulang.');
  }
  const tempPath = localPath || await downloadTgFile(media.fileId);

  // Kalau job ini kepotong restart di tengah upload klip, lanjut dari klip
  // terakhir yang udah tercatat (lihat opts.resume di lib/robloxVideo.js).
  const savedJob = getJob(id) || {};
  const resume = (savedJob.fps && Array.isArray(savedJob.assetIds) && savedJob.assetIds.length)
    ? { fps: savedJob.fps, assetIds: savedJob.assetIds } : null;
  const onCheckpoint = (state) => updateJob(id, { stage: 'video', fps: state.fps, assetIds: state.assetIds });

  let lastEditAt = 0;
  const onProgress = (current, total) => {
    const now = Date.now();
    // Throttle edit pesan Telegram -- jangan tiap 1 klip langsung edit (bisa
    // kena rate limit Telegram sendiri kalau videonya banyak klip). Cukup
    // tiap ~4 detik ATAU pas klip terakhir.
    if (now - lastEditAt < 4000 && current !== total) return;
    lastEditAt = now;
    const progressText = replaceStatusLine(text, `🔄 (pending) — upload klip ${current}/${total} ke Roblox...`);
    editCard(chatId, messageId, isCaption, progressText, { inline_keyboard: [] }).catch(() => {});
  };

  let keepTempPath = false;
  let keepOnError  = false;
  try {
    const { uploadVideoAsFrames } = require('../lib/robloxVideo');
    const { assetIds, frameCount, fps, duration } = await uploadVideoAsFrames(tempPath, title, onProgress, { resume, onCheckpoint });

    updateLogStatus(id, 'approved', { stage: 'sukses_tunggu_share' });
    removeClaim(id);
    // Video ASLI-nya (tempPath) JANGAN dihapus dulu -- masih dibutuhin buat
    // dikirim fisik ke saluran/DM pas tombol "Share" ditekan nanti (persis
    // pola yang sama kayak banner/Image, lihat finalizeRequestApproved).
    // VIP/VVIP: hasilnya cuma masuk "ID Saya" (gak ada pengiriman fisik video ke saluran),
    // jadi file videonya langsung dihapus -- gak ditahan berjam-jam di server. Non-VIP tetap
    // disimpan buat tahap share.
    keepTempPath = !(entry.username && isPremium(entry.username));
    upsertHistory({
      fileName: entry.title, title: entry.title, assetId: assetIds[0], assetIds, tempPath,
      status: 'approved', archived: false, permissionGranted: true, assetType: 'VideoFrames', requestId: id
    });

    // FIX: sebelumnya ID digabung langsung di CAPTION pesan Telegram --
    // begitu jumlah klip banyak (video agak panjang / fps tinggi), caption-nya
    // ngelewatin batas panjang Telegram dan gagal kirim total (error
    // "MEDIA_CAPTION_TOO_LONG" di log server). Sekarang daftar ID ditulis
    // ke file .txt terpisah dan dikirim sebagai dokumen -- caption pesan
    // utamanya tetap pendek & aman berapa pun banyaknya klip.
    const idList = assetIds.join(',');
    const finalText = replaceStatusLine(
      text,
      `✅ Sukses (tunggu share) — ${frameCount} klip (${fps} fps, durasi ${duration.toFixed(1)}s)\n\n🆔 Daftar ID ada di file .txt terlampir (urutan sesuai video).`
    );
    const shareKeyboard = { inline_keyboard: [[{ text: '📤 Share ke Saluran', callback_data: `raDoneReq:${assetIds[0]}` }]] };
    await editCard(chatId, messageId, isCaption, finalText, shareKeyboard);

    const txtPath = tmpPath(`videotron-${id}.txt`);
    fs.writeFileSync(txtPath, idList, 'utf8');
    try {
      await sendDocumentTo(chatId, txtPath, `Video Tron #${id} — ${frameCount} klip, urut sesuai video.`, `videotron-${id}.txt`);
    } finally {
      fs.unlink(txtPath, () => {});
    }

    // Mode /autoshare: langsung dibagikan tanpa nunggu admin menekan Share.
    await maybeAutoShare(assetIds[0], {
      chatId, messageId,
      onFail: (reason) => editCard(chatId, messageId, isCaption, finalText + `\n⚠️ Auto-share gagal (${reason}) — tekan Share buat coba lagi.`, shareKeyboard),
    });
  } catch (err) {
    // Gagal karena penyimpanan penuh: file video-nya DIPERTAHANKAN supaya percobaan ulang
    // otomatis (runUploadJob) masih bisa memakainya.
    if (isNoSpaceError(err) || err.code === 'NO_SPACE') keepOnError = true;
    throw err;
  } finally {
    if (!keepTempPath && !keepOnError) fs.unlink(tempPath, () => {});
  }
}

async function performRequestUpload(chatId, messageId, isCaption, text, id, entry, media, title, assetType) {
  text = replaceStatusLine(text, '🔄 (pending) — sedang upload ke Roblox...');
  await editCard(chatId, messageId, isCaption, text, { inline_keyboard: [] });

  // Job yang kepotong restart: pakai lagi file yang udah di-download kalau
  // masih ada, dan KALAU asset-nya udah sempat dibuat di Roblox (operationPath
  // tercatat) jangan upload ulang -- langsung nunggu hasilnya. File cuma
  // WAJIB ada kalau belum sempat upload; kalau asset udah dibuat & file-nya
  // ilang, dicoba download ulang (best-effort) dan kalau gagal tetap lanjut
  // (audio gak butuh file lagi; banner cuma butuh buat share fisik gambar).
  const savedJob = getJob(id) || {};
  let tempPath = savedJob.tempPath && fs.existsSync(savedJob.tempPath) ? savedJob.tempPath : null;
  if (!tempPath) {
    try {
      tempPath = await downloadTgFile(media.fileId);
      updateJob(id, { tempPath });
    } catch (dlErr) {
      if (!savedJob.operationPath) throw dlErr;
      tempPath = tmpPath(`missing_${id}`); // placeholder: file gak ada, tapi kode di bawah aman
    }
  }
  try {
    let createdPath = savedJob.operationPath;
    if (!createdPath) {
      const created = await uploadAssetToRoblox(tempPath, title, assetType, media.contentType);
      createdPath = created.path;
      updateJob(id, { stage: 'created', operationPath: createdPath });
    }
    const asset = await waitForAssetCreated(createdPath, {}, assetType);
    const assetId = asset.assetId;
    const initialState = asset?.moderationResult?.moderationState;
    const state = await fastCheckModeration(assetId, initialState, {}, assetType);

    if (normalizeModerationState(state) === 'APPROVED') {
      await finalizeRequestApproved(chatId, messageId, isCaption, text, id, entry, assetId, assetType, tempPath);
    } else if (normalizeModerationState(state) === 'REJECTED') {
      await finalizeRequestRejected(chatId, messageId, isCaption, text, id, entry, assetId, tempPath);
    } else {
      text = replaceStatusLine(text, '🔄 (pending) — masih direview moderasi Roblox...');
      await editCard(chatId, messageId, isCaption, text, { inline_keyboard: [] });
      addPending({
        assetId, fileName: media.fileName, title, tempPath,
        fileId: media.fileId || null,
        fileUniqueId: media.fileUniqueId || null, chatId, statusMessageId: messageId, assetType,
        isRequestUpload: true, requestId: id, isCaption, rawText: text
      });
      backgroundPollRequestModeration(chatId, messageId, isCaption, text, id, entry, assetId, tempPath, assetType)
        .catch((err) => console.error('[RequestUpload] Background poll error:', err.message));
    }
  } catch (err) {
    if (tempPath) fs.unlink(tempPath, () => {});
    throw err;
  }
}

async function backgroundPollRequestModeration(chatId, messageId, isCaption, text, id, entry, assetId, tempPath, assetType) {
  // Patokan waktu = kapan asset masuk daftar pending (tetap benar walau server restart & polling dimulai ulang).
  const startedAt = pendingStartedAt(assetId, entry && entry.ts);
  let notedSlow = false;

  while (!moderationExpired(startedAt)) {
    await sleep(moderationPollDelay(startedAt));

    if (!notedSlow && moderationIsSlow(startedAt)) {
      notedSlow = true;
      text = replaceStatusLine(text, '⏳ Moderasi Roblox belum selesai (>90 menit) — tetap dipantau otomatis, hasilnya diproses begitu keluar');
      await editCard(chatId, messageId, isCaption, text, { inline_keyboard: [] }).catch(() => {});
    }

    let asset;
    try {
      asset = await getAsset(assetId, assetType);
    } catch (e) {
      continue; // diem2 aja, biar gak spam edit tiap error jaringan sesaat
    }
    const state = asset?.moderationResult?.moderationState;
    if (normalizeModerationState(state) === 'APPROVED') {
      removePending(assetId);
      await finalizeRequestApproved(chatId, messageId, isCaption, text, id, entry, assetId, assetType, tempPath);
      return;
    }
    if (normalizeModerationState(state) === 'REJECTED') {
      removePending(assetId);
      await finalizeRequestRejected(chatId, messageId, isCaption, text, id, entry, assetId, tempPath);
      return;
    }
  }

  // Sudah 48 jam tanpa hasil dari Roblox: tutup dengan rapi (status "gagal" -> limit user & kuota sesi
  // dikembalikan, sama seperti gagal upload) -- bukan dibiarkan pending selamanya.
  removePending(assetId);
  updateLogStatus(id, 'rejected', { stage: 'gagal' });
  removeClaim(id);
  if (entry && entry.username && entry.type !== 'video') {
    const limitType = entry.type === 'banner' ? 'banner' : 'song';
    refundRateLimit(entry.username, limitType);
    decrementCount(limitType);
  }
  text = replaceStatusLine(text, '⚠️ Moderasi Roblox >48 jam tanpa hasil — request ditutup, limit dikembalikan. Cek asset di Creator Dashboard kalau perlu.');
  await editCard(chatId, messageId, isCaption, text, { inline_keyboard: [] }).catch(() => {});
  fs.unlink(tempPath, () => {});
}

async function finalizeRequestApproved(chatId, messageId, isCaption, text, id, entry, assetId, assetType, tempPath) {
  // Audio: gak perlu file mp3-nya lagi setelah ini (share cuma teks).
  // Image: file-nya JANGAN dihapus dulu -- masih dibutuhin buat dikirim
  // fisik ke saluran/DM pas tombol Done ditekan nanti.
  if (assetType !== 'Image') fs.unlink(tempPath, () => {});

  updateLogStatus(id, 'approved', { stage: 'sukses_tunggu_share' });
  removeClaim(id);
  upsertHistory({
    fileName: entry.title, title: entry.title, assetId, status: 'approved', archived: false,
    permissionGranted: false, tempPath: assetType === 'Image' ? tempPath : null, assetType, requestId: id
  });

  let permissionLine = '';
  let permissionGranted = false;
  if (assetType === 'Image') {
    permissionGranted = true;
  } else {
    try {
      const perm = await autoGrantPermission(assetId);
      if (!perm.skipped) permissionGranted = true;
      else permissionLine = `\n⚠️ ${perm.reason}`;
    } catch (permErr) {
      const permErrMsg = describePermError(permErr);
      permissionLine = `\n⚠️ Auto-grant izin gagal (${permErrMsg}). Kasih izin manual:\nhttps://create.roblox.com/dashboard/creations/store/${assetId}/permissions`;
      notifyRobloxAccountIssueIfNeeded(permErr);
    }
  }

  const idLine = `\n🆔 <b>ID:</b> <code>${assetId}</code>`;
  const finalText = replaceStatusLine(text, `✅ Sukses (tunggu share)${permissionLine}`) + idLine;
  const doneKeyboard = { inline_keyboard: [[{ text: '✅ Done, share ke saluran', callback_data: `raDoneReq:${assetId}` }]] };
  await editCard(chatId, messageId, isCaption, finalText, doneKeyboard);

  if (permissionGranted) upsertHistory({ assetId, permissionGranted: true });

  // Mode /autoshare: langsung dibagikan tanpa nunggu admin menekan Done.
  await maybeAutoShare(assetId, {
    chatId, messageId,
    onFail: (reason) => editCard(chatId, messageId, isCaption, finalText + `\n⚠️ Auto-share gagal (${reason}) — tekan Done buat coba lagi.`, doneKeyboard),
  });
}

async function finalizeRequestRejected(chatId, messageId, isCaption, text, id, entry, assetId, tempPath) {
  let archiveNote = '';
  if (assetId) {
    try {
      await archiveAssetOnRoblox(assetId);
      archiveNote = '\n📦 Asset udah diarsipkan di Roblox.';
    } catch (e) { /* diemin, gak krusial */ }
  }
  // Backup lokal file audio DIHAPUS -- gak nyimpen audio apapun di disk
  // server biar gak numpuk/penuhin memori panel. Langsung dihapus aja.
  fs.unlink(tempPath, () => {});

  updateLogStatus(id, 'rejected', { stage: 'ditolak' });
  removeClaim(id);
  // Ditolak = HANYA limit PRIBADI user yang dikembalikan; kuota sesi GLOBAL tidak dikurangi lagi.
  if (entry.username) refundRateLimit(entry.username, entry.type === 'banner' ? 'banner' : 'song');
  if (assetId) upsertHistory({ fileName: entry.title, title: entry.title, assetId, status: 'rejected', archived: !!archiveNote, permissionGranted: false, tempPath: null, requestId: id });

  const finalText = replaceStatusLine(text, `❌ Ditolak moderasi Roblox${archiveNote}`);
  await editCard(chatId, messageId, isCaption, finalText, { inline_keyboard: [] });
}

// Dipanggil dari callback_query "raDoneReq:<assetId>" — admin tap Done setelah kasih izin manual
// ── SHARE hasil upload (dipakai tombol "Done/Share" DAN mode /autoshare) ──────────────
// VIP/VVIP: ID disimpan ke halaman "ID Saya" (gak dikirim ke WhatsApp sama sekali).
// User biasa: dikirim ke saluran WA. Kartu request dihapus setelah sukses.
const sharingNow = new Set();   // cegah share dobel (tombol ditekan pas auto-share lagi jalan, dll)

async function performRequestShare(assetId, { chatId = null, messageId = null, answer = async () => {}, auto = false } = {}) {
  assetId = String(assetId);
  if (sharingNow.has(assetId)) { await answer('⏳ Share untuk asset ini lagi diproses...'); return { ok: false, busy: true, reason: 'sedang diproses' }; }
  sharingNow.add(assetId);
  try {
    const history = RA.loadHistory();
    const entry = history.find((e) => String(e.assetId) === assetId);
    if (!entry) { await answer('⚠️ Data asset ini gak ketemu di history.'); return { ok: false, reason: 'data asset tidak ada di history' }; }

    const reqEntry = entry.requestId ? findEntry(entry.requestId) : null;
    // Sudah pernah dibagikan (mis. auto-share sudah jalan, lalu tombol ditekan) -> jangan kirim ulang.
    if (reqEntry && reqEntry.stage === 'sukses') {
      await answer('✅ Sudah dibagikan sebelumnya.');
      if (chatId && messageId) await deleteMessage(chatId, messageId);
      return { ok: true, already: true };
    }

    upsertHistory({ assetId, permissionGranted: true });
    const isVip = reqEntry && reqEntry.username && isPremium(reqEntry.username);

    // VIP/VVIP: ID (bukan file mentahnya) disimpan ke inbox privat "ID Saya"
    // di web/app -- GAK dikirim ke WhatsApp sama sekali (baik saluran publik
    // maupun DM pribadi). User biasa tetap ke saluran WA seperti biasa.
    if (isVip) {
      addPrivateId(reqEntry.username, {
        id: assetId,
        ids: entry.assetIds || null,
        title: entry.title || entry.fileName,
        type: entry.assetType === 'VideoFrames' ? 'video' : entry.assetType === 'Image' ? 'banner' : 'song',
        requestId: entry.requestId || null,
      });
    }

    let ok = true;
    if (entry.assetType === 'VideoFrames' && entry.tempPath && fs.existsSync(entry.tempPath)) {
      // Video Tron -- kirim VIDEO-nya dulu TANPA caption raw ID (caption sepanjang
      // daftar ID berisiko kena limit panjang caption WhatsApp -- sama persis kelas
      // bug yang dulu bikin Telegram gagal kirim total gara-gara MEDIA_CAPTION_TOO_LONG,
      // lihat catatan di runUploadJob). Daftar ID BARU dikirim sebagai PESAN TEKS
      // TERPISAH, dan cuma dikirim SETELAH video-nya kekonfirmasi sukses terkirim --
      // biar gak ada ID nyasar ke saluran padahal video-nya sendiri gagal/belum kekirim.
      // Isi teksnya tetap RAW (gak ada emoji/label) biar bisa langsung dicopy-paste
      // apa adanya ke script Roblox. VIP/VVIP: dilewati total (ID-nya udah aman di "ID Saya").
      const idList = (entry.assetIds || [entry.assetId]).join(',');
      if (!isVip) {
        ok = await sendChannelVideo(entry.tempPath, `🎬 Video Tron — ${entry.title || entry.fileName}`);
        if (ok) ok = await sendChannelMessage(idList); // cuma jalan kalau video di atas beneran sukses
      }
      if (ok) fs.unlink(entry.tempPath, () => {});
    } else if (entry.assetType === 'Image' && entry.tempPath && fs.existsSync(entry.tempPath)) {
      // Gambar (banner) -- kirim FISIK gambarnya, caption cuma ID doang.
      const caption = `🆔: ${assetId}`;
      if (!isVip) ok = await sendChannelImage(entry.tempPath, caption);
      if (ok) fs.unlink(entry.tempPath, () => {});
    } else {
      const text = `📄 Judul: ${entry.title || entry.fileName}\n🆔 ID: ${assetId}`;
      if (!isVip) ok = await sendChannelMessage(text);
    }

    if (!ok) {
      await answer('⚠️ Gagal share (cek koneksi WA).');
      return { ok: false, reason: 'gagal kirim ke saluran WA (cek koneksi WA)' };
    }

    await answer(
      isVip
        ? '✅ Sukses & ID sudah masuk ke halaman "ID Saya"!'
        : '✅ Sukses & udah dibagikan ke saluran WA!'
    );
    if (reqEntry) updateLogStatus(reqEntry.id, 'approved', { stage: 'sukses' });
    // Kartu request-nya dihapus (bukan di-edit jadi "Sukses") biar chat gak
    // numpuk kartu-kartu yang udah kelar diproses. Status "sukses" tetap
    // tersimpan di data (bisa dicek /id, /myrequests, dll), cuma kartunya aja
    // yang ilang dari chat. Mode auto: SEMUA salinan kartu (ke tiap admin) ikut dihapus.
    if (chatId && messageId) await deleteMessage(chatId, messageId);
    if (auto && reqEntry) {
      for (const c of (reqEntry.tgMsgs || [])) {
        if (!c.chatId || !c.msgId) continue;
        if (String(c.chatId) === String(chatId) && String(c.msgId) === String(messageId)) continue;
        await deleteMessage(c.chatId, c.msgId).catch(() => {});
      }
    }
    return { ok: true, vip: !!isVip };
  } finally {
    sharingNow.delete(assetId);
  }
}

// Dipanggil dari callback_query "raDoneReq:<assetId>" — admin tap "Done/Share".
async function handleRequestDoneButton(cq) {
  const assetId = cq.data.split(':')[1];
  await performRequestShare(assetId, {
    chatId: cq.message.chat.id,
    messageId: cq.message.message_id,
    answer: (text) => _answerCallback(cq.id, text),
  });
}

// Mode /autoshare: dipanggil begitu upload sukses & kartu sudah diubah jadi "Sukses (tunggu share)".
// Kalau share otomatis gagal, kartu TETAP punya tombol Done/Share + catatan -- admin bisa coba manual.
async function maybeAutoShare(assetId, { chatId, messageId, onFail }) {
  if (!getAutoMode().share) return;
  try {
    const res = await performRequestShare(assetId, { chatId, messageId, auto: true });
    if (!res.ok && !res.busy && onFail) await onFail(res.reason || 'gagal');
  } catch (e) {
    console.error('[AutoShare] gagal:', e.message);
    if (onFail) await onFail(e.message).catch(() => {});
  }
}

// Mode /autoupload: dipanggil route web/APK begitu kartu request terkirim ke Telegram & log dibuat.
// tgMessage = objek Message dari Bot API (hasil sendAudio/sendPhoto/sendDocument/sendMessage).
function triggerAutoUpload(id, tgMessage) {
  if (!getAutoMode().upload) return false;
  if (!tgMessage || !tgMessage.chat || !tgMessage.message_id) return false;
  // Sedikit jeda supaya route sempat menyelesaikan respons ke user & broadcast salinan kartu.
  setTimeout(() => {
    handleRequestUploadButton({ id: null, data: `raUpload:${id}`, message: tgMessage, auto: true })
      .catch((e) => console.error('[AutoUpload]', e.message));
  }, 300);
  return true;
}

// Lepas tombol di salinan kartu milik admin lain (kartu di-broadcast ke beberapa admin) begitu
// upload dimulai, supaya gak ada tombol basi yang bisa ditekan.
function stripOtherCopies(entry, chatId, messageId) {
  for (const c of ((entry && entry.tgMsgs) || [])) {
    if (!c.chatId || !c.msgId) continue;
    if (String(c.chatId) === String(chatId) && String(c.msgId) === String(messageId)) continue;
    Promise.resolve(editMessageMarkup(c.chatId, c.msgId, { inline_keyboard: [] })).catch(() => {});
  }
}

// Dipanggil sekali pas server start — lanjutin upload yang masih pending dari kartu request
// (tahap "masih direview moderasi Roblox").
function resumeRequestPendingChecks() {
  const list = loadPendingList().filter((e) => e.isRequestUpload);
  for (const p of list) {
    resumeOnePendingCheck(p)
      .catch((err) => console.error('[RequestUpload] Resume poll error:', err.message));
  }
  if (list.length) console.log(`[RobloxAudioRequest] Lanjutin pemantauan ${list.length} upload dari kartu request...`);
}

async function resumeOnePendingCheck(p) {
  // File sementaranya bisa aja udah gak ada (tmp ke-reset pas restart).
  // Dulu pending-nya DIBUANG diam-diam dan kartu nyangkut selamanya --
  // sekarang tetap dipantau: audio gak butuh file lagi setelah lolos, dan
  // banner yang filenya hilang cuma dibagikan sebagai teks ID (lihat
  // handleRequestDoneButton). Kalau masih ada fileId, coba ambil ulang.
  let tp = p.tempPath || tmpPath(`missing_${p.requestId}`);
  if (!fs.existsSync(tp) && p.assetType === 'Image' && p.fileId) {
    try { tp = await downloadTgFile(p.fileId); } catch (e) { /* lanjut tanpa file */ }
  }
  const entry = findEntry(p.requestId) || {};
  await backgroundPollRequestModeration(p.chatId, p.statusMessageId, p.isCaption, p.rawText, p.requestId, entry, p.assetId, tp, p.assetType);
}

module.exports = { handleRequestUploadButton, handleRequestDoneButton, performRequestShare, triggerAutoUpload, resumeRequestPendingChecks, resumeUploadJobs };
