// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Bot ApplyStatus — Update Status Request + Tombol     ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝

const { updateLogStatus, removeClaim } = require('../lib/store');
const { editMessageMarkup, deleteMessage } = require('../lib/telegram');
const { statusLabel } = require('../lib/util');
const { refundRateLimit } = require('../lib/ratelimit');

async function applyStatus(id, status, actor) {
  const extra = {};
  if (actor) extra.lastActionBy = actor;
  const entry = updateLogStatus(id, status, Object.keys(extra).length ? extra : null);
  if (entry) {
    if (status !== 'pending') removeClaim(id);

    if (status === 'rejected' && entry.username) {
      refundRateLimit(entry.username, entry.type === 'banner' ? 'banner' : 'song');
    }
    // DITOLAK = HANYA limit PRIBADI user yang dikembalikan (refundRateLimit di atas).
    // Kuota sesi GLOBAL sengaja tidak dikurangi (beda dengan GAGAL upload, lihat robloxAudioRequest.js).

    const allMsgs = entry.tgMsgs?.length
      ? entry.tgMsgs
      : (entry.tgChatId ? [{ chatId: entry.tgChatId, msgId: entry.tgMsgId }] : []);

    for (const { chatId, msgId } of allMsgs) {
      if (!chatId || !msgId) continue;
      if (status === 'pending') {
        const keyboard = { inline_keyboard: [[
          { text: '✅ ACC',   callback_data: `acc:${id}`, style: 'success' },
          { text: '❌ Tolak', callback_data: `rej:${id}`, style: 'danger' }
        ]] };
        await editMessageMarkup(chatId, msgId, keyboard);
      } else {
        await deleteMessage(chatId, msgId);
      }
    }
  }
  return entry;
}

module.exports = { applyStatus };
