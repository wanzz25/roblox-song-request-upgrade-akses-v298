// ╔═══════════════════════════════════════════════════════════╗
// ║   VVIP Shop — Harga & Penyimpanan Order                    ║
// ║   Dipakai oleh routes/vvip.js (auto-order VVIP via QRIS)    ║
// ╚═══════════════════════════════════════════════════════════╝

const fs   = require('fs');
const path = require('path');
const CFG  = require('../config');

const ROOT       = path.join(__dirname, '..');
const VVIP_DIR   = path.join(ROOT, 'database', 'vvip');
const ORDERS_FILE = path.join(VVIP_DIR, 'orders.json');

function ensureDir() { fs.mkdirSync(VVIP_DIR, { recursive: true }); }

// ── USERNAME: WAJIB & disamakan PERSIS dengan aturan halaman login ─────────────
// Login (public/login.html) menyimpan username sebagai  trim() + spasi->"_"  (maks 40).
// Dulu form pembelian TIDAK melakukan normalisasi yang sama: pembeli yang mengetik
// "Mafat Music" mendapat role untuk "mafat music", padahal akun login-nya "Mafat_Music"
// -> "sudah beli tapi tidak masuk". Sekarang semua jalur (order, batal, cek) lewat sini.
const USERNAME_MAX = 40;
function normalizeUsername(raw) {
  return String(raw == null ? '' : raw).trim().replace(/\s+/g, '_');
}
function validateUsername(raw) {
  const username = normalizeUsername(raw);
  if (!username) return { ok: false, message: 'Username WAJIB diisi — isi username yang sama persis dengan username login kamu.' };
  if (username.length > USERNAME_MAX) return { ok: false, message: `Username maksimal ${USERNAME_MAX} karakter.` };
  if (/[\u0000-\u001f\u007f<>"'`\\]/.test(username)) return { ok: false, message: 'Username mengandung karakter yang tidak diizinkan.' };
  return { ok: true, username };
}

// ── WAKTU dari BuatQris ────────────────────────────────────────────────────────
// expired_at datang sebagai string TANPA zona waktu ("2026-09-21 00:27:06") dan itu waktu
// WIB. new Date(string itu) di server UTC (Pterodactyl) menafsirkannya sebagai UTC ->
// bergeser 7 JAM (order "belum kedaluwarsa" 7 jam lebih lama, QR mati bisa dipakai ulang).
function parseProviderTime(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) { const t = Date.parse(s); return Number.isNaN(t) ? null : t; }   // sudah ada zona waktu
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) { const t = Date.parse(s); return Number.isNaN(t) ? null : t; }
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 7, +m[5], +(m[6] || 0));   // WIB = UTC+7
}
function orderExpiryMs(order) {
  if (!order) return null;
  return order.expiredAtMs != null ? order.expiredAtMs : parseProviderTime(order.expiredAt);
}

// Sama kayak cachedRoles di lib/roles.js -- cache "data order terakhir yang
// valid", biar kalau orders.json sempet gagal dibaca (lagi dipindah/korup),
// history order gak keanggep kosong terus ketiban ke-overwrite jadi cuma 1
// order doang pas ada write berikutnya.
let cachedOrders = null;

function readOrders() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
    cachedOrders = parsed;
    return parsed;
  } catch (e) {
    if (fs.existsSync(ORDERS_FILE)) {
      console.error('[vvipShop] Gagal baca orders.json (mungkin lagi dipindah/korup):', e.message);
    }
    return cachedOrders || [];
  }
}
function saveOrders(list) {
  ensureDir();
  // Tulis atomik (tmp + rename) -- sama alasannya kayak saveRoles() di
  // lib/roles.js: nyegah file kebaca dalam kondisi "setengah tertulis".
  const tmpFile = ORDERS_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(list, null, 2));
  fs.renameSync(tmpFile, ORDERS_FILE);
  cachedOrders = list;
}

// Harga per hari diturunkan dari harga MINGGUAN per tier (config.js ->
// VVIP_SHOP.PRICE_PER_WEEK) -- biar durasi lain (30/90/180 hari, custom)
// tetap dapet harga yang proporsional dari patokan mingguan itu.
function pricePerDay(tier) {
  const shop = CFG.VVIP_SHOP || {};
  const table = shop.PRICE_PER_WEEK || { vvip: 10000, vip: 5000 };
  const perWeek = table[tier] ?? table.vvip ?? 10000;
  return perWeek / 7;
}

// Bulatkan ke kelipatan Rp 100 terdekat biar gak muncul angka aneh (mis. Rp
// 8.611,11) -- tetap proporsional, cuma dirapikan.
function computePrice(days, tier) {
  const raw = pricePerDay(tier) * days;
  return Math.max(100, Math.round(raw / 100) * 100);
}

function validateDays(days) {
  const shop = CFG.VVIP_SHOP || {};
  const min  = shop.MIN_DAYS || 1;
  const max  = shop.MAX_DAYS || 365;
  const n    = Number(days);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, message: 'Jumlah hari harus berupa angka bulat.' };
  if (n < min) return { ok: false, message: `Minimal ${min} hari.` };
  if (n > max) return { ok: false, message: `Maksimal ${max} hari.` };
  return { ok: true, days: n };
}

function validateTier(tier) {
  const t = String(tier || 'vvip').trim().toLowerCase();
  if (t !== 'vvip' && t !== 'vip') return { ok: false, message: 'Tier harus vvip atau vip.' };
  return { ok: true, tier: t };
}

function shopInfo() {
  const shop = CFG.VVIP_SHOP || {};
  const presets = shop.PRESETS || [];
  const tierInfo = (tier) => ({
    pricePerDay: pricePerDay(tier),
    presets: presets.map(d => ({ days: d, price: computePrice(d, tier) })),
  });
  return {
    minDays: shop.MIN_DAYS || 1,
    maxDays: shop.MAX_DAYS || 365,
    tiers: {
      vvip: tierInfo('vvip'),
      vip:  tierInfo('vip'),
    },
  };
}

function createOrder(order) {
  const orders = readOrders();
  orders.unshift({
    transactionId: order.transactionId,
    username:      order.username,
    displayName:   order.displayName || null,
    tier:          order.tier || 'vvip',
    days:          order.days,
    amount:        order.amount,
    totalAmount:   order.totalAmount,
    qrUrl:         order.qrUrl || null,
    qrisImage:     order.qrisImage || null,
    paymentUrl:    order.paymentUrl || null,
    expiredAt:     order.expiredAt || null,
    expiredAtMs:   parseProviderTime(order.expiredAt),   // epoch ms yang BENAR (WIB -> UTC)
    status:        'pending', // pending | paid | expired | failed | cancelled
    createdAt:     Date.now(),
  });
  if (orders.length > 500) orders.splice(500);
  saveOrders(orders);
  return orders[0];
}

function findOrder(transactionId) {
  return readOrders().find(o => String(o.transactionId) === String(transactionId)) || null;
}

// Order PENDING terbaru milik 1 username yang belum kedaluwarsa -- dipakai
// buat "reuse" QR lama kalau user belum bayar & belum lewat expired_at,
// daripada bikin QR baru terus tiap kali halaman di-refresh/klik ulang
// (ini bagian dari anti-spam ke BuatQris, lihat CFG.VVIP_SHOP.ORDER_COOLDOWN_MS).
function findPendingOrderForUser(username) {
  if (!username) return null;
  const u = normalizeUsername(username).toLowerCase();
  const order = readOrders().find(o =>
    o.status === 'pending' &&
    normalizeUsername(o.username).toLowerCase() === u
  );
  if (!order) return null;
  const exp = orderExpiryMs(order);
  if (exp && Date.now() > exp) {
    updateOrderStatus(order.transactionId, 'expired');
    return null;
  }
  return order;
}

// Order yang BELUM tercatat lunas tapi masih layak dicek ke provider: pending / cancelled / expired /
// failed yang dibuat dalam windowMs terakhir. Ini jaring pengaman "sudah bayar tapi tidak masuk" --
// pembayaran bisa datang SETELAH order ditandai dibatalkan/kedaluwarsa (mis. user pindah ke aplikasi
// bank buat bayar), atau webhook-nya gagal masuk. Terbaru dulu.
function listRecoverableOrders(windowMs = 72 * 60 * 60 * 1000) {
  const since = Date.now() - windowMs;
  return readOrders().filter(o => o.status !== 'paid' && (o.createdAt || 0) >= since && !String(o.transactionId).startsWith('TEST-'));
}

function findOrdersByUsername(username, limit = 10) {
  const u = normalizeUsername(username).toLowerCase();
  return readOrders().filter(o => normalizeUsername(o.username).toLowerCase() === u).slice(0, limit);
}

// ── Anti-Spam: cooldown antar pembuatan order per username ──────────────────
// In-memory doang (gak perlu file) -- reset kalau server restart, gak masalah
// karena tujuannya cuma nyegah spam-klik dalam hitungan detik, bukan kuota
// jangka panjang (itu tugasnya limit_bonus/rate_limits, beda modul).
const lastOrderAt = new Map();

function checkOrderCooldown(username) {
  const key = normalizeUsername(username).toLowerCase();
  const cooldown = (CFG.VVIP_SHOP && CFG.VVIP_SHOP.ORDER_COOLDOWN_MS) || 0;
  const last = lastOrderAt.get(key);
  const now = Date.now();
  if (last && (now - last) < cooldown) {
    const waitMs = cooldown - (now - last);
    return { allowed: false, waitMs, message: `Jangan buru-buru! Tunggu ${Math.ceil(waitMs / 1000)} detik lagi sebelum bikin order baru.` };
  }
  return { allowed: true };
}
function markOrderCreated(username) {
  lastOrderAt.set(normalizeUsername(username).toLowerCase(), Date.now());
}

function updateOrderStatus(transactionId, status, extra) {
  const orders = readOrders();
  const order = orders.find(o => String(o.transactionId) === String(transactionId));
  if (!order) return null;
  order.status = status;
  order.updatedAt = Date.now();
  if (extra) Object.assign(order, extra);
  saveOrders(orders);
  return order;
}

// Dipanggil dari tombol "Batal" di vvip.html -- TANPA ini, order yang
// ditinggal user (klik batal / tutup tab) bakal nyangkut status 'pending'
// terus sampai expired_at lewat (bisa belasan menit), padahal usernya udah
// jelas-jelas gak mau lanjut. cancelOrder() langsung nutup order-nya SEKARANG
// juga -- otomatis bikin findPendingOrderForUser() gak bakal nemu/reuse dia
// lagi, jadi user bisa langsung bikin order baru (durasi lain dll) tanpa
// nyangkut ke order yang udah dibatalin.
// username WAJIB dicocokkan (bukan siapa-siapa boleh batalin order orang lain).
function cancelOrder(transactionId, username) {
  const order = findOrder(transactionId);
  if (!order) return { ok: false, message: 'Order tidak ditemukan.' };
  if (normalizeUsername(order.username).toLowerCase() !== normalizeUsername(username).toLowerCase()) {
    return { ok: false, message: 'Order ini bukan milik username tersebut.' };
  }
  if (order.status !== 'pending') {
    return { ok: true, order, alreadyResolved: true }; // idempoten, gak masalah
  }
  const updated = updateOrderStatus(transactionId, 'cancelled', { cancelledAt: Date.now() });
  return { ok: true, order: updated };
}

module.exports = {
  ORDERS_FILE,
  pricePerDay, computePrice, validateDays, validateTier, shopInfo,
  createOrder, findOrder, findPendingOrderForUser, updateOrderStatus, cancelOrder, readOrders,
  checkOrderCooldown, markOrderCreated,
  normalizeUsername, validateUsername, parseProviderTime, orderExpiryMs, listRecoverableOrders, findOrdersByUsername,
};
