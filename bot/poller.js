// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Bot Poller — Long-Polling Telegram getUpdates        ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝

const CFG   = require('../config');
const fetch = require('node-fetch');
const { TG_API } = require('../lib/telegram');
const { handleUpdate } = require('./handler');

let tgOffset = 0;
let tgPollingFailures = 0;

async function pollTelegram() {
  if (!CFG.TELEGRAM_BOT_TOKEN || CFG.TELEGRAM_BOT_TOKEN === 'isi_token_bot_kamu_disini') {
    setTimeout(pollTelegram, 1500);
    return;
  }
  let retryDelay = 0; // sukses -> poll lagi langsung (getUpdates sendiri udah nunggu via timeout=25)
  try {
    const r = await fetch(`${TG_API}/getUpdates?timeout=25&offset=${tgOffset}`);
    const d = await r.json();
    tgPollingFailures = 0;
    if (d.ok && Array.isArray(d.result)) {
      for (const update of d.result) {
        tgOffset = update.update_id + 1;
        try { await handleUpdate(update); } catch (e) { console.error('[TG Update Error]', e); }
      }
    }
  } catch (e) {
    tgPollingFailures++;
    if (tgPollingFailures <= 3) console.error('[TG Poll Error]', e.message);
    retryDelay = 1500; // baru delay kalau error, biar gak spam retry pas koneksi/API down
  } finally {
    setTimeout(pollTelegram, retryDelay);
  }
}

module.exports = { pollTelegram };
