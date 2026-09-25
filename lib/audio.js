// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Audio — Download YouTube & Mixing FFmpeg             ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝

const API   = require('../apis');
const CFG   = require('../config');
const fs    = require('fs');
const fetch = require('node-fetch');
const { execFile } = require('child_process');
const { sanitizeTitle } = require('./util');
const ytCache = require('./ytCache');
const { ProviderHealth, raceProviders, classifyError } = require('./ytOrchestrator');

// User-Agent mobile -- beberapa provider (mis. Kyzznekoo) nolak/beda perilaku
// kalau request datang tanpa User-Agent yang keliatan kayak browser beneran.
const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

// ── Downloader providers — urut dari yang paling diutamakan ─────────────────
// Kalau provider pertama gagal (timeout/error/link mati), otomatis lanjut
// ke provider berikutnya. Tambahin provider baru cukup push objek baru
// ke array ini — tanpa perlu ubah logika di bawah.
//
// Setiap provider wajib punya:
//   name    : string  — nama untuk log
//   fn      : async (ytUrl) => { downloadUrl, title, duration, thumbnail }
//
// Kalau semua provider gagal, fungsi ytDownload() throw error dengan
// ringkasan kegagalan tiap provider.
// ─────────────────────────────────────────────────────────────────────────────

// Gabungin beberapa AbortSignal jadi satu -- signal hasil gabungan ini bakal
// "aborted" begitu SALAH SATU dari signal aslinya aborted (misal: timeout-nya
// keburu abis, ATAU sinyal "provider lain udah menang" dikirim dari luar).
// Pakai AbortSignal.any() bawaan Node kalau ada (Node 20.3+), fallback manual
// kalau ternyata jalan di Node yang lebih lama.
function anySignal(signals) {
  const valid = signals.filter(Boolean);
  if (valid.length === 1) return valid[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(valid);
  const controller = new AbortController();
  for (const s of valid) {
    if (s.aborted) { controller.abort(s.reason); break; }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

// Batas ukuran file hasil download (dibaca dari header Content-Length). Lagu maksimal
// 7 menit cuma ~10-17 MB; file jauh lebih besar dari ini hampir pasti video/mix
// berjam-jam yang bakal ditolak juga -- gak usah dibaca penuh ke RAM.
const MAX_DOWNLOAD_BYTES = 60 * 1024 * 1024;

async function fetchDownloadUrl(url, timeout, signal) {
  const r = await fetch(url, { signal: anySignal([AbortSignal.timeout(timeout), signal]) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const declared = parseInt(r.headers.get('content-length') || '0', 10);
  if (declared > MAX_DOWNLOAD_BYTES) {
    throw new Error(`File terlalu besar (${(declared / 1048576).toFixed(0)} MB) -- durasi video kemungkinan jauh di atas batas 7 menit`);
  }
  const buf = await r.buffer();
  if (!buf.length) throw new Error('Response kosong');
  return buf;
}

// ── Pengambil link download yang TOLERAN terhadap bentuk response ─────────────
// Beda-beda tiap provider (ada yang { result: { download } }, ada { data: { url } },
// ada yang nested lagi). Cari string URL http(s) di response -- prioritas ke key yang
// namanya mengandung url/download/link/mp3/audio/dl, dan lewati key gambar/thumbnail.
const LINK_KEY_RE  = /(^|_)(url|download|downloadurl|download_url|link|dl|dlink|mp3|audio|file)(_|$)|download|mp3/i;
const SKIP_KEY_RE  = /thumb|image|img|cover|poster|avatar|channel|author|source|original|watch|page/i;
function pickDownloadLink(node, depth = 0) {
  if (node == null || depth > 4) return null;
  if (typeof node === 'string') return /^https?:\/\//i.test(node.trim()) ? node.trim() : null;
  if (Array.isArray(node)) { for (const it of node) { const f = pickDownloadLink(it, depth + 1); if (f) return f; } return null; }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {          // 1) key yang jelas-jelas link download
      if (SKIP_KEY_RE.test(k) || !LINK_KEY_RE.test(k)) continue;
      const f = pickDownloadLink(v, depth + 1); if (f) return f;
    }
    for (const [k, v] of Object.entries(node)) {          // 2) turun ke objek/array bersarang
      if (SKIP_KEY_RE.test(k) || typeof v !== 'object') continue;
      const f = pickDownloadLink(v, depth + 1); if (f) return f;
    }
  }
  return null;
}
const pickField = (d, ...keys) => {
  for (const box of [d, d && d.data, d && d.result, d && d.results]) {
    if (!box || typeof box !== 'object') continue;
    for (const k of keys) if (box[k] != null && box[k] !== '') return box[k];
  }
  return null;
};

// Provider generik: GET <endpoint>?...&url=<yt_url>. Response-nya bisa berupa:
//   1) JSON  -> cari link download di dalamnya (pickDownloadLink)
//   2) teks polos berisi URL
//   3) LANGSUNG file audio (mis. endpoint dengan json=0, atau redirect ke file) ->
//      isi file dikembalikan sebagai `buffer`, gak perlu request kedua
// Timeout: 25 dtk buat nunggu response mulai datang; kalau ternyata file audio,
// body-nya dikasih tambahan waktu 90 dtk buat selesai diunduh.
async function fetchLinkGeneric(label, endpoint, ytUrl, signal, extraParams = '') {
  const sep = endpoint.includes('?') ? '&' : '?';
  const url = `${endpoint}${sep}url=${encodeURIComponent(ytUrl)}${extraParams}`;

  const ctl = new AbortController();
  const link = anySignal([ctl.signal, signal]);
  let timer = setTimeout(() => ctl.abort(new Error('timeout')), 25000);
  try {
    const r = await fetch(url, { signal: link, headers: { 'User-Agent': UA_MOBILE } });
    if (!r.ok) throw new Error('HTTP ' + r.status);

    const ctype = String(r.headers.get('content-type') || '').toLowerCase();
    const isBinary = /^(audio|video)\//.test(ctype) || ctype.includes('octet-stream');
    if (isBinary) {
      const declared = parseInt(r.headers.get('content-length') || '0', 10);
      if (declared > MAX_DOWNLOAD_BYTES) throw new Error(`File terlalu besar (${(declared / 1048576).toFixed(0)} MB) -- durasi video kemungkinan jauh di atas batas 7 menit`);
      clearTimeout(timer); timer = setTimeout(() => ctl.abort(new Error('timeout')), 90000);
      const buffer = await r.buffer();
      return { buffer, downloadUrl: null, title: null, duration: null, thumbnail: null };
    }

    const text = (await r.text()).trim();
    let d = null;
    if (/^https?:\/\//i.test(text)) return { downloadUrl: text, title: null, duration: null, thumbnail: null };
    try { d = JSON.parse(text); } catch { throw new Error(`${label}: response bukan JSON/URL/audio (${text.slice(0, 60).replace(/\s+/g, ' ')})`); }

    const found = pickDownloadLink(d);
    if (!found) console.warn(`[${label}] Respons tak dikenali:`, JSON.stringify(d).slice(0, 300));
    if (!found) throw new Error(pickField(d, 'message', 'error', 'msg') || `${label}: link download tidak ditemukan di response`);
    return {
      downloadUrl : found,
      title       : pickField(d, 'title', 'judul', 'name'),
      duration    : pickField(d, 'duration', 'durasi', 'lengthSeconds'),
      thumbnail   : pickField(d, 'thumbnail', 'thumb', 'image', 'cover')
    };
  } finally { clearTimeout(timer); }
}

// ── Sylvatica: pool multi-apikey ─────────────────────────────────────────────
// SEMUA request WAJIB coba Sylvatica dulu (lihat YT_PRIMARY_PROVIDERS di config.js
// -- default cuma ['Sylvatica']). Sebelumnya cuma ada 1 apikey, jadi kalau lagi
// banyak yang request BARENGAN, semuanya numpuk ke 1 apikey yang sama -> lambat,
// dan beresiko keliatan kayak SPAM buat Sylvatica (banyak hit dari 1 apikey dalam
// waktu singkat). Sekarang: SYLVATICA_API_KEYS (apis.js) boleh diisi lebih dari 1
// apikey -- tiap ada request baru, dipilihin apikey yang PALING LONGGAR (paling
// sedikit lagi dipakai bersamaan), bukan asal round-robin/selalu apikey pertama.
// Tiap apikey juga punya BATAS concurrency sendiri (SYLVATICA_MAX_CONCURRENT_PER_KEY)
// -- begitu satu apikey udah dipakai sejumlah itu bersamaan, request berikutnya
// otomatis gantian ke apikey lain, BUKAN numpuk/spam ke apikey yang sama. Kalau
// SEMUA apikey lagi penuh/cooldown, fn() ini gagal SEBENTAR (dengan pesan jelas)
// dan mekanisme retry+fallback yang udah ada (YT_PRIMARY_ATTEMPTS, lalu provider
// lain) yang ambil alih -- bukan bikin request numpuk nunggu tanpa batas.
const SYLVATICA_KEYS = (API.SYLVATICA_API_KEYS || []).filter(Boolean);
const SYLVATICA_MAX_CONCURRENT_PER_KEY = CFG.SYLVATICA_MAX_CONCURRENT_PER_KEY || 3;
const SYLVATICA_KEY_COOLDOWN_MS        = CFG.SYLVATICA_KEY_COOLDOWN_MS || 20000;
const sylvaticaKeyState = SYLVATICA_KEYS.map((key) => ({ key, inFlight: 0, cooldownUntil: 0 }));

// Apikey paling longgar yang boleh dipakai SEKARANG (gak lagi cooldown & belum
// nyampe batas concurrency-nya) -- makin sedikit inFlight-nya, makin diprioritasin.
function pickSylvaticaKey() {
  const now = Date.now();
  let best = null;
  for (const st of sylvaticaKeyState) {
    if (st.cooldownUntil > now) continue;
    if (st.inFlight >= SYLVATICA_MAX_CONCURRENT_PER_KEY) continue;
    if (!best || st.inFlight < best.inFlight) best = st;
  }
  return best;
}

async function sylvaticaFn(ytUrl, signal) {
  if (!SYLVATICA_KEYS.length) throw new Error('Sylvatica: SYLVATICA_API_KEYS kosong di apis.js');
  const st = pickSylvaticaKey();
  if (!st) throw new Error(`Sylvatica: semua ${SYLVATICA_KEYS.length} apikey lagi penuh/istirahat sebentar`);
  st.inFlight++;
  try {
    const res = await fetchLinkGeneric('Sylvatica', API.SYLVATICA_YTMP3_BASE, ytUrl, signal, `&apikey=${encodeURIComponent(st.key)}`);
    st.cooldownUntil = 0; // apikey ini kebukti masih sehat
    return res;
  } catch (err) {
    // Cuma apikey INI yang diistirahatin (bukan seluruh Sylvatica) -- apikey lain
    // di pool tetap boleh kepakai buat request berikutnya selagi ini pulih.
    if (classifyError(err) === 'ratelimit' || classifyError(err) === 'auth') {
      st.cooldownUntil = Date.now() + SYLVATICA_KEY_COOLDOWN_MS;
    }
    throw err;
  } finally {
    st.inFlight--;
  }
}

const PROVIDERS = [

  // ── Sylvatica (akun UPGRADE, apikey baru 2026-09-20; pool multi-apikey 2026-09-25)
  // -- urutan awal PERTAMA. GET https://sylvatica.my.id/api/download/ytmp3?apikey=<key>&url=<yt_url>
  {
    name: 'Sylvatica',
    async fn(ytUrl, signal) { return sylvaticaFn(ytUrl, signal); }
  },

  // ── Wanz Api (self-hosted -- proyek terpisah "wanz-api", yt-dlp+ffmpeg) ──────────
  // Beda dari provider lain: ini server MILIK SENDIRI (bukan numpang API orang),
  // jadi gak ada resiko "dibatesin/dibanned orang lain" -- cuma dibatesin kekuatan
  // server sendiri. Auto-nonaktif kalau CFG.WANZ_API_URL masih kosong (belum di-
  // deploy), jadi aman nempel di sini dari sekarang. Endpoint aslinya:
  // GET <WANZ_API_URL>/api/download/youtube?apikey=<key>&url=<yt_url> -> file MP3
  // langsung (bukan JSON) -- fetchLinkGeneric udah bisa nangkep ini otomatis
  // (deteksi content-type audio/* -> ambil buffer-nya langsung, lihat komentar
  // di atas fetchLinkGeneric).
  {
    name: 'WanzApi',
    async fn(ytUrl, signal) {
      if (!CFG.WANZ_API_URL) throw new Error('WanzApi: WANZ_API_URL belum diisi di config.js (belum di-deploy)');
      return fetchLinkGeneric('WanzApi', `${CFG.WANZ_API_URL.replace(/\/$/, '')}/api/download/youtube`, ytUrl, signal, `&apikey=${encodeURIComponent(CFG.WANZ_API_KEY)}`);
    }
  },

  // ── AlwaysCodex v1-v4 (2026-09-20) -- kelompok UTAMA ──────────────────────────────────────────
  // Endpoint yang BENAR: /api/downloader/youtubev1 .. youtubev4 (pakai huruf "v").
  // Kode lama memanggil /youtube2 & /youtube3 -- path itu gak ada, makanya
  // AlwaysCodex selalu "error" padahal servernya normal.
  //   v1: ?url=<yt>&quality=mp3     v2: ?url=<yt>     v3: ?url=<yt>&json=0     v4: ?url=<yt>
  {
    name: 'AlwaysCodex-v4',
    async fn(ytUrl, signal) { return fetchLinkGeneric('AlwaysCodex-v4', API.ALWAYSCODEX_YOUTUBE_V4, ytUrl, signal); }
  },
  {
    name: 'AlwaysCodex-v2',
    async fn(ytUrl, signal) { return fetchLinkGeneric('AlwaysCodex-v2', API.ALWAYSCODEX_YOUTUBE_V2, ytUrl, signal); }
  },
  {
    name: 'AlwaysCodex-v1',
    async fn(ytUrl, signal) { return fetchLinkGeneric('AlwaysCodex-v1', API.ALWAYSCODEX_YOUTUBE_V1, ytUrl, signal, '&quality=mp3'); }
  },
  {
    name: 'AlwaysCodex-v3',
    async fn(ytUrl, signal) { return fetchLinkGeneric('AlwaysCodex-v3', API.ALWAYSCODEX_YOUTUBE_V3, ytUrl, signal, '&json=0'); }
  },

  // ── Xyurei v1 & v2 (2026-09-20) ─────────────────────────────────────────────
  // GET https://www.api-xyurei.my.id/api/download/ytmp3[v2]?apikey=<key>&url=<yt_url>
  // Urutan awal di sini cuma titik-mulai -- urutan sebenarnya diatur otomatis
  // berdasar rekam jejak (lib/ytOrchestrator.js): provider yang sering gagal/lambat
  // turun ke belakang, yang cepat & stabil naik ke depan.
  {
    name: 'Xyurei-v1',
    async fn(ytUrl, signal) {
      return fetchLinkGeneric('Xyurei-v1', `${API.XYUREI_YTMP3}?apikey=${API.XYUREI_APIKEY}`, ytUrl, signal);
    }
  },
  {
    name: 'Xyurei-v2',
    async fn(ytUrl, signal) {
      return fetchLinkGeneric('Xyurei-v2', `${API.XYUREI_YTMP3_V2}?apikey=${API.XYUREI_APIKEY}`, ytUrl, signal);
    }
  },


  // ── FAA (2026-09-20) ────────────────────────────────────────────────────────
  // GET https://api-faa.my.id/faa/ytmp3?url=<yt_url>   (tanpa apikey)
  {
    name: 'FAA',
    async fn(ytUrl, signal) { return fetchLinkGeneric('FAA', API.FAA_YTMP3, ytUrl, signal); }
  },

  // ── 2. TermAI ────────────────────────────────────────────────────────────────
  // GET https://api.termai.cc/api/downloader/youtube?type=mp3&url=<yt_url>&key=<apikey>
  {
    name: 'TermAI',
    async fn(ytUrl, signal) {
      const url = `${API.TERMAI_BASE}/api/downloader/youtube?type=mp3&url=${encodeURIComponent(ytUrl)}&key=${API.TERMAI_APIKEY}`;
      const r   = await fetch(url, { signal: anySignal([AbortSignal.timeout(25000), signal]) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();

      const link = (
        d.url               || d.download            || d.audio             ||
        d.mp3               || d.link                 || d.downloadUrl       ||
        d.data?.url         || d.data?.download       || d.data?.audio       || d.data?.mp3    || d.data?.downloadUrl ||
        d.data?.file        ||
        d.result?.url       || d.result?.download     || d.result?.audio     || d.result?.mp3  || d.result?.downloadUrl
      );

      const ok = d.status === true || d.success === true || d.ok === true || !!link;
      if (!ok)   throw new Error(d.message || d.error || 'TermAI: request gagal');
      if (!link) throw new Error('Link download tidak ditemukan di response TermAI');

      return {
        downloadUrl : link,
        title       : d.title     || d.data?.title     || d.result?.title     || null,
        duration    : d.duration  || d.data?.duration  || d.result?.duration  || null,
        thumbnail   : d.thumbnail || d.data?.thumbnail || d.result?.thumbnail || null
      };
    }
  },

  // ── 3. Clutch ────────────────────────────────────────────────────────────────
  // GET https://api.clutch.web.id/download/ytmp3?apikey=...&url=<yt_url>
  {
    name: 'Clutch',
    async fn(ytUrl, signal) {
      const url = `${API.CLUTCH_YT_MP3}&url=${encodeURIComponent(ytUrl)}`;
      const r   = await fetch(url, { signal: anySignal([AbortSignal.timeout(25000), signal]) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();

      const link = (
        d.url           || d.download        || d.audio         ||
        d.mp3           || d.link            || d.downloadUrl   ||
        d.data?.url     || d.data?.download  || d.data?.audio   || d.data?.mp3  ||
        d.result?.url   || d.result?.download || d.result?.audio || d.result?.mp3
      );

      const ok = d.status === true || d.success === true || d.ok === true || !!link;
      if (!ok)   throw new Error(d.message || d.error || 'Clutch: request gagal');
      if (!link) throw new Error('Link download tidak ditemukan di response Clutch');

      return {
        downloadUrl : link,
        title       : d.title     || d.data?.title     || d.result?.title     || null,
        duration    : d.duration  || d.data?.duration  || d.result?.duration  || null,
        thumbnail   : d.thumbnail || d.data?.thumbnail || d.result?.thumbnail || null
      };
    }
  },

  // ── 4. Neosoft (tetap aktif, masih jalan bagus) ─────────────────────────────
  {
    name: 'Neosoft',
    async fn(ytUrl, signal) {
      const url = `${API.NEOSOFT_YT_DOWNLOADER}?url=${encodeURIComponent(ytUrl)}&type=mp3`;
      const r   = await fetch(url, { signal: anySignal([AbortSignal.timeout(20000), signal]) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      const link = d.download || d.data?.url || d.url || d.link;
      if (!d.status && !link) throw new Error(d.message || 'Tidak ada link download');
      if (!link) throw new Error('Link download tidak ditemukan di response');
      return {
        downloadUrl : link,
        title       : d.title       || d.data?.title    || null,
        duration    : d.duration    || d.data?.duration || null,
        thumbnail   : d.thumbnail   || d.data?.thumbnail || null
      };
    }
  },

  // ── 5. Kyzznekoo ─────────────────────────────────────────────────────────────
  // GET https://api.kyzznekoo.my.id/api/downloader/ytmp3?url=<yt_url>
  // CATATAN: domain & endpoint lama (kyzznekoo.zone.id/api/downloader/all) udah
  // gak valid lagi -- ini yang bikin provider ini selalu gagal sebelumnya.
  {
    name: 'Kyzznekoo',
    async fn(ytUrl, signal) {
      const url = `${API.KYZZNEKOO_DOWNLOADER}?url=${encodeURIComponent(ytUrl)}`;
      const r   = await fetch(url, {
        headers: { 'User-Agent': UA_MOBILE },
        signal: anySignal([AbortSignal.timeout(25000), signal])
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();

      const link = (
        d.url           || d.download        || d.audio         ||
        d.mp3           || d.link            || d.downloadUrl   || d.download_url ||
        d.data?.url     || d.data?.download  || d.data?.audio   || d.data?.mp3    || d.data?.downloadUrl || d.data?.download_url ||
        d.result?.url   || d.result?.download || d.result?.audio || d.result?.mp3 || d.result?.downloadUrl ||
        d.medias?.[0]?.url || d.medias?.[0]?.download
      );

      const ok = d.status === true || d.success === true || d.ok === true || !!link;
      if (!ok)   throw new Error(d.message || d.error || 'Kyzznekoo: request gagal');
      if (!link) { console.warn('[Kyzznekoo] Respons tak dikenali:', JSON.stringify(d).slice(0, 300)); throw new Error('Link download tidak ditemukan di response Kyzznekoo'); }

      return {
        downloadUrl : link,
        title       : d.title     || d.data?.title     || d.result?.title     || null,
        duration    : d.duration  || d.data?.duration  || d.result?.duration  || null,
        thumbnail   : d.thumbnail || d.data?.thumbnail || d.result?.thumbnail || null
      };
    }
  },

  // ── 7. XyloAPI ───────────────────────────────────────────────────────────────
  // GET https://xyloapi.qzz.io/api/downloader/youtube?url=<yt_url>&server=server1
  // URL ini SEBENARNYA udah bener dari awal -- parsing respons diperlebar +
  // ditambah log biar ketauan kalau ternyata field JSON-nya berubah format.
  {
    name: 'XyloAPI',
    async fn(ytUrl, signal) {
      const url = `${API.XYLOAPI_YOUTUBE}?url=${encodeURIComponent(ytUrl)}&server=server1`;
      const r   = await fetch(url, { signal: anySignal([AbortSignal.timeout(25000), signal]) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();

      const link = (
        d.url               || d.download            || d.audio             ||
        d.mp3               || d.link                 || d.downloadUrl       || d.download_url ||
        d.data?.url         || d.data?.download       || d.data?.audio       || d.data?.mp3    || d.data?.downloadUrl || d.data?.download_url ||
        d.result?.url       || d.result?.download     || d.result?.audio     || d.result?.mp3  || d.result?.downloadUrl || d.result?.download_url ||
        d.result?.data?.url || d.result?.data?.download ||
        d.data?.result?.url || d.data?.result?.download
      );

      const ok = d.status === true || d.success === true || d.ok === true || !!link;
      if (!ok)   throw new Error(d.message || d.error || 'XyloAPI: request gagal');
      if (!link) { console.warn('[XyloAPI] Respons tak dikenali:', JSON.stringify(d).slice(0, 300)); throw new Error('Link download tidak ditemukan di response XyloAPI'); }

      return {
        downloadUrl : link,
        title       : d.title     || d.data?.title     || d.result?.title     || null,
        duration    : d.duration  || d.data?.duration  || d.result?.duration  || null,
        thumbnail   : d.thumbnail || d.data?.thumbnail || d.result?.thumbnail || null
      };
    }
  },

  // ── 8. Jerexd ────────────────────────────────────────────────────────────────
  // GET https://api.jerexd.my.id/api/downloader/youtube?apikey=...&url=<yt_url>&format=Mp3
  // CATATAN: endpoint lama (/ytmp3v2 dan /ytmp3) udah gak valid -- Jerexd cuma
  // punya SATU endpoint yang bener yaitu /youtube dengan parameter format=Mp3.
  // 2 provider "Jerexd-v2" & "Jerexd" yang lama digabung jadi satu di sini.
  {
    name: 'Jerexd',
    async fn(ytUrl, signal) {
      const url = `${API.JEREXD_YOUTUBE}&url=${encodeURIComponent(ytUrl)}&format=Mp3`;
      const r   = await fetch(url, { signal: anySignal([AbortSignal.timeout(25000), signal]) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();

      const link = (
        d.url           || d.download        || d.audio         ||
        d.mp3           || d.link            || d.downloadUrl   || d.download_url ||
        d.data?.url     || d.data?.download  || d.data?.audio   || d.data?.mp3    || d.data?.downloadUrl || d.data?.download_url ||
        d.result?.url   || d.result?.download || d.result?.audio || d.result?.mp3 || d.result?.downloadUrl
      );

      const ok = d.status === true || d.success === true || d.ok === true || !!link;
      if (!ok)   throw new Error(d.message || d.error || 'Jerexd: request gagal');
      if (!link) { console.warn('[Jerexd] Respons tak dikenali:', JSON.stringify(d).slice(0, 300)); throw new Error('Link download tidak ditemukan di response Jerexd'); }

      return {
        downloadUrl : link,
        title       : d.title     || d.data?.title     || d.result?.title     || null,
        duration    : d.duration  || d.data?.duration  || d.result?.duration  || null,
        thumbnail   : d.thumbnail || d.data?.thumbnail || d.result?.thumbnail || null
      };
    }
  },

  // ── 10. MediaDownloader ──────────────────────────────────────────────────────
  // POST https://mediadownloader.web.id/api/download  body: { url: <yt_url> }
  // Beda dari provider lain (yang semuanya GET) -- ini POST dengan body JSON.
  {
    name: 'MediaDownloader',
    async fn(ytUrl, signal) {
      const r = await fetch(API.MEDIADOWNLOADER_BASE, {
        method  : 'POST',
        headers : { 'Content-Type': 'application/json' },
        body    : JSON.stringify({ url: ytUrl }),
        redirect: 'follow',
        signal  : anySignal([AbortSignal.timeout(25000), signal]),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();

      const link = (
        d.url               || d.download            || d.audio             ||
        d.mp3               || d.link                 || d.downloadUrl       || d.download_url ||
        d.data?.url         || d.data?.download       || d.data?.audio       || d.data?.mp3    || d.data?.downloadUrl || d.data?.download_url ||
        d.result?.url       || d.result?.download     || d.result?.audio     || d.result?.mp3  || d.result?.downloadUrl ||
        d.data?.medias?.[0]?.url || d.medias?.[0]?.url
      );

      const ok = d.status === true || d.success === true || d.ok === true || !!link;
      if (!ok)   throw new Error(d.message || d.error || 'MediaDownloader: request gagal');
      if (!link) { console.warn('[MediaDownloader] Respons tak dikenali:', JSON.stringify(d).slice(0, 300)); throw new Error('Link download tidak ditemukan di response MediaDownloader'); }

      return {
        downloadUrl : link,
        title       : d.title     || d.data?.title     || d.result?.title     || null,
        duration    : d.duration  || d.data?.duration  || d.result?.duration  || null,
        thumbnail   : d.thumbnail || d.data?.thumbnail || d.result?.thumbnail || null
      };
    }
  },

  // ── Tambah provider baru di sini ───────────────────────────────────────────
  // ,{
  //   name: 'NamaProvider',
  //   async fn(ytUrl) {
  //     const r = await fetch(`https://...?url=${encodeURIComponent(ytUrl)}`, { signal: anySignal([AbortSignal.timeout(20000), signal]) });
  //     const d = await r.json();
  //     return { downloadUrl: d.url, title: d.title, duration: d.duration, thumbnail: d.thumbnail };
  //   }
  // }

];

// ── ytDownload: provider dicoba BERTAHAP, bukan semuanya sekaligus ───────────
// Dulu: 10 provider ditembak BERSAMAAN tiap request (10 hit API + 10 download +
// 10 ffmpeg paralel) -> provider kena rate-limit/blokir, CPU & RAM server keteter,
// dan hasilnya malah SERING GAGAL semua. Sekarang (lib/ytOrchestrator.js):
//   1. Provider diurutkan dari yang paling sehat & cepat (rekam jejak terbaru).
//   2. Yang terbaik jalan duluan; provider berikutnya baru IKUT kalau yang
//      pertama gagal atau lebih dari YT_HEDGE_DELAY_MS tanpa hasil (maks
//      YT_MAX_INFLIGHT provider berjalan bersamaan) -- umumnya cuma 1-2 hit.
//   3. Provider yang lagi error/kena limit diistirahatin (cooldown) & dilewati.
//   4. Kalau satu putaran gagal karena masalah sementara (timeout/5xx), coba lagi
//      sekali sebelum menyerah (YT_MAX_ROUNDS).
//   5. Hasil sukses disimpen (lib/ytCache.js) -- video yang sama dalam beberapa
//      jam ke depan langsung dipakai tanpa nembak API lagi, dan request yang
//      sama-sama masuk barengan digabung jadi 1 download.
const YT_HEDGE_MS      = CFG.YT_HEDGE_DELAY_MS || 5000;
const YT_MAX_INFLIGHT  = CFG.YT_MAX_INFLIGHT   || 2;
const YT_MAX_ROUNDS    = CFG.YT_MAX_ROUNDS     || 2;
const YT_MAX_ATTEMPTS  = CFG.YT_MAX_ATTEMPTS   || 6;      // maks provider yang dicoba per putaran
const YT_DEADLINE_MS   = CFG.YT_DEADLINE_MS    || 75000;  // batas waktu total per putaran
const YT_CACHE_TTL_MS  = CFG.YT_CACHE_TTL_MS   || 6 * 60 * 60 * 1000;
const YT_RETRY_BACKOFF_MS = CFG.YT_RETRY_BACKOFF_MS || 2500;      // jeda antar putaran (dikali nomor putaran)
const YT_TOTAL_BUDGET_MS  = CFG.YT_TOTAL_BUDGET_MS  || 90000;     // putaran ulang gak dimulai lagi kalau total waktu udah segini
const providerHealth   = new ProviderHealth();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Provider UTAMA & CADANGAN (config.js) ────────────────────────────────────────
//   YT_PRIMARY_PROVIDERS  : provider yang SELALU dicoba duluan (default ['Sylvatica']).
//   YT_FALLBACK_PROVIDERS : provider CADANGAN -- dipanggil HANYA KALAU yang utama gagal
//                           (atau lagi diistirahatkan karena limit/error berulang).
//                           null = semua provider lain; [] = tanpa cadangan;
//                           atau daftar nama tertentu. Cadangan dicoba bertahap
//                           (bukan sekaligus), yang paling sehat & cepat dulu.
//   Kalau YT_PRIMARY_PROVIDERS kosong, SEMUA provider dipakai bertahap (mode lama).
// Nama gak dikenal diabaikan (dikasih warning); huruf besar/kecil bebas.
function resolveNames(list, label) {
  const want = Array.isArray(list) ? list.map(String).filter(Boolean) : [];
  const chosen = PROVIDERS.filter(p => want.some(n => n.toLowerCase() === p.name.toLowerCase()));
  const unknown = want.filter(n => !PROVIDERS.some(p => p.name.toLowerCase() === n.toLowerCase()));
  if (unknown.length) console.warn(`[Audio] ${label} berisi nama yang tidak dikenal: ${unknown.join(', ')} (tersedia: ${PROVIDERS.map(p => p.name).join(', ')})`);
  return chosen;
}
function resolveTiers() {
  const primary = resolveNames(CFG.YT_PRIMARY_PROVIDERS, 'YT_PRIMARY_PROVIDERS');
  let fallback = Array.isArray(CFG.YT_FALLBACK_PROVIDERS)
    ? resolveNames(CFG.YT_FALLBACK_PROVIDERS, 'YT_FALLBACK_PROVIDERS')
    : PROVIDERS.filter(p => !primary.includes(p));           // null/kosong = semua sisanya
  fallback = fallback.filter(p => !primary.includes(p));
  if (!primary.length && !fallback.length) fallback = PROVIDERS.slice(); // jaga-jaga: config salah semua -> pakai semua
  return { primary, fallback };
}
const TIERS            = resolveTiers();
const PRIMARY          = TIERS.primary;
const FALLBACK         = TIERS.fallback;
const YT_PRIMARY_TRIES = CFG.YT_PRIMARY_ATTEMPTS || 2;   // berapa kali provider utama dicoba sebelum pindah ke cadangan
console.log(`[Audio] Provider utama: ${PRIMARY.map(p => p.name).join(', ') || '(tidak ada)'} | cadangan (dipanggil saat dibutuhkan): ${FALLBACK.length} provider`);

// Cek cepat lewat oEmbed: 404 = video sudah dihapus/privat/gak ada. Cuma dipakai
// buat BERHENTI nyoba provider lain kalau provider pertama juga gagal (jadi link
// mati gak bikin 10 API dikeroyok) -- TIDAK dipakai buat nolak di depan, jadi
// video valid yang kebetulan salah dideteksi tetap bisa lolos lewat provider.
async function isYtGone(ytUrl) {
  try {
    const r = await fetch(`${API.YOUTUBE_OEMBED}?url=${encodeURIComponent(ytUrl)}&format=json`, { signal: AbortSignal.timeout(6000) });
    return r.status === 404 || r.status === 400;
  } catch { return false; }
}

// Satu percobaan penuh untuk 1 provider: ambil link -> download -> validasi -> (convert bila perlu)
async function attemptProvider(provider, providerIndex, ytUrl, outputPath, signal) {
  const tempPath = `${outputPath}.try${providerIndex}`;
  const { downloadUrl, buffer, title, duration, thumbnail } = await provider.fn(ytUrl, signal);

  // Provider bisa ngasih link (download di sini) ATAU langsung isi file (buffer).
  const buf = buffer || await fetchDownloadUrl(downloadUrl, 90000, signal);
  if (buf.length < 2000) throw new Error('File hasil download terlalu kecil/kosong, kemungkinan link dari provider rusak.');
  fs.writeFileSync(tempPath, buf);

  // PENTING: cek beneran ini audio valid apa nggak SEBELUM dianggap berhasil.
  // Beberapa provider kadang ngasih link yang isinya bukan audio asli
  // (html error, JSON error, file kepotong, dll).
  let probe;
  try {
    probe = await probeAudio(tempPath);
  } catch (durErr) {
    throw new Error(`File dari provider ini bukan audio valid (${durErr.message})`);
  }

  // Lolos cek "ini audio" BUKAN jaminan formatnya MP3 asli -- banyak provider ngasih
  // AAC/M4A/OPUS yang dikasih nama .mp3 doang (Roblox nolak "Invalid file type").
  // Yang BUKAN mp3 standar di-convert paksa; yang SUDAH mp3 standar dibiarin
  // (gak perlu encode ulang -- hemat detik CPU, dan gak ada penurunan kualitas).
  if (!isStandardMp3(probe)) {
    try {
      await forceReencodeToMp3(tempPath, signal);
    } catch (reencodeErr) {
      throw new Error(`Gagal convert ke MP3 standar (${reencodeErr.message})`);
    }
  }

  return { tempPath, title: sanitizeTitle(title), duration, thumbnail, provider: provider.name, probedDuration: probe.duration };
}

async function ytDownloadRaw(ytUrl, outputPath) {
  const allFailures = [];
  const goneP = isYtGone(ytUrl);
  // Dipanggil tiap provider gagal: kalau link-nya terbukti sudah mati, jangan lanjut ke provider lain.
  const shouldStop = () => Promise.race([goneP, sleep(2000).then(() => false)]);
  const log = (m) => console.log(`[Audio] ${m}`);
  const startedAt = Date.now();
  const isGone = () => Promise.race([goneP, Promise.resolve(false)]);

  const cleanupTemps = () => {
    for (let i = 0; i < PROVIDERS.length; i++) {
      const t = `${outputPath}.try${i}`;
      fs.unlink(t, () => {}); fs.unlink(t + '.reencoded.mp3', () => {});
    }
  };

  // Satu putaran balapan bertahap; kalau ada pemenang, langsung beresin & kembalikan hasilnya.
  const runRound = async (candidates) => {
    const res = await raceProviders({
      providers: candidates,
      health: providerHealth,
      hedgeMs: YT_HEDGE_MS,
      maxInFlight: YT_MAX_INFLIGHT,
      maxAttempts: YT_MAX_ATTEMPTS,
      deadlineMs: YT_DEADLINE_MS,
      shouldStop,
      log,
      attempt: (provider, signal) => attemptProvider(provider, PROVIDERS.indexOf(provider), ytUrl, outputPath, signal),
    });
    allFailures.push(...res.failures);
    if (res.timedOut) allFailures.push({ provider: '(semua)', kind: 'infra', message: `batas waktu total habis (${Math.round(YT_DEADLINE_MS / 1000)} dtk) sebelum ada provider yang berhasil` });
    if (!res.winner) return { res };
    const w = res.winner;
    fs.renameSync(w.tempPath, outputPath);
    cleanupTemps();
    setTimeout(cleanupTemps, 15000).unref?.(); // sapu sisa temp dari percobaan yang baru dibatalkan
    console.log(`[Audio] Berhasil via ${w.provider} dalam ${(res.winnerMs / 1000).toFixed(1)} dtk (provider dicoba: ${res.tried.join(', ')})`);
    return { res, info: { title: w.title, duration: w.duration, thumbnail: w.thumbnail, provider: w.provider, probedDuration: w.probedDuration } };
  };

  // Tingkat 1 = UTAMA (dicoba ulang sebentar kalau gagalnya sementara), tingkat 2 = CADANGAN
  // (BARU disentuh kalau yang utama gagal/lagi istirahat). Tanpa provider utama -> semua = 1 tingkat.
  const tiers = [];
  if (PRIMARY.length)  tiers.push({ label: 'utama',    providers: PRIMARY,  rounds: YT_PRIMARY_TRIES, retryKinds: ['infra', 'content'], deferIfCooling: FALLBACK.length > 0 });
  if (FALLBACK.length) tiers.push({ label: PRIMARY.length ? 'cadangan' : 'semua', providers: FALLBACK, rounds: YT_MAX_ROUNDS, retryKinds: ['infra'] });

  const deferred = [];   // provider utama yang dilewati karena lagi istirahat -> jadi upaya TERAKHIR
  let gone = false;

  tierLoop:
  for (let ti = 0; ti < tiers.length; ti++) {
    const tier = tiers[ti];
    if (ti > 0 && Date.now() - startedAt > YT_TOTAL_BUDGET_MS - 10000) { log('Sisa waktu total mepet -- provider cadangan tidak dipanggil.'); break; }

    let candidates = tier.providers;
    if (tier.deferIfCooling) {
      const ready = candidates.filter(p => !providerHealth.isCooling(p.name));
      deferred.push(...candidates.filter(p => !ready.includes(p)));
      candidates = ready;
      if (!candidates.length) { log(`Provider ${tier.label} (${tier.providers.map(p => p.name).join(', ')}) lagi istirahat -- langsung ke cadangan.`); continue; }
    }
    if (ti > 0) log(`${PRIMARY.length ? 'Provider utama gagal' : 'Mulai'} -- memanggil provider ${tier.label}...`);

    let transient = null;
    for (let round = 1; round <= tier.rounds; round++) {
      let cand = candidates;
      if (round > 1) {
        // Putaran ulang HANYA untuk yang gagalnya sementara -- yang kena limit (429)/diblokir gak diganggu lagi.
        cand = candidates.filter(p => transient && transient.has(p.name));
        if (!cand.length) break;
        if (Date.now() - startedAt > YT_TOTAL_BUDGET_MS - 10000) { log('Sisa waktu total mepet -- putaran ulang dibatalkan.'); break; }
        log(`Putaran ${round}/${tier.rounds} (${tier.label}): coba ulang ${cand.map(p => p.name).join(', ')}...`);
        await sleep(YT_RETRY_BACKOFF_MS * (round - 1));
      }
      const { res, info } = await runRound(cand);
      if (info) return info;
      transient = new Set(res.failures.filter(f => tier.retryKinds.includes(f.kind)).map(f => f.provider));
      if (await isGone()) { gone = true; break tierLoop; }
    }
  }

  // Upaya TERAKHIR: provider utama yang tadi dilewati (lagi istirahat) -- lebih baik dicoba daripada gagal total.
  if (!gone && deferred.length) {
    log(`Semua cadangan gagal -- mencoba provider utama yang tadi istirahat (${deferred.map(p => p.name).join(', ')}) sebagai upaya terakhir.`);
    const { info } = await runRound(deferred);
    if (info) return info;
  }

  cleanupTemps();
  setTimeout(cleanupTemps, 15000).unref?.();

  gone = gone || await isGone();
  const summary = allFailures.map(f => `  • ${f.provider}: ${String(f.message).split('\n')[0]}`).join('\n');
  const err = new Error(
    (gone ? 'Video tidak ditemukan / sudah dihapus / privat.\n' : 'Semua provider downloader gagal:\n') + summary +
    '\n(Coba kirim file MP3 langsung via upload)'
  );
  err.code = gone ? 'VIDEO_UNAVAILABLE' : 'ALL_PROVIDERS_FAILED';
  throw err;
}

// Status kesehatan provider (buat command /ytstatus & log).
function getYtProviderStatus() {
  const rows = providerHealth.snapshot(PRIMARY.concat(FALLBACK));
  return rows.map(r => ({ ...r, tier: PRIMARY.some(p => p.name === r.name) ? 'utama' : 'cadangan' }));
}
function getYtProviderMode() {
  const used = PRIMARY.concat(FALLBACK);
  return { primary: PRIMARY.map(p => p.name), fallback: FALLBACK.map(p => p.name), disabled: PROVIDERS.filter(p => !used.includes(p)).map(p => p.name) };
}

// ── Anti-spam ke provider #3: batasi berapa "sweep download" (yang masing2
// nembak ke SEMUA provider paralel) boleh jalan BERSAMAAN dari SELURUH user
// (web + mobile + bot Telegram sekaligus). Ini beda dari cooldown per-user --
// ini batas GLOBAL, jaga-jaga kalau banyak ORANG BEDA-BEDA kebetulan request
// di waktu yang persis sama. Yang kelebihan ANTRE dulu (FIFO), gak langsung
// ikut nembak provider bersamaan yang lain.
const MAX_CONCURRENT_DOWNLOADS = CFG.MAX_CONCURRENT_DOWNLOADS || 3;
let activeDownloads = 0;
const downloadQueue = [];

function runDownloadQueued(fn) {
  return new Promise((resolve, reject) => {
    const task = () => {
      activeDownloads++;
      fn().then(resolve, reject).finally(() => {
        activeDownloads--;
        const next = downloadQueue.shift();
        if (next) next();
      });
    };
    if (activeDownloads < MAX_CONCURRENT_DOWNLOADS) task();
    else {
      console.log(`[Audio] Slot download penuh (${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS}) -- antre dulu, posisi ${downloadQueue.length + 1}`);
      downloadQueue.push(task);
    }
  });
}

// Request yang masuk BARENGAN untuk video yang sama digabung jadi 1 download.
const inflightYt = new Map();

async function ytDownload(ytUrl, outputPath) {
  const videoId = ytCache.extractYtId(ytUrl);

  if (videoId) {
    const useCache = () => {
      const hit = ytCache.get(videoId, YT_CACHE_TTL_MS);
      if (!hit) return null;
      try { fs.copyFileSync(hit.path, outputPath); } catch { return null; }
      return { ...hit.meta, cached: true };
    };

    const cached = useCache();
    if (cached) { console.log(`[Audio] Cache hit (${videoId}) -- gak nembak API provider`); return cached; }

    if (inflightYt.has(videoId)) {
      console.log(`[Audio] Video ${videoId} lagi didownload request lain -- digabung, gak nembak API dobel`);
      await inflightYt.get(videoId); // kalau download-nya gagal, error yang sama diteruskan ke sini
      const shared = useCache();
      if (shared) return shared;
    }
  }

  const job = runDownloadQueued(() => ytDownloadRaw(ytUrl, outputPath)).then((info) => {
    if (videoId) ytCache.put(videoId, outputPath, info);
    return info;
  });
  if (videoId) {
    inflightYt.set(videoId, job);
    const clear = () => { if (inflightYt.get(videoId) === job) inflightYt.delete(videoId); };
    job.then(clear, clear);
  }
  return job;
}

// ── Tetap export neosoftYtDownload untuk backward-compat (wrapper) ───────────
async function neosoftYtDownload(url, outputPath) {
  return ytDownload(url, outputPath);
}

async function fetchYtTitle(url) {
  try {
    const oembed = `${API.YOUTUBE_OEMBED}?url=${encodeURIComponent(url)}&format=json`;
    const r = await fetch(oembed, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    return d.title ? sanitizeTitle(d.title) : null;
  } catch { return null; }
}

async function downloadDirectUrl(url, outputPath) {
  const r = await fetch(url, {
    signal : AbortSignal.timeout(90000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RobloxRequestBot/1.0)' }
  });
  if (!r.ok) throw new Error('Direct download gagal: HTTP ' + r.status);
  const buf = await r.buffer();
  if (buf.length < 2000) throw new Error('File hasil download terlalu kecil/kosong.');
  fs.writeFileSync(outputPath, buf);
  try {
    await getAudioDuration(outputPath);
  } catch (durErr) {
    fs.unlink(outputPath, () => {});
    throw new Error(`File dari link ini bukan audio valid (${durErr.message})`);
  }
  try {
    await reencodeToMp3(outputPath);
  } catch (reencodeErr) {
    fs.unlink(outputPath, () => {});
    throw new Error(`Gagal convert ke MP3 standar (${reencodeErr.message})`);
  }
}

// Paksa convert file audio jadi MP3 ASLI (bukan cuma di-rename ekstensinya)
// pakai ffmpeg -- dipanggil SETELAH download berhasil & lolos cek ffprobe.
// PENTING: banyak API downloader YouTube sebenarnya ngasih audio AAC/M4A/OPUS
// yang cuma dikasih nama file ".mp3" doang -- ffprobe bilang "valid" (soalnya
// emang bisa diputar), TAPI Roblox strict, nolak file kayak gitu sebagai
// "Invalid file type". Re-encode paksa ini mastiin apapun format sumbernya,
// hasil akhirnya SELALU MP3 standar yang diterima Roblox.
// Versi "pintar" (dipakai semua pemanggil): file yang SUDAH MP3 standar
// (codec mp3, 44.1/48 kHz, mono/stereo) dibiarin apa adanya -- gak diencode ulang.
async function reencodeToMp3(filePath, signal) {
  try {
    const probe = await probeAudio(filePath);
    if (isStandardMp3(probe)) return;
  } catch { /* gagal probe -> lanjut encode paksa, biar error aslinya muncul di sana */ }
  return forceReencodeToMp3(filePath, signal);
}

function forceReencodeToMp3(filePath, signal) {
  return new Promise((resolve, reject) => {
    const tmpOut = filePath + '.reencoded.mp3';
    execFile('ffmpeg', [
      '-y', '-i', filePath,
      '-vn', '-acodec', 'libmp3lame',
      '-ar', '44100', '-ac', '2', '-b:a', '192k',
      tmpOut
    ], { timeout: 60000, signal }, (err, stdout, stderr) => {
      if (err) {
        fs.unlink(tmpOut, () => {}); // bersihin sisa file temp kalau ffmpeg gagal di tengah jalan
        return reject(new Error('ffmpeg re-encode error: ' + (stderr || err.message)));
      }
      try {
        fs.renameSync(tmpOut, filePath); // ganti file asli dengan hasil re-encode yang valid
        resolve();
      } catch (renameErr) {
        fs.unlink(tmpOut, () => {});
        reject(renameErr);
      }
    });
  });
}

function ffmpegMix(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const filters = [
      'highpass=f=35',
      'equalizer=f=370:width_type=o:width=0.7:g=2',
      'equalizer=f=523:width_type=o:width=0.7:g=8',
      'equalizer=f=740:width_type=o:width=0.7:g=5',
      'equalizer=f=11840:width_type=o:width=0.7:g=5',
      'equalizer=f=16744:width_type=o:width=0.7:g=10',
      'equalizer=f=20000:width_type=o:width=0.7:g=20',
      'acompressor=threshold=0.08:ratio=4:attack=5:release=80:makeup=3',
      'loudnorm=I=-14:TP=-0.3:LRA=9',
      'alimiter=level_in=1:level_out=1:limit=0.966:attack=2:release=8'
    ].join(',');

    execFile('ffmpeg', [
      '-y', '-i', inputPath,
      '-af', filters,
      '-ar', '44100', '-ac', '2', '-b:a', '192k',
      outputPath
    ], { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('ffmpeg error: ' + (stderr || err.message)));
      resolve();
    });
  });
}

// Sekali ffprobe dapet SEMUANYA: durasi + codec + sample rate + channel.
// (Sebelumnya durasi dan cek format dipanggil terpisah = ffprobe/ffmpeg berkali-kali.)
function probeAudio(filePath) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', [
      '-v', 'error', '-print_format', 'json',
      '-show_entries', 'format=duration:stream=codec_type,codec_name,sample_rate,channels',
      filePath
    ], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('ffprobe error: ' + (stderr || err.message)));
      let j;
      try { j = JSON.parse(String(stdout)); } catch { return reject(new Error('ffprobe: output tidak valid')); }
      const a = (j.streams || []).find(s => s.codec_type === 'audio');
      if (!a) return reject(new Error('ffprobe: tidak ada stream audio'));
      const duration = parseFloat(j.format && j.format.duration);
      if (!isFinite(duration) || duration <= 0) return reject(new Error('ffprobe: durasi tidak valid'));
      resolve({ duration, codec: a.codec_name, sampleRate: parseInt(a.sample_rate, 10) || 0, channels: a.channels || 0 });
    });
  });
}
const isStandardMp3 = (p) => p.codec === 'mp3' && (p.sampleRate === 44100 || p.sampleRate === 48000) && p.channels >= 1 && p.channels <= 2;

// Ambil durasi audio (dalam detik) pakai ffprobe -- dipakai buat validasi
// "lagu maksimal 7 menit". Kerja buat file hasil auto-download YOUTUBE
// MAUPUN file yang diupload langsung sama user (dua-duanya perlu dicek).
function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('ffprobe error: ' + (stderr || err.message)));
      const seconds = parseFloat(String(stdout).trim());
      if (!isFinite(seconds) || seconds <= 0) return reject(new Error('ffprobe: durasi tidak valid'));
      resolve(seconds);
    });
  });
}

module.exports = { fetchYtTitle, ytDownload, neosoftYtDownload, downloadDirectUrl, ffmpegMix, getAudioDuration, reencodeToMp3, probeAudio, getYtProviderStatus, getYtProviderMode, pickDownloadLink };
