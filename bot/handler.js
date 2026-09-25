// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Bot Handler — Router Utama Update Telegram           ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝

const { handleCallbackQuery } = require('./callback');
const { handleMessage } = require('./messages');

async function handleUpdate(update) {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }
  const msg = update.message;
  if (!msg) return;
  await handleMessage(msg);
}

module.exports = { handleUpdate };
