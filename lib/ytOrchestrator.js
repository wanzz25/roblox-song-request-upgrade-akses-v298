// ╔═══════════════════════════════════════════════════════════╗
// ║   YT Orchestrator — atur SIAPA provider downloader yang     ║
// ║   dipanggil, KAPAN, dan seberapa banyak.                    ║
// ║                                                           ║
// ║   Dulu: SEMUA provider (10 biji) ditembak BERSAMAAN untuk   ║
// ║   tiap 1 request -> 10 hit API per request, provider kena    ║
// ║   rate-limit/blokir, CPU & RAM server juga ikut kepakai      ║
// ║   (10 download + 10 ffmpeg paralel) -> banyak yang gagal.    ║
// ║                                                           ║
// ║   Sekarang:                                                ║
// ║    • Provider dicoba BERTAHAP (hedging): yang terbaik dulu,  ║
// ║      provider berikutnya baru ikut kalau yang pertama gagal   ║
// ║      atau kelamaan -- biasanya cuma 1-2 hit per request.      ║
// ║    • Provider yang lagi error/kena limit di-ISTIRAHATIN       ║
// ║      (cooldown) dan diurutkan ulang berdasar rekam jejak.     ║
// ╚═══════════════════════════════════════════════════════════╝

// ── Klasifikasi error ────────────────────────────────────────────────────────
//  ratelimit : provider bilang kebanyakan request (HTTP 429)
//  auth      : ditolak/diblokir (HTTP 401/403)
//  infra     : provider bermasalah (5xx, timeout, koneksi putus, response bukan JSON)
//  content   : masalah di video/file-nya (link mati, gak ada audio, dll)
function classifyError(err) {
  const m = String((err && err.message) || err || '');
  if (/HTTP 429|too many requests|rate.?limit/i.test(m)) return 'ratelimit';
  if (/HTTP (401|403)/i.test(m)) return 'auth';
  if (/HTTP 5\d\d|timeout|timed out|ETIMEDOUT|ECONN|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed|Unexpected token|invalid json|in JSON|Response kosong/i.test(m)) return 'infra';
  return 'content';
}

// ── Kesehatan provider ───────────────────────────────────────────────────────
class ProviderHealth {
  constructor() { this.map = new Map(); }

  _get(name) {
    if (!this.map.has(name)) this.map.set(name, { streak: 0, cooldownUntil: 0, latencyMs: null, ok: 0, fail: 0, lastError: null, lastKind: null });
    return this.map.get(name);
  }

  isCooling(name, now = Date.now()) { return this._get(name).cooldownUntil > now; }

  recordSuccess(name, ms) {
    const h = this._get(name);
    h.streak = 0; h.cooldownUntil = 0; h.ok++;
    h.latencyMs = h.latencyMs == null ? ms : Math.round(h.latencyMs * 0.6 + ms * 0.4); // rata-rata bergerak
  }

  // kind: 'ratelimit' | 'auth' | 'infra' | 'content'
  recordFailure(name, kind, errMsg, now = Date.now()) {
    const h = this._get(name);
    h.fail++; h.lastError = errMsg ? String(errMsg).slice(0, 160) : null; h.lastKind = kind;
    if (kind === 'ratelimit') { h.streak++; h.cooldownUntil = now + 5 * 60 * 1000; return; }   // kena limit -> istirahat 5 menit
    if (kind === 'auth')      { h.streak++; h.cooldownUntil = now + 15 * 60 * 1000; return; }  // key/blokir -> 15 menit
    h.streak++;
    // infra: mulai istirahat dari kegagalan ke-2 berturut-turut; content: dari ke-3
    const threshold = kind === 'infra' ? 2 : 3;
    if (h.streak >= threshold) {
      const backoff = Math.min(2 * 60 * 1000 * Math.pow(2, h.streak - threshold), 20 * 60 * 1000); // 2m, 4m, 8m... maks 20m
      h.cooldownUntil = now + backoff;
    }
  }

  // Urutan coba: yang sehat & cepat dulu; yang lagi cooldown ditaruh PALING BELAKANG
  // (tetap dipakai sebagai upaya terakhir kalau semua yang lain sudah gagal).
  order(providers, now = Date.now()) {
    const scored = providers.map((p, idx) => {
      const h = this._get(p.name);
      return { p, idx, cooling: h.cooldownUntil > now, streak: h.streak, lat: h.latencyMs == null ? 8000 : h.latencyMs, until: h.cooldownUntil };
    });
    scored.sort((a, b) => {
      if (a.cooling !== b.cooling) return a.cooling ? 1 : -1;
      if (a.cooling && b.cooling) return a.until - b.until;   // yang paling cepat selesai istirahat duluan
      if (a.streak !== b.streak) return a.streak - b.streak;
      if (Math.abs(a.lat - b.lat) > 1500) return a.lat - b.lat;
      return a.idx - b.idx;                                    // seri -> ikut urutan prioritas awal di array
    });
    return scored.map(s => s.p);
  }

  snapshot(providers, now = Date.now()) {
    return providers.map(p => {
      const h = this._get(p.name);
      return { name: p.name, ok: h.ok, fail: h.fail, streak: h.streak, latencyMs: h.latencyMs,
               cooldownSec: Math.max(0, Math.ceil((h.cooldownUntil - now) / 1000)), lastError: h.lastError };
    });
  }
}

// ── Balapan bertahap (hedged race) ───────────────────────────────────────────
// Menjalankan `attempt(provider, signal)` untuk provider berurutan:
//   - provider #1 langsung jalan
//   - provider berikutnya baru ikut kalau: (a) yang jalan gagal, atau
//     (b) sudah `hedgeMs` berlalu tanpa pemenang -- dan yang sedang jalan
//     belum mencapai `maxInFlight`
//   - PEMENANG = attempt pertama yang sukses tuntas; sisanya langsung di-abort.
// Kalau semuanya lambat, jumlah provider yang jalan bersamaan naik pelan-pelan
// (tiap `hedgeMs` boleh +1, maksimal maxInFlight+3), bukan meledak sekaligus.
// `maxAttempts` = batas TOTAL provider yang boleh dicoba untuk 1 putaran (biar kalau
// semuanya gagal, API gak dikeroyok semua); `deadlineMs` = batas waktu total.
// `shouldStop()` (opsional) dipanggil tiap ada kegagalan: kalau true, provider
// yang belum dicoba TIDAK dilanjutkan (dipakai buat link yang jelas sudah mati).
// Kembalian: { winner, winnerProvider, failures:[{provider,kind,message}], tried }
async function raceProviders({ providers, attempt, health, hedgeMs = 5000, maxInFlight = 2, maxAttempts = Infinity, deadlineMs = 75000, shouldStop = null, log = () => {} }) {
  const ordered = health.order(providers);
  const controllers = new Map();
  const failures = [];
  let next = 0, inFlight = 0, done = false, timer = null, deadlineTimer = null, stoppedEarly = false, hedgeTicks = 0;
  const tried = [];

  return new Promise((resolve) => {
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearTimeout(deadlineTimer);
      controllers.forEach((c) => { try { c.abort(); } catch {} });
      resolve(result);
    };

    const noMoreToTry = () => next >= Math.min(ordered.length, maxAttempts);

    const maybeFinishFailed = () => {
      if (done) return;
      if (inFlight === 0 && (noMoreToTry() || stoppedEarly)) finish({ winner: null, failures, tried });
    };

    const scheduleHedge = () => {
      clearTimeout(timer);
      if (done || noMoreToTry()) return;
      timer = setTimeout(() => {
        hedgeTicks++;
        const allowed = maxInFlight + Math.min(3, Math.max(0, hedgeTicks - 1));
        if (!done && inFlight < allowed) launch('hedge');
        scheduleHedge();
      }, hedgeMs);
    };

    const launch = (why) => {
      if (done || noMoreToTry()) return;
      const provider = ordered[next++];
      const controller = new AbortController();
      controllers.set(provider.name, controller);
      inFlight++; tried.push(provider.name);
      const t0 = Date.now();
      log(`▶ ${provider.name} (${why})`);
      attempt(provider, controller.signal).then(
        (value) => {
          inFlight--;
          if (done) return;
          const ms = Date.now() - t0;
          health.recordSuccess(provider.name, ms);
          // provider yang gagal SEBELUM pemenang ketemu = salah dia sendiri (ada yang berhasil dgn video yang sama)
          for (const f of failures) if (f.kind === 'content' && !f.recorded) { health.recordFailure(f.provider, 'content', f.message); f.recorded = true; }
          finish({ winner: value, winnerProvider: provider.name, winnerMs: ms, failures, tried });
        },
        (err) => {
          inFlight--;
          if (done) return;
          if (controller.signal.aborted) return; // dibatalkan, bukan kegagalan provider
          const kind = classifyError(err);
          failures.push({ provider: provider.name, kind, message: err.message, recorded: false });
          // infra/ratelimit/auth jelas salah provider -> langsung dicatat.
          // content baru dicatat kalau ternyata ada provider lain yang berhasil (lihat di atas).
          if (kind !== 'content') { health.recordFailure(provider.name, kind, err.message); failures[failures.length - 1].recorded = true; }
          log(`✖ ${provider.name}: [${kind}] ${String(err.message).split('\n')[0].slice(0, 120)}`);
          // shouldStop boleh mengembalikan Promise (mis. nunggu hasil cek cepat "link mati?")
          Promise.resolve(shouldStop ? shouldStop() : false).then((stop) => {
            if (done) return;
            stoppedEarly = !!stop;
            if (stop) { maybeFinishFailed(); return; }
            if (!noMoreToTry() && inFlight < maxInFlight) { launch('fallback'); scheduleHedge(); }
            else maybeFinishFailed();
          }, () => { if (!done) { if (!noMoreToTry() && inFlight < maxInFlight) { launch('fallback'); scheduleHedge(); } else maybeFinishFailed(); } });
        }
      );
    };

    if (!ordered.length) { finish({ winner: null, failures, tried }); return; }
    deadlineTimer = setTimeout(() => { log('⏱ batas waktu total habis'); finish({ winner: null, failures, tried, timedOut: true }); }, deadlineMs);
    launch('utama');
    scheduleHedge();
  });
}

module.exports = { ProviderHealth, raceProviders, classifyError };
