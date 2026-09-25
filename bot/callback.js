// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Bot Callback — Handler Tombol Inline Telegram        ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝

const { isAdmin, isOwner } = require('../lib/store');
const { answerCallback, editMessageText, editMessageMarkup, sendMessage, deleteMessage } = require('../lib/telegram');
const { actorFrom, statusLabel } = require('../lib/util');
const { getAdminMenuPage, getOwnerMenuPage, MENU_HEADER, MENU_SEP } = require('../lib/menu');
const { applyStatus } = require('./apply-status');
const RoAudio = require('./robloxAudio');
const RoAudioReq = require('./robloxAudioRequest');

async function handleCallbackQuery(cq) {
    if (!isAdmin(cq.from?.id)) { await answerCallback(cq.id, '⛔ Bukan admin.'); return; }
    const data = cq.data || '';
    if (data === 'noop') { await answerCallback(cq.id, ''); return; }
    const [action, p1, p2] = data.split(':');

    if (action === 'raUpload') {
      // Tombol "⬆️ Upload ke Roblox" pengganti ACC/Tolak/Pending di kartu request lagu
      // SENGAJA gak di-await -- proses upload+moderasi Roblox bisa makan waktu
      // belasan detik sampai menitan, kalau di-await di sini poller bakal macet
      // nunggu ini kelar dulu sebelum proses update/command lain (bot keliatan
      // "delay banget, gak bisa proses banyak sekaligus"). Biar jalan di
      // belakang aja, statusnya di-update sendiri lewat edit pesan di dalam fungsinya.
      RoAudioReq.handleRequestUploadButton(cq).catch((e) => console.error('[raUpload]', e.message));
      return;
    }

    if (action === 'raDoneReq') {
      // Tombol "✅ Done" setelah izin manual dikasih, khusus upload yang dipicu dari kartu request
      await RoAudioReq.handleRequestDoneButton(cq).catch((e) => console.error('[raDoneReq]', e.message));
      return;
    }

    if (action === 'raDone') {
      // Admin & owner boleh (udah di-gate isAdmin di paling atas function ini)
      const assetId = p1;
      const result = await RoAudio.handleDoneButton(cq.message.chat.id, assetId);
      await answerCallback(cq.id, result.alert);
      if (result.ok) {
        // Kartu status dihapus (bukan di-edit) biar chat gak numpuk kartu
        // yang udah kelar diproses -- konsisten sama flow upload dari kartu request.
        await deleteMessage(cq.message.chat.id, cq.message.message_id);
      }
      return;
    }

    if (action === 'mtype') {
      const isOwnerCq = isOwner(cq.from?.id);
      if (p1 === 'home') {
        const buttons = [[{ text: '🛠️ Admin Menu', callback_data: 'mtype:admin', style: 'primary' }]];
        if (isOwnerCq) buttons[0].push({ text: '👑 Own Menu', callback_data: 'mtype:owner', style: 'danger' });
        await editMessageText(cq.message.chat.id, cq.message.message_id,
          MENU_HEADER + MENU_SEP +
          'Pilih menu yang mau dibuka:\n\n' +
          '🛠️ <b>Admin Menu</b> — fitur harian kelola request, tiket, klaim, dll (bisa dipakai semua admin/sub-admin)\n' +
          (isOwnerCq ? '👑 <b>Own Menu</b> — kontrol penuh app/website, broadcast, backup, dll (khusus owner)\n' : ''),
          { inline_keyboard: buttons }
        );
        await answerCallback(cq.id, ''); return;
      }
      if (p1 === 'owner' && !isOwnerCq) { await answerCallback(cq.id, '⛔ Own Menu khusus owner.'); return; }
      const { text, keyboard } = p1 === 'owner' ? getOwnerMenuPage(1) : getAdminMenuPage(1);
      await editMessageText(cq.message.chat.id, cq.message.message_id, text, keyboard);
      await answerCallback(cq.id, ''); return;
    }

    if (action === 'menu') {
      const type = p1, page = parseInt(p2);
      if (type === 'owner' && !isOwner(cq.from?.id)) { await answerCallback(cq.id, '⛔ Own Menu khusus owner.'); return; }
      const { text, keyboard, total } = type === 'owner' ? getOwnerMenuPage(page) : getAdminMenuPage(page);
      if (page >= 1 && page <= total) {
        await editMessageText(cq.message.chat.id, cq.message.message_id, text, keyboard);
        await answerCallback(cq.id, '');
      }
      return;
    }

    if (!['acc', 'rej', 'pend'].includes(action)) return;
    const id     = p1;
    const status = action === 'acc' ? 'approved' : action === 'rej' ? 'rejected' : 'pending';

    await answerCallback(cq.id,
      action === 'acc'  ? '✅ ACC — memproses...'  :
      action === 'rej'  ? '❌ Tolak — memproses...' :
      '⏳ Pending — memproses...'
    );

    const entry = await applyStatus(id, status, actorFrom(cq.from));
    if (!entry) {
      await sendMessage(`⚠️ Request <code>#${id}</code> tidak ditemukan.`).catch(() => {});
      return;
    }
    if (action !== 'pend') {
      await sendMessage(`${statusLabel[status]} — request <code>#${id}</code> (${entry.requester}) oleh <b>${actorFrom(cq.from).name}</b>.`).catch(() => {});
    }
    return;
}

module.exports = { handleCallbackQuery };
