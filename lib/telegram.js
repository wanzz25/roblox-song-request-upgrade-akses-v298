// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Telegram — Lapisan Komunikasi Bot API                ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝

const CFG      = require('../config');
const API      = require('../apis');
const path     = require('path');
const fs       = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const os       = require('os');
const { tmpPath, ensureBudget } = require('./tempdir');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const { readAdmins, readChatMode, activeGroupId } = require('./store');
const { getAutoMode } = require('./autoMode');
const { makeId } = require('./util');

const TG_API = `${API.TELEGRAM_BASE}/bot${CFG.TELEGRAM_BOT_TOKEN}`;

function accRejKeyboard(id) {
  return {
    inline_keyboard: [[
      { text: '✅ ACC',     callback_data: `acc:${id}`,  style: 'success' },
      { text: '❌ Tolak',   callback_data: `rej:${id}`,  style: 'danger' },
      { text: '⏳ Pending', callback_data: `pend:${id}`, style: 'primary' }
    ]]
  };
}

// Ganti ACC/Tolak/Pending manual — admin tinggal tap ini buat proses upload
// ke Roblox, hasil moderasi Roblox yang nentuin diterima/ditolaknya otomatis.
function uploadKeyboard(id) {
  return { inline_keyboard: [[{ text: '⬆️ Upload ke Roblox', callback_data: `raUpload:${id}`, style: 'primary' }]] };
}

// ── Tujuan KARTU REQUEST ─────────────────────────────────────────────────────────
// Kartu request (lagu/banner/video dari web & APK) dikirim dengan opts { card: true }.
//   • Mode /autoupload ON + mode chat "group": kartu dikirim LANGSUNG ke GRUP saja -- tidak ada
//     kartu di chat pribadi & tidak ada salinan ke chat pribadi admin (lihat broadcastToAdmins).
//     Dulu kartu masuk ke chat pribadi Owner LALU disalin lagi ke semua admin (Owner sendiri
//     ikut kena salinan) + grup -> chat pribadi Owner dapat kartu DOBEL dan bikin bingung.
//   • Selain itu (auto-upload OFF, atau mode private): perilaku lama -- chat Owner + salinan ke
//     admin lain (tanpa salinan ke chat yang sudah punya kartu utama).
// Kalau kirim ke grup gagal (bot dikeluarkan dari grup, dsb) -> otomatis jatuh ke chat Owner.
function groupCardChat() {
  try {
    if (getAutoMode().upload && readChatMode().mode === 'group' && activeGroupId()) return String(activeGroupId());
  } catch {}
  return null;
}

async function sendToCardChat(opts, doSend) {
  const group = opts && opts.card ? groupCardChat() : null;
  const chatId = group || (opts && opts.chatId) || CFG.TELEGRAM_CHAT_ID;
  try {
    const r = await doSend(chatId);
    if (group && r && r.ok === false) throw new Error(r.description || 'gagal kirim ke grup');
    return r;
  } catch (e) {
    if (!group) throw e;
    console.warn('[card] Gagal kirim kartu ke grup, fallback ke chat Owner:', e.message);
    return doSend(CFG.TELEGRAM_CHAT_ID);
  }
}

async function sendMessage(text, keyboard, opts) {
  return sendToCardChat(opts, async (chatId) => {
    const body = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (keyboard) body.reply_markup = keyboard;
    const r = await fetch(`${TG_API}/sendMessage`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(body),
      signal : AbortSignal.timeout(10000)
    });
    return r.json();
  });
}

async function sendAudio(filePath, caption, keyboard, filename, opts) {
  return sendToCardChat(opts, async (chatId) => {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('audio', fs.createReadStream(filePath), filename ? { filename } : undefined);
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    if (keyboard) form.append('reply_markup', JSON.stringify(keyboard));
    const r = await fetch(`${TG_API}/sendAudio`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
    const d = await r.json();
    if (!d.ok) throw new Error(d.description || 'sendAudio failed');
    return d;
  });
}

async function sendDocument(filePath, caption, keyboard, filename, opts) {
  return sendToCardChat(opts, async (chatId) => {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', fs.createReadStream(filePath), filename ? { filename } : undefined);
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    if (keyboard) form.append('reply_markup', JSON.stringify(keyboard));
    const r = await fetch(`${TG_API}/sendDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
    return r.json();
  });
}

async function sendPhoto(filePath, caption, keyboard, opts) {
  return sendToCardChat(opts, async (chatId) => {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('photo', fs.createReadStream(filePath));
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    if (keyboard) form.append('reply_markup', JSON.stringify(keyboard));
    const r = await fetch(`${TG_API}/sendPhoto`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
    const d = await r.json();
    if (!d.ok) throw new Error(d.description || 'sendPhoto failed');
    return d;
  });
}

async function answerCallback(callback_query_id, text) {
  try {
    await fetch(`${TG_API}/answerCallbackQuery`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ callback_query_id, text, show_alert: false }),
      signal : AbortSignal.timeout(5000)
    });
  } catch (e) {
    console.warn('[answerCallback]', e.message);
  }
}

async function editMessageMarkup(chat_id, message_id, keyboard) {
  try {
    const r = await fetch(`${TG_API}/editMessageReplyMarkup`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ chat_id, message_id, reply_markup: keyboard || { inline_keyboard: [] } }),
      signal : AbortSignal.timeout(8000)
    });
    const d = await r.json();
    if (!d.ok && d.description && !d.description.includes('message is not modified')) {
      console.warn('[editMarkup]', chat_id, message_id, d.description);
    }
  } catch (e) {
    if (!e.message?.includes('AbortError')) console.warn('[editMarkup timeout]', chat_id, message_id);
  }
}

// PENTING: dulu fungsi ini gak pernah baca balasan Telegram sama sekali (beda dari
// editMessageCaption di bawah yang sudah benar) -- kalau Telegram menolak (mis. rate limit
// 429 karena admin nge-tap tombol "Lanjut ▶" beberapa kali cepat-cepat buat pindah halaman
// /menu, atau gangguan sesaat), request-nya dianggap "berhasil" begitu aja walau pesannya
// TIDAK BERUBAH -- makanya sempat kejadian admin macet di satu halaman menu meski tombol
// "Lanjut" masih ada & bisa di-tap terus. Sekarang dicek & di-retry kayak endpoint lain.
async function editMessageText(chat_id, message_id, text, keyboard, _attempt = 0) {
  try {
    const r = await fetch(`${TG_API}/editMessageText`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ chat_id, message_id, text, parse_mode: 'HTML', reply_markup: keyboard || { inline_keyboard: [] } }),
      signal : AbortSignal.timeout(8000)
    });
    const d = await r.json();
    if (!d.ok && d.description && !d.description.includes('message is not modified')) {
      // 429 (rate limit) & 5xx (Telegram lagi gangguan) = coba lagi sebentar; selebihnya (mis.
      // "message to edit not found") percuma diulang.
      const retryable = d.error_code === 429 || d.error_code >= 500;
      if (retryable && _attempt < 3) {
        const wait = d.parameters?.retry_after ? d.parameters.retry_after * 1000 : 600 * (_attempt + 1);
        await new Promise((res) => setTimeout(res, wait));
        return editMessageText(chat_id, message_id, text, keyboard, _attempt + 1);
      }
      console.warn('[editText]', chat_id, message_id, d.description);
    }
    return d;
  } catch (e) {
    console.warn('[editText]', e.message);
    return null;
  }
}

// Sama kayak editMessageText, tapi buat pesan yang isinya audio/foto/dokumen
// (Telegram wajib pakai endpoint beda buat edit "caption" media, gak bisa
// pakai editMessageText walaupun keliatannya cuma teks doang).
async function editMessageCaption(chat_id, message_id, caption, keyboard) {
  try {
    const r = await fetch(`${TG_API}/editMessageCaption`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ chat_id, message_id, caption, parse_mode: 'HTML', reply_markup: keyboard || { inline_keyboard: [] } }),
      signal : AbortSignal.timeout(8000)
    });
    const d = await r.json();
    if (!d.ok && d.description && !d.description.includes('message is not modified')) {
      console.warn('[editCaption]', chat_id, message_id, d.description);
    }
    return d;
  } catch (e) {
    console.warn('[editCaption]', e.message);
    return null;
  }
}

async function copyMessageTo(fromChatId, msgId, toChatId, keyboard) {
  try {
    const body = { chat_id: String(toChatId), from_chat_id: String(fromChatId), message_id: msgId };
    if (keyboard) body.reply_markup = keyboard;
    const r = await fetch(`${TG_API}/copyMessage`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(body),
      signal : AbortSignal.timeout(10000)
    });
    return r.json();
  } catch (e) { console.warn('[copyMsg]', e.message); return null; }
}

function getBroadcastTargets() {
  const targets = readAdmins().map(String);
  const mode = readChatMode().mode;
  if (mode === 'group' && activeGroupId() && !targets.includes(String(activeGroupId()))) {
    targets.push(String(activeGroupId()));
  }
  return targets;
}

async function broadcastToAdmins(fromChatId, msgId, keyboard) {
  // Kartu sudah dikirim langsung ke GRUP (mode /autoupload) -> tidak ada salinan ke chat pribadi.
  const group = groupCardChat();
  if (group && String(fromChatId) === group) return [];
  // Jangan menyalin kartu ke chat yang SUDAH memegang kartu aslinya (dulu Owner dapat dobel).
  const admins = getBroadcastTargets().filter(id => String(id) !== String(fromChatId));
  const copies = [];
  for (const adminId of admins) {
    try {
      const r = await copyMessageTo(fromChatId, msgId, adminId, keyboard);
      if (r?.ok) copies.push({ chatId: String(adminId), msgId: r.result.message_id });
      else console.warn(`[broadcast] Gagal ke admin ${adminId}:`, r?.description);
    } catch (e) { console.warn('[broadcast]', e.message); }
  }
  return copies;
}

async function downloadTgFile(fileId) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r1 = await fetch(`${TG_API}/getFile?file_id=${fileId}`, { signal: AbortSignal.timeout(30000) });
      const d1 = await r1.json();
      if (!d1.ok) throw new Error('getFile gagal: ' + d1.description);
      const filePath = d1.result.file_path;
      const url = `${API.TELEGRAM_BASE}/file/bot${CFG.TELEGRAM_BOT_TOKEN}/${filePath}`;
      // Timeout dibikin longgar (10 menit) -- ini jaring pengaman terakhir buat
      // koneksi yang BENERAN macet total, bukan buat gagalin transfer yang cuma
      // lambat (misal file gede atau koneksi server lagi kurang bagus).
      const r2 = await fetch(url, { signal: AbortSignal.timeout(600000) });
      if (!r2.ok) throw new Error('Download file gagal (HTTP ' + r2.status + ')');
      const ext = path.extname(filePath) || '.mp3';
      // Pastikan ada tempat SEBELUM nulis (ukuran file dari Telegram) -- kalau penuh, gagal
      // dengan pesan yang jelas & Owner dikabari, bukan ENOSPC mentah di tengah proses.
      ensureBudget((Number(d1.result.file_size) || 15 * 1024 * 1024) + 5 * 1024 * 1024, 'download file dari Telegram');
      const tmpIn = tmpPath(`mix_in_${makeId()}${ext}`);
      // FIX: sebelumnya `await r2.buffer()` nampung SELURUH file di memori
      // (RAM) dulu sebelum ditulis ke disk -- buat audio/gambar kecil gak
      // kerasa, tapi buat video (bisa puluhan MB) ini bikin RAM Node.js
      // melonjak tiap kali ada yang request video. Sekarang di-stream
      // LANGSUNG dari response ke file di disk (r2.body di node-fetch@2
      // udah berupa Node.js Readable asli), gak pernah nampung utuh di
      // memori sekaligus, berapapun gede file-nya.
      try { await pipeline(r2.body, fs.createWriteStream(tmpIn)); }
      catch (wErr) { fs.unlink(tmpIn, () => {}); throw wErr; }   // jangan biarin file setengah jadi numpuk
      return tmpIn;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        console.warn(`[downloadTgFile] Gagal (${err.message}), coba lagi... (${attempt + 1}/3)`);
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

async function sendAudioTo(chatId, filePath, caption, filename) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('audio', fs.createReadStream(filePath), filename ? { filename } : undefined);
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  const r = await fetch(`${TG_API}/sendAudio`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
  const d = await r.json();
  if (!d.ok) throw new Error(d.description || 'sendAudioTo failed');
  return d;
}

// Sama kayak sendDocument(), tapi ke chatId SPESIFIK (bukan selalu OWNER) --
// dipakai buat kirim hasil (mis. file .txt daftar ID Video Tron) ke chat
// TEMPAT tombol "Upload ke Roblox" di-klik (bisa admin biasa, bukan cuma Owner).
async function sendDocumentTo(chatId, filePath, caption, filename) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', fs.createReadStream(filePath), filename ? { filename } : undefined);
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  const r = await fetch(`${TG_API}/sendDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
  const d = await r.json();
  if (!d.ok) throw new Error(d.description || 'sendDocumentTo failed');
  return d;
}

async function sendMessageTo(chatId, text, keyboard) {
  const body = { chat_id: String(chatId), text, parse_mode: 'HTML' };
  if (keyboard) body.reply_markup = keyboard;
  const r = await fetch(`${TG_API}/sendMessage`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify(body),
    signal : AbortSignal.timeout(10000)
  });
  return r.json();
}

async function sendChatAction(chatId, action) {
  await fetch(`${TG_API}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: String(chatId), action })
  });
}

async function notifyAdmins(text) {
  const r = await sendMessage(text);
  if (readChatMode().mode === 'group' && activeGroupId()) {
    sendMessageTo(activeGroupId(), text).catch(e => console.warn('[notifyAdmins group]', e.message));
  }
  return r;
}

async function deleteMessage(chat_id, message_id) {
  try {
    await fetch(`${TG_API}/deleteMessage`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ chat_id, message_id }),
      signal : AbortSignal.timeout(8000)
    });
  } catch (e) {
    console.warn('[deleteMessage]', chat_id, message_id, e.message);
  }
}

module.exports = {
  TG_API, accRejKeyboard, uploadKeyboard,
  sendMessage, sendAudio, sendDocument, sendPhoto,
  answerCallback, editMessageMarkup, editMessageText, editMessageCaption, copyMessageTo,
  getBroadcastTargets, broadcastToAdmins, groupCardChat,
  downloadTgFile, sendAudioTo, sendDocumentTo, sendMessageTo, sendChatAction,
  notifyAdmins, deleteMessage
};
