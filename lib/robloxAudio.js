// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Roblox Audio — Upload/Moderasi/Izin Asset Roblox     ║
// ║        (diintegrasikan dari project roblox-audio-bot-v22)   ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝

const CFG      = require('../config');
const fs       = require('fs');
const path     = require('path');
const { dataFile } = require('./dataPaths');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const { reencodeToMp3 } = require('./audio');

const {
  CREATOR_UID: robloxUserId,
  ASSET_TOKEN: robloxApiKey,
  APP_GROUP_ID: robloxGroupId,
  APP_UNIVERSE_ID: robloxUniverseId,
  PERM_TOKEN: robloxPermissionApiKeyRaw,
  IMAGE_ASSET_TOKEN: robloxImageApiKeyRaw,
  IMAGE_CREATOR_UID: robloxImageUserIdRaw,
  VIDEO_ASSET_TOKEN: robloxVideoApiKeyRaw,
  VIDEO_CREATOR_UID: robloxVideoUserIdRaw,
  AUTH_COOKIE: robloxCookie,
} = CFG;

const robloxPermissionApiKey = robloxPermissionApiKeyRaw || robloxApiKey;
// Key & userId khusus banner/gambar -- kosong berarti fallback ke akun yang
// sama kayak audio (behavior lama, gak ada perubahan kalau belum diisi).
const robloxImageApiKey  = robloxImageApiKeyRaw  || robloxApiKey;
const robloxImageUserId  = robloxImageUserIdRaw  || robloxUserId;
// Key & userId khusus video (assetType internal 'VideoFrames') -- kosong
// berarti fallback ke akun IMAGE (banner) dulu, baru ke akun AUDIO kalau
// itu juga kosong.
const robloxVideoApiKey  = robloxVideoApiKeyRaw  || robloxImageApiKey;
const robloxVideoUserId  = robloxVideoUserIdRaw  || robloxImageUserId;

// Pilih API key & creator userId sesuai jenis asset -- Audio, Image (banner),
// & VideoFrames (klip video) bisa pakai akun/key BEDA-BEDA (biar limitnya
// kepisah, gak saling makan kuota). 'VideoFrames' BUKAN assetType asli
// Roblox -- itu cuma penanda internal buat milih akun; pas beneran ngirim
// ke Roblox tetap dikirim sebagai 'Image' (lihat uploadAssetToRoblox).
// PENTING: key + userId harus SEPASANG dari akun yang sama -- kalau cuma
// header key-nya diganti tapi creationContext.creator.userId masih akun
// lama, Roblox bakal nolak requestnya (mismatch context).
function apiKeyFor(assetType) {
  if (assetType === 'VideoFrames') return robloxVideoApiKey;
  return assetType === 'Image' ? robloxImageApiKey : robloxApiKey;
}
function creatorUserIdFor(assetType) {
  if (assetType === 'VideoFrames') return robloxVideoUserId;
  return assetType === 'Image' ? robloxImageUserId : robloxUserId;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Persistence: history (permanen) & pending (masih dipantau background) ──
const HISTORY_FILE = dataFile('roblox_audio_history.json');
const PENDING_FILE = dataFile('roblox_audio_pending.json');
// Folder roblox_audio_archive DIHAPUS TOTAL -- project ini SENGAJA gak nyimpen
// audio apapun secara permanen di disk (biar gak numpuk/penuhin memori panel).
// Semua file audio cuma ada sementara di folder tmp/ (lib/tempdir.js) selama diproses, lalu
// langsung dihapus abis kelar (baik lolos maupun ditolak).

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) { return []; }
}
function saveHistory(list) {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2)); }
  catch (e) { console.error('Gagal simpan roblox_audio_history.json:', e.message); }
}
function upsertHistory(entry) {
  const list = loadHistory();
  const idx = list.findIndex((e) => e.assetId === entry.assetId);
  if (idx >= 0) list[idx] = { ...list[idx], ...entry };
  else list.push(entry);
  saveHistory(list);
  return list;
}

function loadPendingList() {
  try { return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch (e) { return []; }
}
function savePendingList(list) {
  try { fs.writeFileSync(PENDING_FILE, JSON.stringify(list, null, 2)); }
  catch (e) { console.error('Gagal simpan roblox_audio_pending.json:', e.message); }
}
// ── Waktu tunggu moderasi Roblox ─────────────────────────────────────────────────
// Dulu polling menyerah setelah ~90 menit: request dianggap "cek manual", tetap berstatus pending
// SELAMANYA, dan begitu Roblox akhirnya menyetujui audionya tidak ada yang memberi izin/membagikan.
// (Di backup terakhir ada audio yang sudah 6 jam menunggu.) Sekarang: 90 menit pertama dicek tiap
// 15 detik, sesudahnya tiap 5 menit, dan baru menyerah setelah 48 jam sejak dikirim ke Roblox.
const MODERATION_FAST_MS   = 90 * 60 * 1000;
const MODERATION_GIVEUP_MS = 48 * 60 * 60 * 1000;
const moderationPollDelay = (startedAt) => (Date.now() - startedAt < MODERATION_FAST_MS ? 15000 : 5 * 60 * 1000);
const moderationExpired   = (startedAt) => Date.now() - startedAt > MODERATION_GIVEUP_MS;
const moderationIsSlow    = (startedAt) => Date.now() - startedAt >= MODERATION_FAST_MS;
function pendingStartedAt(assetId, fallback) {
  const p = loadPendingList().find((e) => String(e.assetId) === String(assetId));
  return (p && p.addedAt) || fallback || Date.now();
}

function addPending(entry) {
  const list = loadPendingList().filter((e) => e.assetId !== entry.assetId);
  if (!entry.addedAt) entry.addedAt = Date.now();   // patokan lama menunggu (juga setelah server restart)
  list.push(entry);
  savePendingList(list);
}
function removePending(assetId) {
  const list = loadPendingList().filter((e) => e.assetId !== assetId);
  savePendingList(list);
}

// Tracker anti-duplikat selama proses berjalan (in-memory, reset kalau restart —
// history.json/pending.json yang jadi sumber kebenaran permanen)
const fileTracker = new Map();

// Antrian dengan batas proses paralel — biar banyak file sekaligus gak overload API Roblox
// Upload ke Roblox dibatasi maks 2 bersamaan, sisanya antri (FIFO) dan diproses
// begitu salah satu slot kosong. Ini beda dari tahap "kirim request" di routes/api.js
// yang emang sengaja TANPA BATAS (lihat catatan di sana) -- pembatasan ini
// khusus buat tahap upload asset ke Roblox aja, biar gak kena rate limit 429.
const MAX_CONCURRENT_UPLOADS = 2;
let activeUploads = 0;
const uploadQueue = [];

function runQueued(fn) {
  return new Promise((resolve, reject) => {
    const task = () => {
      activeUploads++;
      fn().then(resolve, reject).finally(() => {
        activeUploads--;
        const next = uploadQueue.shift();
        if (next) next();
      });
    };
    if (activeUploads < MAX_CONCURRENT_UPLOADS) task();
    else uploadQueue.push(task);
  });
}
function getQueuePosition() {
  if (activeUploads < MAX_CONCURRENT_UPLOADS) return 0;
  return uploadQueue.length + 1;
}

// Retry otomatis kalau kena 429 (rate limit) ATAU error jaringan/timeout/5xx
// sesaat dari Roblox. SEBELUMNYA cuma retry di 429 -- akibatnya timeout
// jaringan biasa (koneksi lambat, hiccup sesaat, dsb) langsung gagal total
// tanpa nyoba ulang sama sekali, padahal biasanya berhasil kalau dicoba lagi.
function isRetryableError(err) {
  if (err.robloxStatus === 429) return true;
  if (err.robloxStatus >= 500) return true; // Roblox lagi gangguan sesaat
  if (err.name === 'AbortError') return true; // timeout
  const netCodes = ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'];
  if (netCodes.includes(err.code) || netCodes.includes(err.cause?.code)) return true;
  if (err.type === 'system' || err.errno) return true; // node-fetch FetchError level jaringan
  return false;
}

async function robloxRetry(fn, maxAttempts = 12) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableError(err)) throw err;

      if (attempt === maxAttempts - 1) break; // percobaan terakhir, jangan nunggu lagi -- langsung lempar di bawah

      // Network/5xx/timeout: backoff naik pelan-pelan tapi di-cap 60s per percobaan,
      // biar TOTAL bisa nyoba sampai ~3-4 menit sebelum bener-bener nyerah -- jauh
      // lebih sabar drpd sebelumnya (yang cuma nyoba ~20 detik doang lalu nyerah).
      const waitSec = err.robloxStatus === 429
        ? (err.retryAfter ? parseInt(err.retryAfter, 10) : 3 * (attempt + 1))
        : Math.min(60, 3 * (attempt + 1));
      console.error(`[RobloxRetry] ${err.robloxStatus === 429 ? 'Rate limit' : `Error jaringan (${err.code || err.name || err.message})`}, tunggu ${waitSec}s lalu coba lagi... (percobaan ${attempt + 1}/${maxAttempts})`);
      await sleep(waitSec * 1000);
    }
  }
  throw new Error('Gagal request ke Roblox setelah berkali-kali retry selama beberapa menit (jaringan/rate limit terus bermasalah).');
}

// Helper fetch JSON ke Roblox + lempar error yang seragam (mirip shape axios error
// yang dipakai kode aslinya: err.response.status / err.response.data)
//
// CATATAN PENTING: source asli (roblox-audio-bot-v22, pakai axios) SAMA SEKALI
// gak pasang timeout di request Roblox manapun -- makanya kata pemiliknya versi
// itu "gapernah gagal". Versi sini sebelumnya kasih timeout 60-120 detik yang
// KETAT, jadi upload yang sebenernya cuma lagi lambat (bukan macet beneran)
// malah dianggap gagal. Sekarang disamain filosofinya: default timeout dibikin
// SANGAT longgar (10 menit) -- ini murni jaring pengaman terakhir buat koneksi
// yang BENERAN macet total, bukan buat "wajar"-in kegagalan karena lambat.
async function robloxFetch(url, opts = {}, timeoutMs = 600000) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  let data = null;
  try { data = await res.json(); } catch (e) { /* body kosong/non-JSON, biarkan null */ }
  if (!res.ok) {
    const err = new Error(data?.message || data?.error?.message || data?.errors?.[0]?.message || `Roblox HTTP ${res.status}`);
    err.robloxStatus = res.status;
    err.retryAfter = res.headers.get('retry-after');
    err.response = { status: res.status, data, headers: Object.fromEntries(res.headers.entries()) };
    // 401/403 di Open Cloud API bisa macem-macem sebabnya (token expired,
    // scope kurang, dll) TAPI salah satu kemungkinannya ya akun/token emang
    // lagi di-warn/restrict/ban sama Roblox. Gak ada cara pasti bedain dari
    // response doang, jadi ini cuma "kecurigaan", bukan kepastian -- makanya
    // pesannya nanti bakal dikasih pilihan/kemungkinan, bukan klaim pasti.
    if (res.status === 401 || res.status === 403) err.suspectedAccountIssue = true;
    throw err;
  }
  return data;
}

async function archiveAssetOnRoblox(assetId) {
  return robloxFetch(`https://apis.roblox.com/assets/v1/assets/${assetId}:archive`, {
    method: 'POST',
    headers: { 'x-api-key': robloxApiKey, 'Content-Type': 'application/json' },
    body: '{}'
  });
}

// Upload audio/gambar ke Roblox Open Cloud Assets API
async function uploadAssetToRoblox(filePath, displayName, assetType, contentType) {
  // Jaring pengaman terakhir sebelum nyampe Roblox: buat Audio, paksa
  // normalisasi ke MP3 ASLI dulu. lib/audio.js udah ngelakuin ini pas
  // auto-download YouTube, TAPI file yang di-upload LANGSUNG (forward dari
  // Telegram, dll) belum tentu lewat situ -- jadi dicek ulang di sini biar
  // Roblox gak pernah nolak "Invalid file type" gara-gara format aneh
  // (AAC/M4A/OPUS yang cuma di-rename .mp3).
  if (assetType === 'Audio') {
    try {
      await reencodeToMp3(filePath);
      contentType = 'audio/mpeg';
    } catch (e) {
      console.warn('[uploadAssetToRoblox] Gagal normalisasi MP3, lanjut pakai file asli apa adanya:', e.message);
    }
  }

  // 'VideoFrames' cuma penanda internal (buat pilih akun) -- yang beneran
  // dikirim ke Roblox harus 'Image' (Roblox gak punya assetType lain itu).
  const robloxRealAssetType = assetType === 'VideoFrames' ? 'Image' : assetType;

  return robloxRetry(async () => {
    const form = new FormData();
    const requestJson = JSON.stringify({
      assetType: robloxRealAssetType,
      displayName: displayName.slice(0, 50),
      description: 'Uploaded via Telegram bot',
      creationContext: { creator: { userId: String(creatorUserIdFor(assetType)) } }
    });
    form.append('request', requestJson);
    form.append('fileContent', fs.createReadStream(filePath), { filename: displayName, contentType });

    return robloxFetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'POST',
      headers: { ...form.getHeaders(), 'x-api-key': apiKeyFor(assetType) },
      body: form
    });
  });
}

async function getOperation(operationPath, assetType) {
  const opId = operationPath.split('/').pop();
  return robloxRetry(() => robloxFetch(`https://apis.roblox.com/assets/v1/operations/${opId}`, {
    headers: { 'x-api-key': apiKeyFor(assetType) }
  }));
}

function normalizeModerationState(raw) {
  if (!raw) return null;
  const s = String(raw).toUpperCase();
  if (s.includes('APPROV')) return 'APPROVED';
  if (s.includes('REJECT')) return 'REJECTED';
  if (s.includes('REVIEW')) return 'REVIEWING';
  return 'OTHER';
}

async function getAsset(assetId, assetType) {
  return robloxRetry(() => robloxFetch(`https://apis.roblox.com/assets/v1/assets/${assetId}`, {
    headers: { 'x-api-key': apiKeyFor(assetType) }
  }));
}

// Tunggu asset selesai dibuat (operation selesai) — timeout ~3.3 menit
async function waitForAssetCreated(operationPath, opts = {}, assetType) {
  // opTries dinaikin jauh (dari 200 jadi 1800 = 30 menit) -- ini nunggu Roblox
  // SELESAI MEMPROSES pembuatan asset-nya (bukan moderasi), yang biasanya
  // cepet tapi kadang bisa lama kalau server Roblox lagi sibuk. Yang bikin
  // gagal cuma kalau Roblox EXPLISIT NOLAK filenya (op.error) -- itu emang
  // keputusan final dari Roblox, bukan soal sabar/gak sabar nunggu.
  const { opTries = 1800, opInterval = 1000 } = opts;
  for (let i = 0; i < opTries; i++) {
    const op = await getOperation(operationPath, assetType);
    if (op.done) {
      if (op.error) throw new Error(`Roblox menolak file ini: ${op.error.message || JSON.stringify(op.error)}`);
      if (!op.response || !op.response.assetId) throw new Error('Roblox tidak mengembalikan data asset yang valid (response kosong).');
      return op.response;
    }
    await sleep(opInterval);
  }
  throw new Error('Roblox belum juga selesai proses file ini setelah 30 menit (cek manual di Creator Dashboard).');
}

// Cek cepat status moderasi (dipakai di awal sebelum lanjut background polling)
async function fastCheckModeration(assetId, initialState, opts = {}, assetType) {
  const { tries = 40, interval = 750 } = opts;
  let state = initialState;
  for (let i = 0; i < tries && normalizeModerationState(state) === 'REVIEWING'; i++) {
    await sleep(interval);
    const fresh = await getAsset(assetId, assetType);
    state = fresh?.moderationResult?.moderationState;
  }
  return state;
}

// ── Auto-grant izin "Use" (Beta/kadang gak stabil di sisi Roblox) ──
async function getRobloxCsrfToken(cookie) {
  try {
    await robloxFetch('https://apis.roblox.com/asset-permissions-api/v1/assets/permissions', {
      method: 'PATCH',
      headers: { Cookie: `.ROBLOSECURITY=${cookie}`, 'Content-Type': 'application/json' },
      body: '{}'
    });
  } catch (err) {
    const token = err.response?.headers?.['x-csrf-token'];
    if (token) return token;
    throw err;
  }
  throw new Error('Gagal ambil CSRF token dari Roblox.');
}

async function grantPermissionViaCookie(assetId, candidates) {
  const csrfToken = await getRobloxCsrfToken(robloxCookie);
  let lastError = null;
  for (const subject of candidates) {
    try {
      const data = await robloxFetch('https://apis.roblox.com/asset-permissions-api/v1/assets/permissions', {
        method: 'PATCH',
        headers: { Cookie: `.ROBLOSECURITY=${robloxCookie}`, 'X-CSRF-TOKEN': csrfToken, 'Content-Type': 'application/json' },
        // bentuk resmi: subjek di level atas, asset di requests[]
        body: JSON.stringify({ subjectType: subject.subjectType, subjectId: String(subject.subjectId), action: 'Use', requests: [{ assetId: Number(assetId) }] })
      }, 30000);
      const ev = evalPermResponse(data, assetId);
      if (!ev.ok) { lastError = Object.assign(new Error(ev.message), { response: { status: 200, data } }); continue; }
      return { skipped: false, ok: true, subjects: [subject], data, usedVariant: `[COOKIE] ${subject.subjectType}` };
    } catch (err) { lastError = err; }
  }
  throw lastError || new Error('Grant via cookie gagal.');
}

// ════════════════════════════════════════════════════════════════════════════════
// AUTO-GRANT IZIN "Use" (audio) -- sesuai DOKUMENTASI RESMI Roblox
// ════════════════════════════════════════════════════════════════════════════════
// PATCH https://apis.roblox.com/asset-permissions-api/v1/assets/permissions  (scope: asset-permissions:write)
// Body (BatchGrantPermissionsRequest) -- subjek di LEVEL ATAS, bukan di dalam requests[]:
//   {
//     "subjectType": "Group" | "User" | "Universe",   <- siapa yang dikasih izin
//     "subjectId":   "35858415",                      <- ID-nya (string)
//     "action":      "Use",
//     "requests":    [ { "assetId": 89788234745968 } ]  <- daftar asset (atau "assetIds": [..], deprecated)
//   }
// Respons 200: { "successAssetIds": [..], "errors": [ { "assetId", "code" } ] }
//
// Versi lama mengirim subjectType/subjectId DI DALAM requests[] -> Roblox membacanya kosong
// dan menjawab "Invalid SubjectType is invalid" (400) untuk SEMUA percobaan. Terbukti dari
// hasil /permtest: 20 percobaan, semuanya 400 yang sama walau tipe "Group" sudah benar.
//
// Cara kerja sekarang:
//   1. Tujuan dicoba berurutan: Group (mis. Team Sotok Gankk) -> Experience/Universe -> User,
//      berhenti di yang pertama berhasil.
//   2. Beberapa varian kecil dicoba kalau perlu (ID asset sebagai angka/string, assetIds[],
//      Content-Type json-patch); yang berhasil DIINGAT (database/roblox_perm_variant.json).
//   3. 200 belum tentu sukses: respons diperiksa (successAssetIds harus memuat asset & errors
//      kosong). Kode error per-asset dari Roblox ikut ditampilkan.
//   4. 401 = key salah (berhenti + petunjuk); 403 = akun tidak punya hak ke tujuan itu -> tujuan
//      berikutnya; 400 = varian salah -> varian lain; 404/409/5xx/429 = asset belum siap /
//      Roblox sibuk -> dicoba ulang dgn jeda (2, 6, 15 dtk), tidak dikeroyok.
//   Diagnosa lengkap: perintah bot /permtest [assetId].
const PERM_URL          = 'https://apis.roblox.com/asset-permissions-api/v1/assets/permissions';
const PERM_VARIANT_FILE = dataFile('roblox_perm_variant.json');
const PERM_MAX_ATTEMPTS = 16;                                   // batas request per 1x siklus (jaga API Roblox; limit 100/menit)
const PERM_RETRY_DELAYS = CFG.PERM_RETRY_DELAYS_MS || [2000, 6000, 15000];

// Varian bentuk body (semuanya subjek di level atas). ids = tipe ID asset: 'num' angka / 'str' string.
const PERM_SHAPES = [
  { id: 'requests-num',           key: 'requests', ids: 'num' },
  { id: 'requests-str',           key: 'requests', ids: 'str' },
  { id: 'assetIds-num',           key: 'assetIds', ids: 'num' },
  { id: 'requests-num-jsonpatch', key: 'requests', ids: 'num', contentType: 'application/json-patch+json' },
];

function loadLearnedPermVariant() {
  try {
    const v = JSON.parse(fs.readFileSync(PERM_VARIANT_FILE, 'utf8'));
    return PERM_SHAPES.some(sh => sh.id === v.shape) ? v : null;   // ingatan dari versi lama (bentuk keliru) diabaikan
  } catch { return null; }
}
function saveLearnedPermVariant(v) {
  try { fs.writeFileSync(PERM_VARIANT_FILE, JSON.stringify({ ...v, savedAt: Date.now() }, null, 2)); } catch {}
}
function clearLearnedPermVariant() { try { fs.unlinkSync(PERM_VARIANT_FILE); } catch {} }

// Tujuan grant, DICOBA BERURUTAN. Group paling utama (izin ke grup berlaku untuk semua pengalaman milik grup).
function permSubjects() {
  const list = [];
  if (robloxGroupId)    list.push({ label: `Group ${robloxGroupId}`,           id: String(robloxGroupId),    types: ['Group'] });
  if (robloxUniverseId) list.push({ label: `Experience ${robloxUniverseId}`,   id: String(robloxUniverseId), types: ['Universe', 'Experience'] });
  if (robloxUserId)     list.push({ label: `User ${robloxUserId}`,             id: String(robloxUserId),     types: ['User'] });
  return list;
}

function buildPermBody(shape, assetId, subjectType, subjectId) {
  const body = { subjectType, subjectId: String(subjectId), action: 'Use' };
  if (shape.key === 'assetIds') body.assetIds = [Number(assetId)];
  else body.requests = [{ assetId: shape.ids === 'num' ? Number(assetId) : String(assetId) }];
  return body;
}

const errText = (err) => String(err?.response?.data?.error?.message || err?.response?.data?.errors?.[0]?.message || err?.response?.data?.message || err?.message || '').slice(0, 200);

async function sendPermRequest(shape, assetId, subjectType, subjectId) {
  return robloxFetch(PERM_URL, {
    method: 'PATCH',
    headers: { 'x-api-key': robloxPermissionApiKey, 'Content-Type': shape.contentType || 'application/json' },
    body: JSON.stringify(buildPermBody(shape, assetId, subjectType, subjectId)),
  }, 30000);
}

// 200 OK belum berarti izin terpasang: cek isi respons.
function evalPermResponse(data, assetId) {
  const okIds = Array.isArray(data?.successAssetIds) ? data.successAssetIds.map(String) : null;
  const errs  = Array.isArray(data?.errors) ? data.errors : [];
  if (errs.length) return { ok: false, message: 'Roblox menolak asset ini: ' + errs.map(e => e.code || JSON.stringify(e)).join(', ') };
  if (okIds && !okIds.includes(String(assetId))) return { ok: false, message: 'asset tidak masuk daftar successAssetIds' };
  return { ok: true, verified: !!okIds };
}

// Satu siklus penuh: tujuan (berurutan) x varian. Balikin { ok, ... } atau { ok:false, kind, attempts, lastError }.
// kind: 'auth' | 'retry' | 'rejected'
async function permCycle(assetId, { learnedOnly = false } = {}) {
  const subjects = permSubjects();
  const attempts = [];
  const learned  = loadLearnedPermVariant();
  let n = 0, kind = 'rejected', lastError = null, abort = false;

  const shapes = () => {
    const sorted = PERM_SHAPES.slice().sort((a, b) => (a.id === learned?.shape ? -1 : b.id === learned?.shape ? 1 : 0));
    return learnedOnly && learned ? sorted.filter(sh => sh.id === learned.shape) : sorted;
  };

  for (const subj of subjects) {
    if (abort) break;
    let skipSubject = false;
    const types = (learned && subj.types.includes(learned.subjectType)) ? [learned.subjectType, ...subj.types.filter(t => t !== learned.subjectType)] : subj.types;
    for (const shape of shapes()) {
      if (abort || skipSubject) break;
      for (const type of types) {
        if (n >= PERM_MAX_ATTEMPTS) { abort = true; break; }
        n++;
        const label = `${subj.label} · ${shape.id} · ${type}`;
        try {
          const data = await sendPermRequest(shape, assetId, type, subj.id);
          const ev = evalPermResponse(data, assetId);
          if (!ev.ok) {
            // Roblox menerima request-nya tapi menolak grant untuk asset ini (mis. bukan pemilik / tujuan tak berhak).
            attempts.push({ label, ok: false, status: 200, message: ev.message });
            lastError = Object.assign(new Error(ev.message), { response: { status: 200, data } });
            skipSubject = true; break;
          }
          attempts.push({ label, ok: true, status: 200, message: ev.verified ? '' : 'respons tanpa konfirmasi successAssetIds' });
          saveLearnedPermVariant({ shape: shape.id, subjectType: type, subject: subj.label });
          const subject = { subjectType: type, subjectId: subj.id };
          return { ok: true, skipped: false, verified: ev.verified, data, subject, subjects: [subject], usedVariant: label, attempts };
        } catch (err) {
          lastError = err;
          const st = err.response?.status || err.robloxStatus || 0;
          attempts.push({ label, ok: false, status: st, message: errText(err) });
          if (st === 401) { kind = 'auth'; abort = true; break; }                          // key salah/kedaluwarsa -> percuma lanjut
          if (st === 403) { skipSubject = true; break; }                                    // akun/key tak berhak ke tujuan ini -> tujuan berikutnya
          if (st === 429 || st >= 500) { kind = 'retry'; abort = true; break; }             // Roblox sibuk -> jangan dikeroyok, tunggu lalu ulang
          if (st === 404 || st === 409) { kind = 'retry'; abort = true; break; }            // asset belum terlihat oleh API izin -> tunggu & ulang
          // 400/422: varian bentuk salah -> coba yang lain (kalau varian yang diingat gagal begini, buang ingatannya)
          if (learned && shape.id === learned.shape && type === learned.subjectType) clearLearnedPermVariant();
        }
      }
    }
  }
  return { ok: false, kind, attempts, lastError };
}

// Petunjuk yang bisa langsung ditindaklanjuti dari hasil percobaan.
function permHint(result) {
  const last = result.attempts[result.attempts.length - 1] || {};
  const st = new Set(result.attempts.map(a => a.status));
  const subjects = permSubjects().map(s => s.label).join(' / ') || '-';
  if (result.kind === 'auth' || st.has(401)) {
    return 'API key ditolak Roblox (401): key salah/kedaluwarsa. Buat ulang di create.roblox.com → Open Cloud → API Keys, beri izin asset-permissions:write (+ asset:read & asset:write), lalu isi di config.js (PERM_TOKEN atau ASSET_TOKEN).';
  }
  if (result.attempts.some(a => a.status === 200 && !a.ok)) {
    return `Roblox menerima request tapi menolak grant (${last.message || 'tanpa kode'}). Biasanya: asset bukan milik akun pemilik API key (${robloxUserId}), atau akun itu tidak berhak membagikan ke tujuan (${subjects}). Pastikan akun ${robloxUserId} anggota grup dengan izin mengelola aset/pengalaman.`;
  }
  if (st.has(403)) {
    return `Roblox menolak (403): akun pemilik API key (${robloxUserId}) tidak berhak memberi izin ke ${subjects}. Pastikan akun itu anggota grup tsb dengan izin mengelola aset, dan API key punya izin asset-permissions:write.`;
  }
  if (result.kind === 'retry') return `Roblox belum siap/sibuk (HTTP ${last.status || '?'}${last.message ? ': ' + last.message : ''}) — coba lagi beberapa saat lagi (/grantid &lt;assetId&gt;).`;
  return `Roblox menolak semua varian request${last.message ? ` (terakhir: HTTP ${last.status || '?'} ${last.message})` : ''}. Cek /permtest untuk rincian tiap percobaan.`;
}

async function autoGrantPermission(assetId, opts = {}) {
  if (!permSubjects().length) {
    return { skipped: true, reason: 'APP_UNIVERSE_ID / APP_GROUP_ID / CREATOR_UID belum diisi di config.js' };
  }

  // Jalur cookie (kalau AUTH_COOKIE diisi) tetap dicoba dulu seperti sebelumnya.
  if (robloxCookie) {
    try {
      return await grantPermissionViaCookie(assetId, permSubjects().map(s => ({ subjectType: s.types[0], subjectId: s.id })));
    } catch (err) {
      console.error('Grant via cookie gagal, fallback ke API key:', err.response?.data || err.message);
    }
  }

  let result = await permCycle(assetId, opts);
  // Asset baru selesai moderasi kadang belum "terlihat" oleh API izin (404/409) atau Roblox lagi
  // sibuk (5xx/429): tunggu sebentar lalu coba lagi -- tapi cuma pakai bentuk yang sudah diingat / paling mungkin.
  for (let i = 0; !result.ok && result.kind === 'retry' && i < PERM_RETRY_DELAYS.length; i++) {
    console.warn(`[Grant] asset ${assetId} belum siap (${result.attempts[result.attempts.length - 1]?.status}) -- coba lagi ${Math.round(PERM_RETRY_DELAYS[i] / 1000)} dtk...`);
    await sleep(PERM_RETRY_DELAYS[i]);
    result = await permCycle(assetId, { ...opts, learnedOnly: !!loadLearnedPermVariant() });
  }
  if (result.ok) return result;

  const err = new Error(permHint(result));
  err.permAttempts = result.attempts;
  err.permHint = err.message;
  err.response = result.lastError?.response;
  err.suspectedAccountIssue = result.kind === 'auth';
  console.error(`[Grant] GAGAL asset ${assetId}: ${err.message}\n` + result.attempts.map(a => `   ${a.ok ? '✔' : '✖'} ${a.label} -> ${a.status}${a.message ? ' ' + a.message : ''}`).join('\n'));
  throw err;
}

// Teks singkat yang aman ditampilkan ke admin dari error grant (pakai petunjuk kalau ada).
function describePermError(err) {
  return err?.permHint || err?.response?.data?.error?.message || err?.response?.data?.errors?.[0]?.message || err?.response?.data?.message || err?.message || 'tidak diketahui';
}

// ownerId yang tertanam di API key Open Cloud (buat cek apakah key-nya milik akun yang benar).
function apiKeyOwnerId(key) {
  try {
    const outer = Buffer.from(String(key), 'base64');
    const m = outer.toString('latin1').match(/[A-Za-z0-9+/=]{80,}/);
    const inner = Buffer.from(m ? m[0] : '', 'base64').toString('latin1');
    const jwt = inner.match(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/) || outer.toString('latin1').match(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/);
    if (!jwt) return null;
    const p = jwt[0].split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(p, 'base64').toString('utf8')).ownerId || null;
  } catch { return null; }
}

// Diagnosa buat /permtest: konfigurasi + hasil SEMUA percobaan (berhenti di yang pertama berhasil).
async function diagnosePermission(assetId) {
  const owner = apiKeyOwnerId(robloxPermissionApiKey);
  const info = [
    `Key milik akun: ${owner || '(tidak terbaca)'}${owner && String(owner) !== String(robloxUserId) ? ` ⚠️ BEDA dengan CREATOR_UID ${robloxUserId}` : ' ✔'}`,
    `Token khusus izin (PERM_TOKEN): ${robloxPermissionApiKeyRaw ? 'terisi' : 'kosong (pakai ASSET_TOKEN)'}`,
    `Tujuan: ${permSubjects().map(s => s.label).join(' → ') || '(kosong)'}`,
    `Bentuk yang diingat: ${loadLearnedPermVariant()?.shape || '(belum ada)'}`,
    `Format: subjectType/subjectId di level atas + requests[{assetId}] + action Use (sesuai dokumentasi resmi)`,
  ];
  const result = await permCycle(assetId, { debug: true });
  return { info, result, hint: result.ok ? null : permHint(result) };
}

// Ambil info audio/gambar dari sebuah message Telegram (audio/document/photo)
function extractMediaFromMessage(message) {
  if (!message) return null;
  const customTitle = (message.caption || '').trim() || null;

  if (message.audio) {
    const fileName = message.audio.file_name || `audio_${Date.now()}.mp3`;
    return { fileId: message.audio.file_id, fileUniqueId: message.audio.file_unique_id, fileName, title: customTitle || fileName, assetType: 'Audio', contentType: 'audio/mpeg' };
  }
  if (message.video) {
    const fileName = message.video.file_name || `video_${Date.now()}.mp4`;
    return { fileId: message.video.file_id, fileUniqueId: message.video.file_unique_id, fileName, title: customTitle || fileName, assetType: 'VideoFrames', contentType: message.video.mime_type || 'video/mp4' };
  }
  if (message.document && message.document.mime_type) {
    const mime = message.document.mime_type;
    if (mime.startsWith('audio/')) {
      const fileName = message.document.file_name || `audio_${Date.now()}.mp3`;
      return { fileId: message.document.file_id, fileUniqueId: message.document.file_unique_id, fileName, title: customTitle || fileName, assetType: 'Audio', contentType: 'audio/mpeg' };
    }
    if (mime.startsWith('video/')) {
      const fileName = message.document.file_name || `video_${Date.now()}.mp4`;
      return { fileId: message.document.file_id, fileUniqueId: message.document.file_unique_id, fileName, title: customTitle || fileName, assetType: 'VideoFrames', contentType: mime };
    }
    if (mime.startsWith('image/')) {
      const fileName = message.document.file_name || `image_${Date.now()}.png`;
      return { fileId: message.document.file_id, fileUniqueId: message.document.file_unique_id, fileName, title: customTitle || fileName, assetType: 'Image', contentType: mime };
    }
  }
  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    const fileName = `image_${Date.now()}.jpg`;
    return { fileId: largest.file_id, fileUniqueId: largest.file_unique_id, fileName, title: customTitle || fileName, assetType: 'Image', contentType: 'image/jpeg' };
  }
  return null;
}

module.exports = {
  loadHistory, saveHistory, upsertHistory,
  loadPendingList, savePendingList, addPending, removePending,
  fileTracker, runQueued, getQueuePosition,
  archiveAssetOnRoblox,
  uploadAssetToRoblox, waitForAssetCreated, fastCheckModeration, getAsset,
  normalizeModerationState, autoGrantPermission, describePermError, diagnosePermission, extractMediaFromMessage,
  moderationPollDelay, moderationExpired, moderationIsSlow, pendingStartedAt,
  sleep,
};
