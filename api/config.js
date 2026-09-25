// ╔═══════════════════════════════════════════════════════════╗
// ║        Roblox Request — API Config                     ║
// ║   Router ini sekarang jalan NEMPEL sama panel utama       ║
// ║   (di-mount di server.js path /mobile-api), BUKAN proses   ║
// ║   terpisah lagi -> gak butuh PORT/DOMAIN sendiri.          ║
// ║   Developer : wanz | https://copyright.by-wanzz.my.id/   ║
// ╚═══════════════════════════════════════════════════════════╝

module.exports = {

  // Kosongin aja / gak usah diisi -> otomatis manggil diri sendiri lewat
  // localhost (satu proses yang sama dengan panel). Isi ini HANYA kalau
  // panel & router ini kamu jalankan di 2 server terpisah beneran.
  PANEL_URL: '',

  // Mobile token — generate lewat /genmobilekey di Telegram bot panel.
  // Token yang sama ini juga dipakai buat ngamanin endpoint /admin/* di
  // router ini (dicek lewat header x-admin-key), jadi cuma dibutuhin SATU
  // token buat semuanya. WAJIB diisi, harus sama persis dengan
  // config.js (root) -> API_ADMIN_KEY / BRIDGE_ADMIN_KEY.
  // Contoh: 'wmob_a1b2c3d4e5f6g7h8i9j0...'
  PANEL_MOBILE_TOKEN: 'wmob_1c8be4385b136daee2c7a489a29b5ad33fa31a434650c9c0',

  // ── Session ─────────────────────────────────────────────────────────
  // Durasi session key APK (dalam milidetik) — default 7 hari
  SESSION_DURATION_MS: 7 * 24 * 60 * 60 * 1000,

};
