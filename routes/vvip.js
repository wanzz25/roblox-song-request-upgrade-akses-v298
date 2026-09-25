// ╔═══════════════════════════════════════════════════════════╗
// ║   Routes — VVIP Auto-Order via QRIS (BuatQris)              ║
// ║   Dipakai oleh public/vvip.html.                            ║
// ║                                                           ║
// ║   Alur: user pilih durasi -> POST /api/vvip/order bikin      ║
// ║   QRIS -> user bayar -> BuatQris kirim webhook ke            ║
// ║   POST /api/vvip/webhook -> role vvip di-set otomatis lewat  ║
// ║   lib/roles.js (setRole) sesuai jumlah hari yang dibeli.     ║
// ╚═══════════════════════════════════════════════════════════╝

const express = require('express');
const crypto  = require('crypto');
const CFG     = require('../config');

const { isConfigured, createQris, checkStatus } = require('../lib/buatqris');
const {
  shopInfo, computePrice, validateDays, validateTier, createOrder, findOrder, findPendingOrderForUser,
  updateOrderStatus, cancelOrder, checkOrderCooldown, markOrderCreated,
  validateUsername, orderExpiryMs, listRecoverableOrders,
} = require('../lib/vvipShop');
const { setRole, getRole, getRoleExpiryMs, getVvipDaysLeft } = require('../lib/roles');
const { readLogs, readTickets } = require('../lib/store');
const { sendMessage } = require('../lib/telegram');
const { escapeHtml } = require('../lib/util');
const { autoBackupOnUserChange } = require('../lib/dbBackup');

const router = express.Router();

const DAY_MS = 24 * 60 * 60 * 1000;

// ── PENGAKTIFAN ROLE SETELAH PEMBAYARAN ─────────────────────────────────────────
// Dipakai bareng oleh webhook, pengecekan ulang ke BuatQris (reconciliation), TEST_MODE, dan
// perintah admin /aktifkanorder -- satu tempat, jadi semua jalur SELALU konsisten.
//   * Idempoten: order yang sudah aktif tidak diproses dua kali (webhook retry / dua jalur bersamaan).
//   * Perpanjangan: beli tier yang sama saat masih aktif -> sisa hari DITAMBAHKAN (dulu ditimpa).
//   * Tidak pernah menurunkan role: VVIP aktif beli VIP -> VVIP diperpanjang; admin/owner/dev -> tidak diubah.
//   * setRole() dicek hasilnya: kalau gagal, order TIDAK dianggap beres -- admin langsung dikabari.
const activating = new Set();

function computePurchaseGrant(order) {
  const tier = order.tier || 'vvip';
  const cur = getRole(order.username);
  const addMs = order.days * DAY_MS;
  if (cur === 'admin' || cur === 'owner' || cur === 'dev') return { action: 'skip-staff', tier: cur, note: `akun ${cur} — role TIDAK diubah` };
  const curExp = getRoleExpiryMs(order.username);
  const remain = curExp ? Math.max(0, curExp - Date.now()) : 0;
  if (cur === tier) return { action: 'extend', tier, durationMs: remain + addMs, note: remain ? `perpanjangan (sisa ${Math.ceil(remain / DAY_MS)} hari ikut ditambahkan)` : 'pembelian baru' };
  if (cur === 'vvip' && tier === 'vip') return { action: 'keep-higher', tier: 'vvip', durationMs: remain + addMs, note: 'sedang VVIP aktif → VVIP diperpanjang, tidak diturunkan ke VIP' };
  return { action: 'set', tier, durationMs: addMs, note: cur === 'vip' && tier === 'vvip' ? 'upgrade VIP → VVIP (masa aktif dihitung dari sekarang)' : 'pembelian baru' };
}

// Apakah username ini pernah terlihat di aplikasi (punya role / pernah request / pernah kirim tiket)?
// Buat mendeteksi salah ketik username SEBELUM pembeli komplain.
function isKnownUsername(username) {
  const key = String(username || '').trim().toLowerCase();
  if (!key) return false;
  try { if (getRole(key) !== 'member') return true; } catch {}
  try { if (readLogs().some(l => String(l.username || '').toLowerCase() === key)) return true; } catch {}
  try { if (readTickets().some(t => String(t.username || '').toLowerCase() === key)) return true; } catch {}
  return false;
}

function activateVvipOrder(order, { isTest = false, source = 'webhook', manual = false } = {}) {
  const id = order.transactionId;
  const fresh = findOrder(id) || order;
  if (fresh.status === 'paid' && fresh.activation !== 'failed') return { ok: true, already: true };   // idempoten
  if (activating.has(id)) return { ok: false, busy: true };
  activating.add(id);
  try {
    const vu = validateUsername(order.username);
    const tier = order.tier || 'vvip';
    const fail = (reason) => {
      updateOrderStatus(id, 'paid', { paidAt: fresh.paidAt || Date.now(), isTest: !!isTest, activation: 'failed', activationError: reason, activatedVia: source });
      sendMessage(
        `🚨 <b>PEMBAYARAN MASUK TAPI ROLE GAGAL DIAKTIFKAN</b>\n\nTrx ID   : <code>${escapeHtml(id)}</code>\nUsername : <code>${escapeHtml(order.username || '-')}</code>\nPaket    : ${tier.toUpperCase()} ${order.days} hari (Rp${Number(order.amount).toLocaleString('id-ID')})\nSebab    : ${escapeHtml(reason)}\n\nAktifkan manual: <code>/setrole ${escapeHtml(order.username || 'username')},-,${tier},${order.days}d</code>`
      ).catch(() => {});
      return { ok: false, reason };
    };
    if (!vu.ok) return fail('username tidak valid: ' + vu.message);
    const knownBefore = isTest || isKnownUsername(vu.username);   // SEBELUM role diberikan (setelahnya semua username "punya role")
    const grant = computePurchaseGrant(order);
    if (grant.action !== 'skip-staff') {
      const okSet = setRole(vu.username, grant.tier, order.displayName || null, grant.durationMs);
      if (!okSet) return fail('setRole() menolak (username/role tidak valid)');
      if (getRole(vu.username) !== grant.tier) return fail(`role setelah diaktifkan (${getRole(vu.username)}) tidak sesuai ${grant.tier}`);
    }
    updateOrderStatus(id, 'paid', {
      paidAt: fresh.paidAt || Date.now(), isTest: !!isTest, activatedAt: Date.now(), activation: grant.action,
      activationNote: grant.note, activatedVia: manual ? 'manual-admin' : source, activatedTier: grant.tier,
    });

    // Manfaatkan mekanisme backup lama -- database/ di-zip & dikirim ke Telegram tiap ada perubahan role.
    autoBackupOnUserChange(
      `${tier.toUpperCase()} ${isTest ? 'TEST MODE (gratis, tanpa bayar)' : 'auto-order lunas'} — ` +
      `<code>${escapeHtml(vu.username)}</code> (${order.days} hari` +
      (isTest ? '' : `, Rp${Number(order.amount).toLocaleString('id-ID')}`) + `)`
    );

    const via = { webhook: 'webhook BuatQris', reconcile: 'pengecekan otomatis ke BuatQris (webhook tidak masuk / order sudah sempat dibatalkan)', manual: 'aktivasi manual admin', test: 'TEST MODE' }[manual ? 'manual' : (isTest ? 'test' : source)] || source;
    const known = knownBefore;
    sendMessage(
      `🌟 <b>${tier.toUpperCase()} aktif ${isTest ? 'via TEST MODE (Rp0, tanpa pembayaran)' : 'otomatis (pembayaran QRIS lunas)'}</b>\n\n` +
      `Username : <code>${escapeHtml(vu.username)}</code>\n` +
      (order.displayName ? `Nama     : <b>${escapeHtml(order.displayName)}</b>\n` : '') +
      `ID Privat: halaman "ID Saya"\n` +
      `Durasi   : ${order.days} hari — ${escapeHtml(grant.note)}\n` +
      `Nominal  : ${isTest ? 'Rp0 (TEST MODE)' : 'Rp' + Number(order.amount).toLocaleString('id-ID')}\n` +
      `Trx ID   : <code>${escapeHtml(id)}</code>\n` +
      `Lewat    : ${escapeHtml(via)}` +
      (known ? '' : `\n\n⚠️ <b>Username ini belum pernah terlihat di aplikasi</b> (belum pernah request/tiket/role). Kemungkinan salah ketik — cek ejaannya dengan pembeli. Kalau salah:\n<code>/setrole ${escapeHtml(vu.username)},-,member</code> lalu <code>/setrole USERNAME_BENAR,-,${tier},${order.days}d</code>`)
    ).catch(() => {});
    return { ok: true, grant };
  } finally {
    activating.delete(id);
  }
}

// ── GET /api/vvip/config — info harga & preset buat halaman vvip.html ───────
router.get('/api/vvip/config', (req, res) => {
  res.json({
    success: true,
    configured: isConfigured(),
    testMode: !!(CFG.VVIP_SHOP && CFG.VVIP_SHOP.TEST_MODE),
    data: shopInfo(),
  });
});

// ── POST /api/vvip/order — bikin QRIS buat 1 pembelian VVIP ─────────────────
router.post('/api/vvip/order', async (req, res) => {
  try {
    // USERNAME WAJIB & dinormalisasi persis seperti halaman login (spasi -> "_", maks 40 karakter).
    const uv = validateUsername(req.body.username);
    if (!uv.ok) return res.status(400).json({ success: false, message: uv.message, field: 'username' });
    const username = uv.username;

    // Nama tampilan OPSIONAL -- kalau diisi, ini yang keliatan ke publik/tiket
    // (bukan username asli), persis konsep "nama rahasia" yang udah ada di
    // /setrole (lihat lib/roles.js getDisplayName). Kosongkan kalau mau
    // dikenal pakai username asli seperti biasa.
    let displayName = String(req.body.displayName || '').trim();
    if (displayName.length > 40) return res.status(400).json({ success: false, message: 'Nama tampilan maksimal 40 karakter.' });
    if (!displayName) displayName = null;

    // (Nomor WA dulu opsional di sini, sekarang DIHAPUS -- "ID privat" VIP/VVIP
    // cuma lewat halaman "ID Saya", gak dikirim ke WhatsApp lagi. Field waNumber
    // dari klien lama kalau masih ke-kirim, diabaikan aja.)

    const dv = validateDays(req.body.days);
    if (!dv.ok) return res.status(400).json({ success: false, message: dv.message });
    const days = dv.days;

    const tv = validateTier(req.body.tier);
    if (!tv.ok) return res.status(400).json({ success: false, message: tv.message });
    const tier = tv.tier;

    // Cegah pembelian yang tidak masuk akal (uang terpakai tapi tidak ada gunanya):
    const curRole = getRole(username);
    if (curRole === 'admin' || curRole === 'owner' || curRole === 'dev') {
      return res.status(400).json({ success: false, message: `Akun "${username}" adalah ${curRole} (akses penuh) — tidak perlu membeli VIP/VVIP.`, field: 'username' });
    }
    if (curRole === 'vvip' && tier === 'vip') {
      const left = getVvipDaysLeft(username);
      return res.status(400).json({ success: false, message: `Akun "${username}" masih VVIP aktif (sisa ${left} hari). Membeli VIP tidak diperlukan — beli VVIP kalau mau memperpanjang.`, field: 'username' });
    }
    // Beli tier yang sama saat masih aktif = perpanjangan: sisa hari DITAMBAHKAN (lihat computePurchaseGrant).

    // ── ANTI-SPAM #1: cooldown antar order dari username yang sama ──────────
    const cd = checkOrderCooldown(username);
    if (!cd.allowed) return res.status(429).json({ success: false, message: cd.message, waitMs: cd.waitMs });

    // ═══ MODE TES (Rp0) — lihat CFG.VVIP_SHOP.TEST_MODE di config.js ═══════
    // Lewati BuatQris SAMA SEKALI, langsung aktifin VVIP-nya. Ditandain jelas
    // di response (`test_mode:true`) biar frontend nampilin UI yang beda
    // (tanpa QR) & gak ketuker sama transaksi beneran.
    if (CFG.VVIP_SHOP && CFG.VVIP_SHOP.TEST_MODE) {
      markOrderCreated(username);
      const order = createOrder({
        transactionId: `TEST-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        username, displayName, tier, days,
        amount: 0, totalAmount: 0,
        qrUrl: null, qrisImage: null, paymentUrl: null, expiredAt: null,
      });
      activateVvipOrder(order, { isTest: true });
      return res.json({
        success: true,
        test_mode: true,
        skip_qr: true,
        data: {
          transaction_id: order.transactionId,
          tier: order.tier,
          days: order.days,
          display_name: order.displayName,
          amount: 0, total_amount: 0,
          username: order.username,
          status: 'paid',
        },
      });
    }

    if (!isConfigured()) {
      return res.status(503).json({ success: false, message: 'Pembayaran otomatis belum dikonfigurasi admin (BUATQRIS_ACCOUNT_ID/SECRET_TOKEN kosong di config.js).' });
    }

    // ── ANTI-SPAM #2: kalau masih ada QR pending yang belum kedaluwarsa buat
    // username ini, pakai ulang QR itu -- gak bikin transaksi baru ke
    // BuatQris tiap kali user refresh/klik ulang tombol beli.
    const existing = findPendingOrderForUser(username);
    if (existing) {
      return res.json({
        success: true,
        reused: true,
        data: {
          transaction_id: existing.transactionId,
          days:           existing.days,
          display_name:   existing.displayName,
          amount:         existing.amount,
          total_amount:   existing.totalAmount,
          qr_url:         existing.qrUrl,
          qris_image:     existing.qrisImage,
          payment_url:    existing.paymentUrl,
          expired_at:     existing.expiredAt,
          expired_at_ms:  orderExpiryMs(existing),
          tier:           existing.tier,
          status:         existing.status,
        },
      });
    }

    const amount = computePrice(days, tier);
    const qr = await createQris({
      amount,
      description: `${tier.toUpperCase()} ${days} hari - ${username}`,
    });

    if (!qr || qr.success !== true) {
      return res.status(502).json({ success: false, message: qr?.message || 'Gagal membuat QRIS, coba lagi.' });
    }

    markOrderCreated(username);
    const order = createOrder({
      transactionId: qr.data.transaction_id,
      username,
      displayName,
      tier,
      days,
      amount,
      totalAmount: qr.data.total_amount,
      qrUrl:       qr.data.qr_url,
      qrisImage:   qr.data.qris_image,
      paymentUrl:  qr.data.payment_url,
      expiredAt:   qr.data.expired_at,
    });

    res.json({
      success: true,
      data: {
        transaction_id: order.transactionId,
        tier:           order.tier,
        days:           order.days,
        display_name:   order.displayName,
        amount:         order.amount,
        total_amount:   order.totalAmount,
        qr_url:         order.qrUrl,
        qris_image:     order.qrisImage,
        payment_url:    order.paymentUrl,
        expired_at:     order.expiredAt,
        expired_at_ms:  order.expiredAtMs,
        username:       order.username,
        status:         order.status,
      },
    });
  } catch (e) {
    console.error('[vvip/order]', e);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan saat membuat pesanan.' });
  }
});

// ── REKONSILIASI langsung ke BuatQris (jaring pengaman "sudah bayar tapi tidak masuk") ─────
// Pembayaran bisa "hilang" karena:
//   1. webhook tidak masuk (signing secret salah, URL webhook salah, jaringan putus);
//   2. order sudah ditandai DIBATALKAN/KEDALUWARSA di sisi kita padahal QR-nya masih hidup di
//      BuatQris -- dulu halaman pembelian otomatis membatalkan order begitu tab disembunyikan
//      (pagehide), dan itu terjadi tepat saat pembeli pindah ke aplikasi bank/e-wallet buat bayar;
//   3. pembeli menutup halaman -> tidak ada lagi polling yang mengecek status.
// Makanya SEMUA order yang belum tercatat lunas (pending / cancelled / expired / failed, dibuat
// dalam RECONCILE_WINDOW_HOURS terakhir) dicek ulang ke BuatQris: lewat polling halaman, DAN lewat
// pengecek latar belakang di bawah (jalan sendiri tiap menit + sekali saat server start).
const lastReconcileAt = new Map();
const RECONCILE_COOLDOWN_MS = 8 * 1000;
const PAID_STATUSES = ['paid', 'success', 'settlement', 'completed', 'lunas', 'sukses', 'berhasil'];

function providerStatusOf(r) {
  const d = (r && r.data) || {};
  return String(d.status || d.transaction_status || d.payment_status || (r && r.status) || '').toLowerCase();
}
const reconcileWindowMs = () => ((CFG.VVIP_SHOP && CFG.VVIP_SHOP.RECONCILE_WINDOW_HOURS) || 72) * 60 * 60 * 1000;
const isRecoverable = (o) => !!o && o.status !== 'paid' && !String(o.transactionId).startsWith('TEST-') && (o.createdAt || 0) >= Date.now() - reconcileWindowMs();

// Balikin order terbaru. { ignoreCooldown } dipakai pengecek latar belakang & perintah admin.
// fresh = pembeli baru KEMBALI ke halaman (mis. dari aplikasi bank) -> jangan nunggu cooldown 8 dtk,
// cukup jeda minimum 1,5 dtk supaya tidak dibanjiri.
async function reconcileWithProvider(order, { ignoreCooldown = false, fresh = false, source = 'reconcile' } = {}) {
  if (!isConfigured() || !isRecoverable(order)) return order;
  const last = lastReconcileAt.get(order.transactionId);
  const now  = Date.now();
  if (!ignoreCooldown && last && (now - last) < (fresh ? 1500 : RECONCILE_COOLDOWN_MS)) return order;
  lastReconcileAt.set(order.transactionId, now);

  try {
    const r = await checkStatus(order.transactionId);
    const providerStatus = providerStatusOf(r);
    if (r && r.success !== false && PAID_STATUSES.includes(providerStatus)) {
      console.warn(`[vvip/reconcile] trx ${order.transactionId} (status lokal: ${order.status}) ternyata LUNAS di BuatQris (${providerStatus}) -- diaktifkan.`);
      activateVvipOrder(order, { isTest: false, source });
      return findOrder(order.transactionId) || order;
    }
  } catch (e) {
    console.error('[vvip/reconcile] Gagal checkStatus ke BuatQris:', e.message);
  }
  return order;
}

// Satu putaran pengecekan latar belakang. Order baru (< 2 jam) dicek tiap putaran, yang lebih tua
// tiap 15 menit -- irit panggilan API tapi tetap menangkap pembayaran yang telat masuk.
const batchLastCheck = new Map();
async function reconcileBatch({ max = 5, force = false } = {}) {
  if (!isConfigured()) return { checked: 0, recovered: 0 };
  const now = Date.now();
  const due = listRecoverableOrders(reconcileWindowMs()).filter(o => {
    if (force) return true;
    const age = now - (o.createdAt || 0);
    const every = age < 2 * 60 * 60 * 1000 ? 45 * 1000 : 15 * 60 * 1000;
    return now - (batchLastCheck.get(o.transactionId) || 0) >= every;
  }).slice(0, force ? 50 : max);

  let recovered = 0;
  for (const o of due) {
    batchLastCheck.set(o.transactionId, Date.now());
    const after = await reconcileWithProvider(o, { ignoreCooldown: true, source: 'reconcile' });
    if (after && after.status === 'paid' && o.status !== 'paid') recovered++;
    await new Promise(r => setTimeout(r, 400));   // jeda kecil antar panggilan
  }
  return { checked: due.length, recovered };
}

let reconcilerStarted = false;
function startOrderReconciler() {
  if (reconcilerStarted) return;
  reconcilerStarted = true;
  const tick = () => reconcileBatch().then(r => { if (r.recovered) console.log(`[vvip/reconcile] ${r.recovered} pembayaran yang telat masuk berhasil diaktifkan.`); }).catch(e => console.error('[vvip/reconcile]', e.message));
  setTimeout(() => reconcileBatch({ force: true }).catch(() => {}), 20 * 1000).unref?.();   // sapu bersih sekali saat server start
  const t = setInterval(tick, 60 * 1000); if (t.unref) t.unref();
}

// ── GET /api/vvip/status/:id — dibaca dari data lokal (di-update webhook), ──
// + rekonsiliasi ke BuatQris untuk order yang belum tercatat lunas (lihat di atas).
router.get('/api/vvip/status/:id', async (req, res) => {
  let order = findOrder(req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order tidak ditemukan.' });

  // Auto-tandai expired di sisi kita kalau sudah lewat expired_at tapi webhook expired belum/gagal
  // masuk -- biar UI gak nyangkut di "menunggu". (expired_at dibaca sebagai WIB -- lihat parseProviderTime.)
  const exp = orderExpiryMs(order);
  if (order.status === 'pending' && exp && Date.now() > exp) {
    updateOrderStatus(order.transactionId, 'expired');
    order.status = 'expired';
  }

  if (order.status !== 'paid') {
    order = await reconcileWithProvider(order, { fresh: req.query && req.query.fresh === '1' });
  }

  res.json({
    success: true,
    data: {
      transaction_id: order.transactionId,
      status:         order.status,
      days:           order.days,
      amount:         order.amount,
      username:       order.username,
      tier:           order.tier,
      expired_at_ms:  orderExpiryMs(order),
      activation:     order.activation || null,
    },
  });
});

// ── POST /api/vvip/cancel/:id — dipanggil tombol "Batal" di vvip.html ───────
// Order DIBATALKAN di sisi kita, tapi QR-nya masih hidup di BuatQris sampai expired_at. Kalau ternyata
// pembeli sudah/akan membayar, pembayarannya TETAP ditangkap (webhook + rekonsiliasi di atas).
router.post('/api/vvip/cancel/:id', (req, res) => {
  const uv = validateUsername(req.body && req.body.username);
  if (!uv.ok) return res.status(400).json({ success: false, message: uv.message });

  const result = cancelOrder(req.params.id, uv.username);
  if (!result.ok) return res.status(404).json({ success: false, message: result.message });
  res.json({ success: true, data: { transaction_id: req.params.id, status: result.order?.status || 'cancelled' } });
});

// ── POST /api/vvip/webhook — dipanggil BuatQris, mount pakai express.raw() ──
// di server.js (lihat catatan di sana) supaya body mentah tersedia buat
// verifikasi tanda tangan HMAC.
router.post('/api/vvip/webhook', async (req, res) => {
  try {
    // Log paling awal, SEBELUM validasi apa pun -- kalau baris ini gak pernah
    // muncul di log server pas ada pembayaran, artinya requestnya emang gak
    // pernah nyampe ke server ini sama sekali (soal jaringan/DNS/URL webhook
    // di dashboard BuatQris, BUKAN soal signing secret).
    console.log(`[vvip/webhook] Diterima request dari ${req.ip} -- Content-Type: ${req.get('Content-Type')}, ada signature: ${!!req.get('X-BuatQris-Signature')}`);

    if (!CFG.BUATQRIS_SIGNING_SECRET) {
      console.warn('[vvip/webhook] Ditolak: BUATQRIS_SIGNING_SECRET belum diisi di config.js.');
      return res.status(501).json({ success: false, message: 'Signing secret belum dikonfigurasi di server.' });
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    const calc = 'sha256=' + crypto.createHmac('sha256', CFG.BUATQRIS_SIGNING_SECRET).update(rawBody).digest('hex');
    const sig  = req.get('X-BuatQris-Signature') || '';

    const sigBuf  = Buffer.from(sig);
    const calcBuf = Buffer.from(calc);
    const validSig = sigBuf.length === calcBuf.length && crypto.timingSafeEqual(sigBuf, calcBuf);
    if (!validSig) {
      // Signature gak cocok -- biasanya karena BUATQRIS_SIGNING_SECRET di
      // config.js beda dari yang aktif di dashboard (mis. pernah di-
      // "Regenerate Token" setelah diisi di sini), atau body sempat
      // ke-parse ulang sebelum sampai sini (urutan middleware di server.js).
      console.warn(`[vvip/webhook] Ditolak: tanda tangan gak cocok. Diterima="${sig.slice(0, 15)}..." Dihitung="${calc.slice(0, 15)}..."`);
      return res.status(401).json({ success: false, message: 'Tanda tangan tidak valid.' });
    }

    const payload = JSON.parse(rawBody.toString('utf8'));
    const { event, transaction_id } = payload;
    console.log(`[vvip/webhook] Signature valid. event="${event}" transaction_id="${transaction_id}"`);

    const order = transaction_id ? findOrder(transaction_id) : null;

    // Balas 200 duluan buat semua event yang bukan urusan kita (mis. event
    // withdrawal.*, atau transaction_id yang gak ketemu di order kita) --
    // biar BuatQris gak nyoba retry sia-sia.
    if (!order) {
      console.warn(`[vvip/webhook] transaction_id="${transaction_id}" gak ketemu di database/vvip/orders.json (bisa jadi event withdrawal, atau order-nya emang bukan dari sini).`);
      return res.sendStatus(200);
    }

    if (event === 'payment.success') {
      // Idempoten -- kalau sudah 'paid' sebelumnya (webhook retry), jangan
      // set role lagi (bisa dobel-reset expiresAt).
      if (order.status !== 'paid') {
        console.log(`[vvip/webhook] Mengaktifkan VVIP buat username="${order.username}" (${order.days} hari) lewat webhook.`);
        const r = activateVvipOrder(order, { isTest: false, source: 'webhook' });
        if (r && r.ok === false && !r.busy) console.error(`[vvip/webhook] Aktivasi GAGAL untuk ${transaction_id}: ${r.reason}`);
      } else {
        console.log(`[vvip/webhook] transaction_id="${transaction_id}" sudah 'paid' sebelumnya -- webhook retry, diabaikan (idempoten).`);
      }
    } else if (event === 'payment.expired' || event === 'payment.failed') {
      if (order.status === 'pending' || order.status === 'cancelled') {
        updateOrderStatus(order.transactionId, event === 'payment.expired' ? 'expired' : 'failed');
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('[vvip/webhook]', e);
    res.status(500).json({ success: false, message: 'Gagal memproses webhook.' });
  }
});

module.exports = router;
// Dipakai server.js (pengecek latar belakang) & bot Telegram (/cekorder, /aktifkanorder).
router.startOrderReconciler = startOrderReconciler;
router.reconcileBatch = reconcileBatch;
router.reconcileWithProvider = reconcileWithProvider;
router.activateVvipOrder = activateVvipOrder;
router.providerStatusOf = providerStatusOf;
