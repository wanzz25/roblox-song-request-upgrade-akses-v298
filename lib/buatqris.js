// ╔═══════════════════════════════════════════════════════════╗
// ║   BuatQris — Lapisan Komunikasi Open API                    ║
// ║   Dokumentasi lengkap: lihat berkas konfigurasi Open API     ║
// ║   yang dikasih integrator. Base URL & endpoint di apis.js.  ║
// ╚═══════════════════════════════════════════════════════════╝

const fetch = require('node-fetch');
const CFG   = require('../config');
const API   = require('../apis');

function isConfigured() {
  return !!(CFG.BUATQRIS_ACCOUNT_ID && CFG.BUATQRIS_SECRET_TOKEN);
}

async function callApi(params) {
  const body = new URLSearchParams({
    account_id:   CFG.BUATQRIS_ACCOUNT_ID,
    secret_token: CFG.BUATQRIS_SECRET_TOKEN,
    app_name:     'Roblox Song Request VVIP Shop',
    ...params,
  });
  const r = await fetch(API.BUATQRIS_BASE, {
    method : 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body   : body.toString(),
    signal : AbortSignal.timeout(20000),
  });
  return r.json();
}

// amount: nominal rupiah (bulat). description: teks max 100 karakter (provider
// yang motong otomatis). test=true buat transaksi sandbox (dev/testing).
async function createQris({ amount, description, test } = {}) {
  return callApi({
    action:      'api_create_qris',
    amount:      String(Math.round(amount)),
    description: description || 'Pembayaran VVIP',
    ...(test ? { test: '1' } : {}),
  });
}

async function checkStatus(transactionId) {
  return callApi({ action: 'api_check_status', transaction_id: transactionId });
}

module.exports = { isConfigured, createQris, checkStatus };
