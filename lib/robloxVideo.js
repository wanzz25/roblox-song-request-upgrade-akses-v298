// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║   Roblox Video — Pecah video jadi klip gambar               ║
// ║   (upload video di Roblox itu BERBAYAR, jadi video          ║
// ║    dipotong jadi banyak gambar/Image yang kalau di-play     ║
// ║    berurutan cepat di Roblox JADI KELIATAN kayak video)     ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { makeTmpDir, ensureBudget } = require('./tempdir');
const { execFile } = require('child_process');
const CFG  = require('../config');
const { getAudioDuration } = require('./audio'); // ffprobe format=duration -- generik, jalan juga buat file video
const { uploadAssetToRoblox, waitForAssetCreated, fastCheckModeration, normalizeModerationState, sleep } = require('./robloxAudio');

const MIN_FPS           = Number(CFG.VIDEO_MIN_FPS)           || 8;
const MAX_FPS           = Number(CFG.VIDEO_MAX_FPS)           || 15;
const MAX_DURATION_SEC  = Number(CFG.VIDEO_MAX_DURATION_SEC)  || 30;

// ── FPS klip video ─────────────────────────────────────────────────────────
// FPS TIDAK lagi diturunin berdasar ukuran file (MB). Dulu file > 8/15/30 MB
// otomatis dapet FPS lebih rendah -- itu bikin video yang durasinya wajar
// tapi kebetulan "berat" jadi kualitasnya dipangkas tanpa alasan jelas.
// Sekarang patokannya DURASI: video harus <= MAX_DURATION_SEC (dicek di
// routes/api.js pas user upload & sekali lagi di uploadVideoAsFrames), dan
// selama lolos batas itu semuanya dapet FPS yang sama (MAX_FPS). Ukuran file
// cuma dibatasi 60 MB di lib/uploads.js. Jumlah klip akhir SENGAJA gak
// dibatasi -- video 30 detik di FPS 15 jadi ~450 klip, itu wajar.
// (Parameter durationSec & fileSizeBytes dipertahankan biar pemanggil lama
// gak error, tapi gak dipakai.)
function computeDynamicFps(durationSec, fileSizeBytes) { // eslint-disable-line no-unused-vars
  return Math.max(MIN_FPS, Math.min(MAX_FPS, Math.round(MAX_FPS)));
}

// Ambil durasi video (detik) -- pakai ffprobe yang sama kayak audio, generik
// buat semua jenis file media, bukan cuma audio.
async function getVideoDuration(videoPath) {
  return getAudioDuration(videoPath);
}

// Pecah video jadi frame-frame JPG pakai ffmpeg. Resolusi sengaja diperkecil
// (lebar maks 480px) -- Roblox nampilinnya juga di ukuran kecil (ImageLabel),
// jadi resolusi tinggi cuma buang-buang waktu upload & storage doang.
//
// CATATAN CPU: sengaja dibatasin '-threads 2' + jalan lewat 'nice -n 15' --
// tanpa ini, ffmpeg defaultnya nyomot SEMUA core CPU yang ada buat proses
// secepat mungkin. Di VPS kecil (Pterodactyl biasanya jatah CPU terbatas),
// itu bikin Node.js (yang lagi ngelayanin request lain BARENGAN) jadi ikut
// lemot/nge-lag selama proses extract jalan. Dibikin rendah prioritas +
// batas thread di sini -- extract-nya jadi dikit lebih lama, tapi server
// tetap responsif buat user lain yang lagi request lagu/banner bersamaan.
function extractFrames(videoPath, fps) {
  return new Promise((resolve, reject) => {
    const outDir = makeTmpDir('vidframes-');
    const pattern = path.join(outDir, 'frame_%04d.jpg');
    const ffmpegArgs = ['-y', '-i', videoPath, '-vf', `fps=${fps},scale=480:-2`, '-q:v', '4', '-threads', '2', pattern];

    const finish = (err, stderr) => {
      if (err) {
        try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
        return reject(new Error('ffmpeg gagal pecah video jadi frame: ' + (stderr || err.message)));
      }
      const files = fs.readdirSync(outDir)
        .filter(f => f.startsWith('frame_') && f.endsWith('.jpg'))
        .sort() // nama file udah zero-padded (frame_0001.jpg dst) jadi sort abjad = sort urutan waktu
        .map(f => path.join(outDir, f));
      if (!files.length) {
        try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
        return reject(new Error('ffmpeg gak menghasilkan frame sama sekali (video kosong/rusak?)'));
      }
      resolve({ outDir, files });
    };

    // 'nice' turunin prioritas proses ffmpeg biar gak rebutan CPU sama
    // Node.js yang lagi ngelayanin request lain bersamaan. Kalau image
    // Docker-nya kebetulan gak punya binary 'nice' (jarang, tapi jaga-jaga),
    // fallback jalanin ffmpeg langsung tanpa nice drpd fitur ini total gagal.
    execFile('nice', ['-n', '15', 'ffmpeg', ...ffmpegArgs], { timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') {
        return execFile('ffmpeg', ffmpegArgs, { timeout: 5 * 60 * 1000 }, (err2, stdout2, stderr2) => finish(err2, stderr2));
      }
      finish(err, stderr);
    });
  });
}

// ── Proses utama: video -> frame -> upload ke Roblox (paralel per-batch) ──
// Dulu upload klip STRIKTLY satu-satu (nunggu klip 1 kelar total baru mulai
// klip 2, dst) -- aman tapi lambat, apalagi tiap klip juga harus nunggu
// moderasi Roblox. Sekarang diupload BERBARENGAN dalam kelompok kecil
// (default 3 klip sekaligus) -- throughput-nya naik ~3x lipat tanpa nembak
// SEMUA klip sekaligus ke Roblox (yang bisa langsung kena rate-limit 429).
// Urutan hasil akhir (assetIds) tetap dijaga sesuai urutan video asli,
// walau proses upload-nya sendiri gak berurutan lagi.
const UPLOAD_CONCURRENCY = Number(CFG.VIDEO_UPLOAD_CONCURRENCY) || 3;

// onProgress(current, total) dipanggil tiap 1 batch kelar, buat update status
// pesan Telegram secara berkala (biar admin tau ini masih jalan, bukan macet).
//
// opts (opsional) -- biar upload TAHAN RESTART SERVER:
//   opts.onCheckpoint({ fps, assetIds }) : dipanggil tiap 1 batch kelar dgn
//        daftar assetId klip yang SUDAH selesai (urut dari klip pertama),
//        supaya pemanggil bisa nyimpennya ke disk.
//   opts.resume { fps, assetIds }        : lanjutin dari checkpoint itu --
//        video di-extract ulang dgn fps YANG SAMA (hasil ffmpeg deterministik,
//        jadi klip ke-N tetap klip yang sama), klip yang sudah terupload
//        dilewati & assetId-nya dipakai lagi, gak diupload ulang.
async function uploadVideoAsFrames(videoPath, title, onProgress, opts = {}) {
  const { resume = null, onCheckpoint = null } = opts;
  const duration = await getVideoDuration(videoPath);
  if (duration > MAX_DURATION_SEC) {
    throw new Error(
      `Video ini durasinya ${duration.toFixed(1)} detik, melebihi batas maksimal ${MAX_DURATION_SEC} detik. Pendekin videonya dulu.`
    );
  }

  const fileSizeBytes = fs.statSync(videoPath).size;
  const fps = (resume && Number(resume.fps)) || computeDynamicFps(duration, fileSizeBytes);

  // Frame JPEG 480px ~ 25-60 KB per klip. Pastikan ada tempat SEBELUM ffmpeg mulai nulis --
  // kalau penuh di tengah ekstraksi, ffmpeg gagal dgn ENOSPC & frame setengah jadi numpuk.
  ensureBudget(Math.ceil(duration * fps) * 80 * 1024 + 5 * 1024 * 1024, 'frame video');
  const { outDir, files } = await extractFrames(videoPath, fps);

  try {
    const assetIds = new Array(files.length);

    // Lanjutin dari checkpoint (kalau ada & masuk akal). Kalau jumlah klip
    // checkpoint lebih banyak dari hasil extract sekarang (video/fps beda),
    // checkpoint diabaikan dan mulai dari awal -- lebih aman daripada nyambung
    // ke urutan yang gak cocok.
    let startIndex = 0;
    if (resume && Array.isArray(resume.assetIds) && resume.assetIds.length > 0 && resume.assetIds.length <= files.length) {
      resume.assetIds.forEach((a, i) => { assetIds[i] = a; });
      startIndex = resume.assetIds.length;
      for (let i = 0; i < startIndex; i++) fs.unlink(files[i], () => {});
    }

    async function uploadOneFrame(framePath, i) {
      const frameTitle = `${title} - klip ${i + 1}`.slice(0, 50);

      const created = await uploadAssetToRoblox(framePath, frameTitle, 'VideoFrames', 'image/jpeg');
      const asset   = await waitForAssetCreated(created.path, {}, 'VideoFrames');
      const assetId = asset.assetId;

      // Cek moderasi cepat -- kalau ada 1 aja klip yang DITOLAK, seluruh
      // video jadi gak lengkap/putus-putus kalau dipaksa lanjut, jadi
      // langsung berhentiin semuanya di sini drpd lanjut buang-buang API call.
      const state = await fastCheckModeration(assetId, asset?.moderationResult?.moderationState, {}, 'VideoFrames');
      const normalized = normalizeModerationState(state);
      if (normalized === 'REJECTED') {
        throw new Error(`Klip ke-${i + 1} dari ${files.length} ditolak moderasi Roblox (assetId: ${assetId}). Upload video dibatalkan -- video gak akan lengkap kalau dipaksa lanjut.`);
      }

      // Hapus file frame ini DARI STORAGE begitu udah beres keupload --
      // gak ada gunanya lagi disimpan di server abis sukses terkirim.
      fs.unlink(framePath, () => {});
      return assetId;
    }

    for (let b = startIndex; b < files.length; b += UPLOAD_CONCURRENCY) {
      const batch = files.slice(b, b + UPLOAD_CONCURRENCY);
      const results = await Promise.all(batch.map((framePath, j) => uploadOneFrame(framePath, b + j)));
      results.forEach((assetId, j) => { assetIds[b + j] = assetId; });

      const doneCount = Math.min(b + UPLOAD_CONCURRENCY, files.length);
      if (onCheckpoint) { try { onCheckpoint({ fps, assetIds: assetIds.slice(0, doneCount) }); } catch {} }
      if (onProgress) { try { onProgress(doneCount, files.length); } catch {} }

      // Jeda kecil ANTAR-BATCH (bukan antar-frame lagi) -- ngurangin risiko
      // kena rate-limit 429 Roblox tanpa bikin prosesnya balik lambat kayak dulu.
      await sleep(400);
    }

    return { assetIds, frameCount: files.length, fps, duration, resumedFrom: startIndex };
  } finally {
    // Bersihin folder temp frame apapun hasilnya (sukses/gagal di tengah jalan).
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { getVideoDuration, extractFrames, uploadVideoAsFrames, computeDynamicFps, MIN_FPS, MAX_FPS, MAX_DURATION_SEC };
