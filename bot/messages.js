// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Bot Messages — Dispatcher Command Teks Telegram      ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const CFG  = require('../config');

const {
  isAdmin, isOwner, OWNER_ID, readAdmins, writeAdmins,
  readBans, saveBans,
  isIpBanned, banIp, unbanIp, getUserIps,
  readPins, savePins, isPinned,
  readClaims, saveClaims, setClaim, removeClaim, getClaim,
  readLogs, saveLogs, findEntry, LOGS_FILE,
  readTickets, saveTickets, findTicket, findTicketByText, saveTicket, TICKETS_FILE,
  saveAnnounce, clearAnnounce,
  readChatMode, writeChatMode,
  readReqStatus, writeReqStatus,
  readAppStatus, writeAppStatus,
  readAudit, writeAudit,
  writeGroupOverride, activeGroupId,
  isOwnerOnly,
  getMaxQueue, setMaxQueue
} = require('../lib/store');

const {
  RATE_LIMITS, readRates, saveRates, getBonus, addBonus, resetUserRate, saveLimitsConfig,
  refundRateLimit, getRateWindow, setWindow, fmtWindow
} = require('../lib/ratelimit');

const {
  accRejKeyboard, sendMessage, sendMessageTo, sendAudioTo, sendChatAction,
  sendDocument, downloadTgFile
} = require('../lib/telegram');

const { ffmpegMix } = require('../lib/audio');
const { getTime, actorFrom, statusLabel, escapeHtml, makeId, sanitizeFilename } = require('../lib/util');
const { getAdminMenuPage, getOwnerMenuPage, MENU_HEADER, MENU_SEP } = require('../lib/menu');
const { runBackup, BACKUP_DIR } = require('../lib/backup');
const { applyStatus } = require('./apply-status');
const RoAudio = require('./robloxAudio');

async function handleMessage(msg) {
  const senderId = String(msg.from?.id || '');
  if (!isAdmin(senderId)) return;

  const chatId = msg.chat.id;
  const text = (msg.text || '').trim().replace(/^(\/[a-zA-Z0-9_]+)@\S+/, '$1');

  if (msg.text && msg.text.trim().toLowerCase().startsWith('/mixing')) {

    const mixIsPrivate = (msg.chat?.type || 'private') === 'private';
    if (!mixIsPrivate && readChatMode().mode !== 'group') {
      await sendMessageTo(chatId,
        '⛔ <b>Bot masih mode Private Only.</b>\n' +
        'Command hanya bisa dipakai lewat chat private dengan bot.'
      );
      return;
    }

    const replied = msg.reply_to_message;

    const audioObj = replied?.audio || replied?.voice || replied?.document;
    const isAudio = audioObj && (
      replied?.audio ||
      replied?.voice ||
      (replied?.document && /audio|mp3|mp4|wav|ogg|flac|m4a|aac/i.test(replied.document.mime_type || ''))
    );

    if (!replied || !isAudio) {
      await sendMessageTo(chatId,
        '⚠️ <b>Cara pakai /mixing:</b>\n\n' +
        'Reply ke pesan audio mana saja lalu ketik <code>/mixing</code>\n\n' +
        '<i>Bot akan memproses & mengirim balik audio yang sudah di-boost.</i>'
      );
      return;
    }

    await sendMessageTo(chatId, '🎛️ <b>Memproses audio...</b>\n<i>Sabar sebentar, lagi di-mixing...</i>');
    await sendChatAction(chatId, 'upload_audio');

    let tmpIn = null, tmpOut = null;
    try {
      const fileId = audioObj.file_id;
      tmpIn  = await downloadTgFile(fileId);
      tmpOut = require('../lib/tempdir').tmpPath(`mix_out_${makeId()}.mp3`);

      await ffmpegMix(tmpIn, tmpOut);

      const origTitle = replied.audio?.title || replied.audio?.file_name || replied.document?.file_name || 'audio';
      const caption =
        '✅ <b>Mixing selesai!</b>\n\n' +
        `🎵 <b>${origTitle}</b>\n` +
        '📊 Proses: Bass 100Hz +7dB • Body 160Hz +6dB • Mid clean • -14 LUFS (Roblox-safe)\n\n' +
        '<i>— by wanz</i>';

      await sendAudioTo(chatId, tmpOut, caption, sanitizeFilename(origTitle, '.mp3'));

    } catch (err) {
      console.error('[Mixing Error]', err);
      await sendMessageTo(chatId, '❌ Gagal memproses audio.\n<code>' + (err.message || '') + '</code>');
    } finally {
      if (tmpIn)  fs.unlink(tmpIn,  () => {});
      if (tmpOut) fs.unlink(tmpOut, () => {});
    }
    return;
  }

  // ── Roblox Audio Auto-Upload: kirim audio/gambar langsung (bukan reply /mixing) ──
  // Boleh admin & owner, boleh dipakai di grup (ikut mode /grouponly sama kayak command biasa).
  if (!msg.text && (msg.audio || msg.document || msg.photo)) {
    const raIsPrivate = (msg.chat?.type || 'private') === 'private';
    if (!raIsPrivate && readChatMode().mode !== 'group') return; // diemin aja di grup kalau masih private-only mode

    const media = RoAudio.extractMediaFromMessage(msg);
    if (media) {
      if (RoAudio.checkDuplicate(chatId, media)) return;
      const queuePos = RoAudio.getQueuePosition();
      const statusMsg = await RoAudio.sendInfoFast(chatId, {
        title: media.title,
        status: queuePos === 0 ? '📥 Diterima, langsung diproses...' : `📥 Diterima, antre di posisi ${queuePos}...`,
        id: null
      });
      RoAudio.runQueued(() =>
        RoAudio.handleAssetUpload(chatId, media.fileId, media.fileName, media.title, media.fileUniqueId, media.assetType, media.contentType, statusMsg)
      ).catch((err) => console.error('[RobloxAudio] Upload queue error:', err.message));
      return;
    }
  }

  if (!msg.text) return;

  if (!isOwner(senderId) && isOwnerOnly(text)) {
    await sendMessageTo(chatId,
      '⛔ <b>Akses ditolak.</b>\n' +
      'Perintah ini hanya untuk <b>Owner</b>.\n\n' +
      'Kamu hanya bisa:\n' +
      '• /list — lihat request pending\n' +
      '• /acc /tolak /pending &lt;id&gt;\n' +
      '• /tickets — lihat & balas tiket\n' +
      '• /mixing — boost audio\n' +
      '• Tap tombol ✅ / ❌ / ⏳ di pesan request'
    );
    return;
  }

  const isPrivateChat = (msg.chat?.type || 'private') === 'private';
  const cmdIsOwnerOnly = isOwnerOnly(text);

  if (!isPrivateChat) {
    if (cmdIsOwnerOnly) {
      await sendMessageTo(chatId,
        '⛔ <b>Command ini wajib di chat private dengan bot.</b>\n' +
        'Kontrol app/website & seluruh command owner tidak bisa dijalankan dari grup, apapun mode aktif.'
      );
      return;
    }
    const chatMode = readChatMode().mode;
    if (chatMode !== 'group') {
      await sendMessageTo(chatId,
        '⛔ <b>Bot masih mode Private Only.</b>\n' +
        'Command hanya bisa dipakai lewat chat private dengan bot.\n\n' +
        '<i>Owner bisa ketik /grouponly (di private chat) untuk mengizinkan command biasa dipakai di grup.</i>'
      );
      return;
    }
  }

  if (text.startsWith('/')) {
    writeAudit(actorFrom(msg.from), text.length > 60 ? text.slice(0, 60) + '…' : text);
  }

  if (msg.reply_to_message) {
    const replyText = msg.reply_to_message.text || msg.reply_to_message.caption || '';
    const ticket = findTicketByText(replyText);
    if (ticket && ticket.status !== 'closed') {
      const time = getTime();
      ticket.messages.push({ from: 'admin', text, time });
      saveTicket(ticket);
      await sendMessageTo(chatId, `✅ Balasan terkirim ke tiket <code>#${ticket.id}</code> (${ticket.name}).`);
      return;
    }
  }

  if (text === '/tickets' || text === '/tiket') {
    const open = readTickets().filter(t => t.status !== 'closed');
    if (!open.length) { await sendMessage('Tidak ada tiket yang masih terbuka. 🎉'); return; }
    const lines = open.slice(0, 20).map(t => {
      const last = t.messages[t.messages.length - 1];
      return `<code>#${t.id}</code> — ${t.name}${t.username ? ' (@' + t.username + ')' : ''}\n<i>"${(last?.text || '').slice(0, 60)}"</i>`;
    });
    await sendMessage(`<b>Tiket Terbuka (${open.length})</b>\n\n${lines.join('\n\n')}\n\n<i>Reply pesan tiket aslinya untuk membalas.</i>`);
    return;
  }

  const closeMatch = text.match(/^\/closetiket[_ ](\S+)$/i);
  if (closeMatch) {
    const ticket = findTicket(closeMatch[1].replace(/^#/, ''));
    if (!ticket) { await sendMessage('Tiket tidak ditemukan.'); return; }
    ticket.status = 'closed';
    saveTicket(ticket);
    await sendMessage(`🔒 Tiket <code>#${ticket.id}</code> (${ticket.name}) ditutup.`);
    return;
  }

  if (text === '/list' || text === '/pending') {
    const pins = readPins().map(String);
    const claims = readClaims();
    let pending = readLogs().filter(l => l.status === 'pending');
    if (!pending.length) { await sendMessage('Tidak ada request yang pending. 🎉'); return; }
    pending = [...pending].sort((a, b) => (pins.includes(String(b.id)) ? 1 : 0) - (pins.includes(String(a.id)) ? 1 : 0));
    const lines = pending.slice(0, 20).map(l => {
      const pin = pins.includes(String(l.id)) ? '📌 ' : '';
      const claim = claims[String(l.id)] ? ` 🙋${claims[String(l.id)].name}` : '';
      return `${pin}<code>#${l.id}</code> [${l.type === 'song' ? '🎵' : '🖼️'}] ${l.requester}${l.title ? ' — ' + l.title : ''}${claim}`;
    });
    await sendMessage(`<b>Request Pending (${pending.length})</b>\n\n${lines.join('\n')}`);
    return;
  }

  const accMatch = text.match(/^\/acc[_ ](\S+)$/i);
  if (accMatch) {
    const entry = await applyStatus(accMatch[1], 'approved', actorFrom(msg.from));
    await sendMessage(entry ? `✅ Request <code>#${accMatch[1]}</code> (${entry.requester}) disetujui.` : 'Request tidak ditemukan.');
    return;
  }
  const rejMatch = text.match(/^\/tolak[_ ](\S+)$/i);
  if (rejMatch) {
    const entry = await applyStatus(rejMatch[1], 'rejected', actorFrom(msg.from));
    await sendMessage(entry ? `❌ Request <code>#${rejMatch[1]}</code> (${entry.requester}) ditolak.` : 'Request tidak ditemukan.');
    return;
  }

  if (text === '/today') {
    const todayStr = new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long', year: 'numeric' });
    const todays = readLogs().filter(l => (l.time || '').includes(todayStr));
    if (!todays.length) { await sendMessage(`Belum ada request masuk hari ini (${todayStr}).`); return; }
    const lines = todays.slice(0, 25).map(l =>
      `<code>#${l.id}</code> [${l.type === 'song' ? '🎵' : '🖼️'}] ${l.requester}${l.title ? ' — ' + l.title : ''} — ${statusLabel[l.status]}`
    );
    await sendMessage(`<b>Request Hari Ini — ${todayStr} (${todays.length})</b>\n\n${lines.join('\n')}`);
    return;
  }

  if (text === '/queue') {
    const logs = readLogs();
    const songP = logs.filter(l => l.type === 'song' && l.status === 'pending').length;
    const banP  = logs.filter(l => l.type === 'banner' && l.status === 'pending').length;
    await sendMessage(
      `<b>📊 Ringkasan Antrian</b>\n\n` +
      `🎵 Lagu pending   : <b>${songP}</b>\n` +
      `🖼️ Banner pending : <b>${banP}</b>\n` +
      `📋 Total pending  : <b>${songP + banP}</b>\n\n` +
      `<i>/list untuk lihat detailnya.</i>`
    );
    return;
  }

  // ── Kontrol user APK (project "api") — dipanggil dari bot INI aja, gak ada bot kedua ──
  function apiHeaders() { return { 'Content-Type': 'application/json', 'x-admin-key': CFG.API_ADMIN_KEY }; }
  async function apiCall(method, path, body) {
    if (!CFG.API_ADMIN_KEY) {
      throw new Error('API_ADMIN_KEY belum diisi di config.js.');
    }
    // Router API sekarang jalan nempel di proses yang sama (di-mount di
    // server.js path /mobile-api), jadi cukup panggil localhost -- gak
    // butuh domain/URL eksternal apa pun buat komunikasi internal ini.
    const selfPort = process.env.SERVER_PORT || process.env.PORT || 3000;
    const r = await fetch(`http://localhost:${selfPort}/mobile-api${path}`, {
      method, headers: apiHeaders(),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000)
    });
    return r.json();
  }

  const apkAddMatch = text.match(/^\/apkadduser\s+(\S+)(?:\s+(\d+))?(?:\s+(member|vip|vvip|admin|owner|dev))?$/i);
  if (apkAddMatch) {
    try {
      const [, uname, days, role] = apkAddMatch;
      const d = await apiCall('POST', '/admin/users', { username: uname, days: days ? parseInt(days) : undefined, role });
      await sendMessageTo(chatId, d.success
        ? `✅ User APK <code>${uname}</code> dibuat. ${role ? `Role: ${role}.` : ''} ${days ? `Expired: ${d.user?.expiredDate}.` : 'Gak pernah expired.'}`
        : `⚠️ ${d.message || 'Gagal.'}`);
    } catch (e) { await sendMessageTo(chatId, `❌ ${e.message}`); }
    return;
  }

  const apkDelMatch = text.match(/^\/apkdeluser\s+(\S+)$/i);
  if (apkDelMatch) {
    try {
      const d = await apiCall('DELETE', `/admin/users/${encodeURIComponent(apkDelMatch[1])}`);
      await sendMessageTo(chatId, d.success ? `🗑️ User APK <code>${apkDelMatch[1]}</code> dihapus.` : `⚠️ ${d.message}`);
    } catch (e) { await sendMessageTo(chatId, `❌ ${e.message}`); }
    return;
  }

  const apkExtMatch = text.match(/^\/apkextend\s+(\S+)\s+(\d+)$/i);
  if (apkExtMatch) {
    try {
      const d = await apiCall('POST', `/admin/users/${encodeURIComponent(apkExtMatch[1])}/extend`, { days: parseInt(apkExtMatch[2]) });
      await sendMessageTo(chatId, d.success ? `✅ Expired <code>${apkExtMatch[1]}</code> jadi ${d.expiredDate}.` : `⚠️ ${d.message}`);
    } catch (e) { await sendMessageTo(chatId, `❌ ${e.message}`); }
    return;
  }

  if (text === '/apklist') {
    try {
      const d = await apiCall('GET', '/admin/users');
      if (!d.success || !d.users?.length) { await sendMessageTo(chatId, '📋 Belum ada user APK terdaftar.'); return; }
      const lines = d.users.map(u => `👤 <code>${u.username}</code> | ${u.role || 'member'} | ${u.expiredDate || '∞'}`).join('\n');
      await sendMessageTo(chatId, `<b>📋 User APK (${d.users.length})</b>\n\n${lines}`);
    } catch (e) { await sendMessageTo(chatId, `❌ ${e.message}`); }
    return;
  }

  const apkInfoMatch = text.match(/^\/apkinfo\s+(\S+)$/i);
  if (apkInfoMatch) {
    try {
      const d = await apiCall('GET', `/admin/users/${encodeURIComponent(apkInfoMatch[1])}`);
      if (!d.success) { await sendMessageTo(chatId, `⚠️ ${d.message}`); return; }
      await sendMessageTo(chatId,
        `<b>👤 ${d.user.username}</b>\n\n` +
        `Role     : ${d.user.role || 'member'}\n` +
        `Expired  : ${d.user.expiredDate || '∞'}\n` +
        `Status   : ${d.expired ? '⛔ Expired' : '✅ Aktif'}\n` +
        (d.session ? `Login terakhir: ${d.session.lastLogin?.slice(0,10) || '-'}` : 'Belum pernah login dari APK.')
      );
    } catch (e) { await sendMessageTo(chatId, `❌ ${e.message}`); }
    return;
  }

  const apkKickMatch = text.match(/^\/apkkick\s+(\S+)$/i);
  if (apkKickMatch) {
    try {
      const d = await apiCall('POST', `/admin/users/${encodeURIComponent(apkKickMatch[1])}/kick`);
      await sendMessageTo(chatId, d.success ? `✅ Session <code>${apkKickMatch[1]}</code> di-kick, harus login ulang.` : `⚠️ ${d.message}`);
    } catch (e) { await sendMessageTo(chatId, `❌ ${e.message}`); }
    return;
  }

  if (text === '/apkstats') {
    try {
      const d = await apiCall('GET', '/admin/stats');
      if (!d.success) { await sendMessageTo(chatId, '⚠️ Gagal ambil stats.'); return; }
      await sendMessageTo(chatId,
        `<b>📊 Bridge/APK Stats</b>\n\n` +
        `Total user    : ${d.totalUsers}\n` +
        `Session aktif : ${d.activeSessions}\n` +
        `Uptime API : ${d.uptime}s\n\n` +
        Object.entries(d.roles || {}).map(([r,n]) => `${r}: ${n}`).join('\n')
      );
    } catch (e) { await sendMessageTo(chatId, `❌ ${e.message}`); }
    return;
  }

  if (text === '/backupdb') {
    await sendMessageTo(chatId, '📦 Lagi nge-zip SELURUH folder database (semua data), tunggu bentar...');
    try {
      const { backupUserDb } = require('../lib/dbBackup');
      await backupUserDb();
    } catch (e) {
      console.error('[Backup DB Error]', e);
      await sendMessageTo(chatId, `❌ Gagal backup: ${e.message}`);
    }
    return;
  }

  // ── /setrole — set role + displayname + (opsional) durasi custom ───────────
  // Format (boleh pisah KOMA atau SPASI):
  //   /setrole usn,display,role[,durasi...]
  //   /setrole usn display role [durasi...]
  // Durasi cuma buat vip/vvip: angka + d (hari) / w (minggu) / m (bulan = 30 hari),
  // mis. 1d, 21w, 1m. Boleh digabung & dijumlahkan: 1m,2w,3d = 47 hari.
  // Tanpa durasi -> default 3 bulan (perilaku lama). Pakai KOMA kalau displayname
  // mau berisi spasi (mis. /setrole rahasia123,Bos Besar,vvip,1m).
  if (/^\/setrole(\s|$)/i.test(text)) {
    const { setRole, roleTitle, getDisplayName, parseDurationTokens, VALID_ROLES, ROLE_LIMITS, VVIP_DURATION_MS } = require('../lib/roles');
    const argStr = text.replace(/^\/setrole\s*/i, '').trim();
    const parts = (argStr.includes(',') ? argStr.split(',') : argStr.split(/\s+/)).map(p => p.trim()).filter(Boolean);

    const HELP =
      '<b>Format:</b>\n' +
      '<code>/setrole username,display,role</code>\n' +
      '<code>/setrole username,display,role,durasi</code>  (vip/vvip)\n\n' +
      '<b>role:</b> member | vip | vvip | admin | owner | dev\n' +
      '<b>display:</b> nama tampilan, atau <code>-</code> kalau tampil apa adanya\n' +
      '<b>durasi:</b> angka + <code>d</code> (hari) / <code>w</code> (minggu) / <code>m</code> (bulan = 30 hari)\n\n' +
      '<b>Contoh:</b>\n' +
      '<code>/setrole rahasia123,BosBesar,vvip,1m</code> → 1 bulan\n' +
      '<code>/setrole rahasia123,-,vip,21w</code> → 21 minggu\n' +
      '<code>/setrole rahasia123,-,vvip,1d</code> → 1 hari\n' +
      '<code>/setrole rahasia123,-,vvip,1m,2w,3d</code> → digabung = 47 hari\n' +
      '<code>/setrole nazriel,-,admin</code> → admin (tanpa durasi)\n\n' +
      'Tanpa durasi, vip/vvip berlaku 3 bulan. Durasi dihitung dari SEKARANG (set ulang = perpanjang/ganti masa aktif). Spasi juga boleh sebagai pemisah, tapi pakai koma kalau display berisi spasi.';

    if (parts.length < 3) {
      await sendMessageTo(chatId, '⚠️ Format salah. <code>/setrole</code> butuh minimal: username, display, role.\n\n' + HELP);
      return;
    }

    const [uname, displayRaw, roleRaw, ...rest] = parts;
    const role = roleRaw.toLowerCase();
    if (/\s/.test(uname)) { await sendMessageTo(chatId, '⚠️ Username login tidak boleh mengandung spasi.\n\n' + HELP); return; }
    if (!VALID_ROLES.includes(role)) {
      await sendMessageTo(chatId, `⚠️ Role "<code>${roleRaw}</code>" tidak dikenal. Pilih: member, vip, vvip, admin, owner, dev.\n\n` + HELP);
      return;
    }

    // Sisa parameter = durasi. (Angka panjang 8+ digit = format LAMA "nomor WA" --
    // tetap diterima biar kebiasaan lama gak error, tapi diabaikan.)
    let waIgnored = false;
    const durTokens = [];
    for (const t of rest) { if (/^\d{8,}$/.test(t)) waIgnored = true; else durTokens.push(t); }

    let durationMs = null, durationLabel = null;
    const isTimed = role === 'vip' || role === 'vvip';
    if (durTokens.length) {
      if (!isTimed) {
        await sendMessageTo(chatId, `⚠️ Durasi cuma berlaku buat role <b>vip</b>/<b>vvip</b>. Role <b>${role}</b> tidak punya masa berlaku — hapus parameter durasinya.\n\n` + HELP);
        return;
      }
      const p = parseDurationTokens(durTokens);
      if (!p.ok) { await sendMessageTo(chatId, `⚠️ ${p.error}\n\n` + HELP); return; }
      durationMs = p.ms;
      durationLabel = p.label === `${p.days} hari` ? p.label : `${p.label} (${p.days} hari)`;
    }

    // Displayname "-" atau sama persis kayak username -> gak usah disembunyiin,
    // tampilin username asli apa adanya.
    const displayName = (displayRaw === '-' || displayRaw.toLowerCase() === uname.toLowerCase()) ? null : displayRaw;
    const ok = setRole(uname, role, displayName, durationMs);
    const title = ok ? roleTitle(uname) : null;
    const shownAs = ok ? getDisplayName(uname) : null;

    if (!ok) { await sendMessageTo(chatId, '⚠️ Gagal set role.\n\n' + HELP); return; }

    let roleInfo;
    if (isTimed) {
      const lim = ROLE_LIMITS[role];
      const effMs = durationMs || VVIP_DURATION_MS;
      const until = new Date(Date.now() + effMs).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      roleInfo =
        `🌟 Limit ${lim.song}x lagu / ${lim.banner}x banner per hari, bebas sesi tertutup (limit-global) & app off. Tetep kena ban &amp; limitnya sendiri.\n` +
        `🔧 <b>Saat MAINTENANCE tetap kena</b> — tapi halaman "ID Saya" masih bisa dibuka.\n` +
        `⏳ <b>Berlaku ${durationLabel || '3 bulan (default)'}</b> — sampai ${until} WIB, lalu otomatis balik jadi member. Set ulang /setrole kapan aja buat perpanjang/ganti masa aktif.\n`;
    } else if (['admin', 'owner', 'dev'].includes(role)) {
      roleInfo = '👑 Full akses — bypass limit, ban, sesi tertutup, app off/maintenance. Hasil request tetap di-share ke saluran seperti biasa.\n';
    } else {
      roleInfo = 'Kembali ke limit &amp; aturan normal, titel juga ilang.\n';
    }

    await sendMessageTo(chatId,
      `✅ Role <code>${uname}</code> sekarang: <b>${role.toUpperCase()}</b>\n\n` + roleInfo +
      (title ? `\n<i>Titel "${title}" bakal muncul di bawah nama ${shownAs} (di app) dan di belakang nama pas kirim tiket ke admin.</i>` : '') +
      (displayName ? `\n🔒 <b>Nama login asli (<code>${uname}</code>) disembunyiin</b> — yang keliatan ke user lain/di tiket cuma "<b>${displayName}</b>", persis kayak WanzzGantengBanget ↔ wanzz.` : '') +
      (waIgnored ? '\n\nℹ️ Nomor WA diabaikan — ID privat VIP/VVIP sekarang cuma masuk ke halaman "ID Saya", gak dikirim ke WhatsApp lagi.' : '') +
      `\n\n📦 <i>Auto-backup database lagi dikirim nyusul...</i>`
    );

    const { autoBackupOnUserChange } = require('../lib/dbBackup');
    autoBackupOnUserChange(`role <code>${uname}</code> diubah jadi <b>${role.toUpperCase()}</b>${durationLabel ? ` (${durationLabel})` : ''}`);
    return;
  }

  // /autoupload on|off · /autoshare on|off · /autoall on|off · /autostatus
  //   autoupload = request baru langsung di-upload ke Roblox tanpa admin menekan "Upload ke Roblox"
  //   autoshare  = setelah upload sukses, hasil langsung dibagikan (VIP/VVIP -> "ID Saya", user biasa -> saluran WA)
  //   Izin (auto-grant permission) SELALU otomatis, bukan bagian dari mode ini.
  const autoMatch = text.match(/^\/(autoupload|autoshare|autoall|autostatus)(?:\s+(\S+))?$/i);
  if (autoMatch) {
    const { getAutoMode, setAutoMode } = require('../lib/autoMode');
    const cmd = autoMatch[1].toLowerCase();
    const arg = (autoMatch[2] || '').toLowerCase();
    const ON  = ['on', 'nyala', 'aktif', '1', 'hidup'];
    const OFF = ['off', 'mati', 'nonaktif', '0'];
    const flag = (v) => (v ? '🟢 ON' : '🔴 OFF');
    const renderStatus = (m) =>
      '⚙️ <b>Mode otomatis</b>\n\n' +
      `⬆️ Auto-upload : <b>${flag(m.upload)}</b>\n` +
      `📤 Auto-share  : <b>${flag(m.share)}</b>\n` +
      '🔓 Izin (auto-grant) : <b>🟢 SELALU otomatis</b>\n' +
      `📮 Kartu request   : <b>${require('../lib/telegram').groupCardChat() ? 'GRUP saja (tanpa chat pribadi)' : 'chat Owner + salinan admin'}</b>\n\n` +
      '<i>Auto-upload: request baru langsung di-upload ke Roblox tanpa menekan tombol. Saat ON, kartu request dikirim ke GRUP saja (tidak ke chat pribadi, jadi tidak ada kartu dobel).\n' +
      'Auto-share: begitu upload sukses & lolos moderasi, hasil langsung dibagikan (VIP/VVIP → ID Saya, user biasa → saluran WA).\n' +
      'OFF = manual pakai tombol seperti biasa.</i>\n\n' +
      'Perintah:\n<code>/autoupload on|off</code>\n<code>/autoshare on|off</code>\n<code>/autoall on|off</code> (dua-duanya)';

    if (cmd === 'autostatus' || !arg) {
      await sendMessageTo(chatId, renderStatus(getAutoMode()));
      return;
    }
    const value = ON.includes(arg) ? true : OFF.includes(arg) ? false : null;
    if (value === null) {
      await sendMessageTo(chatId, `⚠️ Pilihan "<code>${escapeHtml(arg)}</code>" tidak dikenal. Pakai <code>on</code> atau <code>off</code>.\n\nContoh: <code>/${cmd} on</code>`);
      return;
    }
    const patch = cmd === 'autoupload' ? { upload: value } : cmd === 'autoshare' ? { share: value } : { upload: value, share: value };
    const actorName = actorFrom(msg.from).name;
    const next = setAutoMode(patch, actorName);
    const note = [];
    if (value && (patch.upload !== undefined)) note.push('ℹ️ Auto-upload berlaku untuk request BARU setelah ini. Request yang sudah menunggu di kartu tetap diproses manual (tombol Upload).');
    if (value && patch.share !== undefined) note.push('ℹ️ Auto-share berlaku juga untuk upload yang sedang berjalan (dicek saat upload selesai).');
    await sendMessageTo(chatId, `✅ ${cmd === 'autoall' ? 'Auto-upload & auto-share' : cmd === 'autoupload' ? 'Auto-upload' : 'Auto-share'} sekarang <b>${flag(value)}</b>\n\n` + renderStatus(next) + (note.length ? '\n\n' + note.join('\n') : ''));
    return;
  }

  // /cekorder [username|trxId] — riwayat order pembelian VIP/VVIP + CEK LANGSUNG ke BuatQris.
  //   Order yang ternyata sudah dibayar tapi belum masuk akan langsung diaktifkan (pemulihan otomatis).
  // /aktifkanorder <trxId> — aktifkan paksa satu order (verifikasi manual admin, mis. bukti transfer valid).
  const cekOrderMatch = text.match(/^\/cekorder(?:\s+(\S+))?$/i);
  if (cekOrderMatch) {
    const shop = require('../lib/vvipShop');
    const vvip = require('../routes/vvip');
    const q = cekOrderMatch[1];
    let orders = q ? ((shop.findOrder(q) ? [shop.findOrder(q)] : shop.findOrdersByUsername(q, 8))) : shop.readOrders().slice(0, 8);
    if (!orders.length) { await sendMessageTo(chatId, q ? `Tidak ada order untuk "<code>${escapeHtml(q)}</code>".` : 'Belum ada order.'); return; }
    await sendMessageTo(chatId, '🔎 Mengecek langsung ke BuatQris...');
    let recovered = 0;
    for (const o of orders) {
      if (o.status === 'paid') continue;
      const after = await vvip.reconcileWithProvider(o, { ignoreCooldown: true, source: 'reconcile' });
      if (after && after.status === 'paid') recovered++;
    }
    orders = q ? (shop.findOrder(q) ? [shop.findOrder(q)] : shop.findOrdersByUsername(q, 8)) : shop.readOrders().slice(0, 8);
    const icon = { paid: '✅', pending: '⏳', cancelled: '⛔', expired: '⌛', failed: '❌' };
    const wib = (ms) => ms ? new Date(ms).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-';
    const lines = orders.map(o =>
      `${icon[o.status] || '•'} <b>${escapeHtml(o.username)}</b> — ${String(o.tier || 'vvip').toUpperCase()} ${o.days}h · Rp${Number(o.totalAmount || o.amount || 0).toLocaleString('id-ID')}\n` +
      `   ${o.status}${o.activation === 'failed' ? ' ⚠️ ROLE GAGAL DIAKTIFKAN' : ''} · dibuat ${wib(o.createdAt)}${o.paidAt ? ' · lunas ' + wib(o.paidAt) : ''}\n` +
      `   <code>${escapeHtml(o.transactionId)}</code>` + (o.activationNote ? `\n   <i>${escapeHtml(o.activationNote)}</i>` : ''));
    await sendMessageTo(chatId,
      `🧾 <b>Order pembelian</b>${q ? ` — ${escapeHtml(q)}` : ' (8 terbaru)'}\n\n` + lines.join('\n\n') +
      (recovered ? `\n\n♻️ <b>${recovered} pembayaran yang telat masuk berhasil diaktifkan.</b>` : '') +
      '\n\n<i>Aktifkan paksa: /aktifkanorder &lt;trxId&gt;</i>');
    return;
  }

  const aktifMatch = text.match(/^\/aktifkanorder\s+(\S+)$/i);
  if (aktifMatch) {
    const shop = require('../lib/vvipShop');
    const vvip = require('../routes/vvip');
    const o = shop.findOrder(aktifMatch[1]);
    if (!o) { await sendMessageTo(chatId, `Order <code>${escapeHtml(aktifMatch[1])}</code> tidak ditemukan.`); return; }
    const res = vvip.activateVvipOrder(o, { isTest: false, source: 'manual', manual: true });
    await sendMessageTo(chatId, res.already ? `ℹ️ Order ini sudah aktif sebelumnya (username <code>${escapeHtml(o.username)}</code>).` : res.ok ? `✅ Order diaktifkan untuk <code>${escapeHtml(o.username)}</code> (${String(o.tier).toUpperCase()} ${o.days} hari).` : `❌ Gagal mengaktifkan: ${escapeHtml(res.reason || 'sedang diproses')}`);
    return;
  }

  // /disk — pemakaian penyimpanan server: folder mana yang paling besar & sisa ruang.
  // /cleartmp — bersihin file sementara sekarang juga (cache YouTube + sisa file lama).
  if (text === '/disk' || text === '/cleartmp') {
    const td = require('../lib/tempdir');
    const MB = 1024 * 1024;
    const fmt = (b) => b >= 1024 * MB ? (b / 1024 / MB).toFixed(2) + ' GB' : (b / MB).toFixed(1) + ' MB';
    let head = '';
    if (text === '/cleartmp') {
      const r = td.emergencyClean(0);   // bersihin SEMUA file sementara yang tidak sedang dipakai
      const up = td.pruneUploadsOrphans(10 * 60 * 1000);
      head = `🧹 <b>Dibersihkan:</b> ${fmt(r.freed + up.freed)} dibebaskan (${r.files + up.files} file). File yang barusan dipakai (<2 menit) & video yang masih menunggu diproses tidak disentuh.\n\n`;
    }
    const rep = td.report();
    const used = rep.parts.find(p => p[0].startsWith('tmp/'))[1];
    const upl = rep.parts.find(p => p[0].startsWith('uploads/'))[1];
    const bar = (v, max) => { const n = Math.min(10, Math.round((v / max) * 10)); return '█'.repeat(n) + '░'.repeat(10 - n); };
    await sendMessageTo(chatId,
      head + '💾 <b>Penyimpanan server</b>\n\n' +
      rep.parts.map(([name, b]) => `• ${name}: <b>${fmt(b)}</b>`).join('\n') + '\n\n' +
      `tmp/ ${bar(used, rep.tmpMax)} ${fmt(used)} / ${fmt(rep.tmpMax)}\n` +
      `uploads/ ${bar(upl, rep.uploadsMax)} ${fmt(upl)} / ${fmt(rep.uploadsMax)}\n` +
      (rep.free != null ? `\nSisa ruang disk di volume: <b>${fmt(rep.free)}</b>\n` : '') +
      '\n<i>File sementara sekarang ada di folder tmp/ (disk server), bukan /tmp yang isinya di RAM. Dibersihkan otomatis tiap 10 menit; /cleartmp buat bersihin sekarang.</i>');
    return;
  }

  // /ytstatus — kondisi provider download YouTube (rekam jejak sejak server nyala):
  // siapa yang lagi cooldown, berapa kali sukses/gagal, rata-rata kecepatan.
  if (text === '/ytstatus') {
    const { getYtProviderStatus, getYtProviderMode } = require('../lib/audio');
    const mode = getYtProviderMode();
    const fmt = (p) => {
      const state = p.cooldownSec > 0 ? `😴 istirahat ${p.cooldownSec}s` : (p.streak >= 1 ? `⚠️ gagal ${p.streak}x berturut` : (p.ok || p.fail ? '✅ sehat' : '⚪ belum dipakai'));
      return `• <b>${p.name}</b> — ${state}\n   ✔ ${p.ok} · ✖ ${p.fail}` + (p.latencyMs ? ` · ⏱ ${(p.latencyMs / 1000).toFixed(1)} dtk` : '') + (p.lastError ? `\n   <i>${escapeHtml(p.lastError.split('\n')[0].slice(0, 90))}</i>` : '');
    };
    const rows = getYtProviderStatus();
    const utama = rows.filter(r => r.tier === 'utama').map(fmt);
    const cadangan = rows.filter(r => r.tier === 'cadangan').sort((a, b) => (a.cooldownSec > 0) - (b.cooldownSec > 0) || b.ok - a.ok).map(fmt);
    await sendMessageTo(chatId,
      '📡 <b>Status provider download YouTube</b>\n<i>(dihitung sejak server terakhir nyala)</i>\n\n' +
      (utama.length ? '<b>🥇 UTAMA</b> (selalu dicoba duluan)\n' + utama.join('\n\n') + '\n\n' : '') +
      (cadangan.length ? `<b>🛟 CADANGAN</b> (dipanggil saat utama gagal)\n` + cadangan.join('\n\n') : '<i>Tanpa cadangan.</i>') +
      (mode.disabled.length ? `\n\n<i>${mode.disabled.length} provider dinonaktifkan (atur di config.js → YT_FALLBACK_PROVIDERS).</i>` : ''));
    return;
  }

  // /setwa DIHAPUS: ID privat VIP/VVIP sekarang cuma lewat halaman "ID Saya"
  // (lihat lib/privateInbox.js), gak dikirim ke DM WA pribadi lagi. Command-nya
  // tetap dikenali biar admin yang masih kebiasaan gak bingung bot diem aja.
  if (/^\/setwa(\s|$)/i.test(text)) {
    await sendMessageTo(chatId,
      'ℹ️ <b>/setwa sudah tidak dipakai.</b>\n\n' +
      'ID privat VIP/VVIP sekarang otomatis masuk ke halaman <b>"ID Saya"</b> (web/app) dan <b>tidak dikirim ke WhatsApp lagi</b> — jadi gak perlu daftar nomor WA.'
    );
    return;
  }

  if (text === '/listroles') {
    const { listRoles, getDisplayName, getVvipDaysLeft } = require('../lib/roles');
    const roles = listRoles();
    const entries = Object.entries(roles);
    if (!entries.length) {
      await sendMessageTo(chatId, '📋 Belum ada user dengan role khusus (semua masih "member").');
      return;
    }
    // Dulu daftar ini HANYA menampilkan owner/dev/admin/VVIP -- user VIP tidak muncul sama sekali
    // (padahal tersimpan di titel.json & ikut backup). Sekarang VIP tampil juga, lengkap dgn sisa hari.
    function fmt(u, timed) {
      const shown = getDisplayName(u);
      const base = shown !== u ? `${u} → <b>${shown}</b>` : u;
      if (timed) {
        const d = getVvipDaysLeft(u);
        return d !== null ? `${base} (${d}h)` : base;
      }
      return base;
    }
    const grouped = { owner: [], dev: [], admin: [], vvip: [], vip: [] };
    for (const [u, r] of entries) if (grouped[r]) grouped[r].push(fmt(u, r === 'vvip' || r === 'vip'));
    const sections = [
      `👑 Owner (${grouped.owner.length}): ${grouped.owner.join(', ') || '-'}`,
      `🧑‍💻 Dev (${grouped.dev.length}): ${grouped.dev.join(', ') || '-'}`,
      `🛡️ Admin (${grouped.admin.length}): ${grouped.admin.join(', ') || '-'}`,
      `🌟 VVIP (${grouped.vvip.length}): ${grouped.vvip.join(', ') || '-'}`,
      `💎 VIP (${grouped.vip.length}): ${grouped.vip.join(', ') || '-'}`,
    ];
    const footer =
      `<i>Format "username → nama tampilan" kalau displayname-nya disembunyiin. Angka (Nh) = sisa hari VIP/VVIP.</i>\n` +
      `<i>/setrole username,display,role[,durasi] buat ubah (role: member|vip|vvip|admin|owner|dev).</i>`;
    // Batas Telegram 4096 karakter/pesan -- pecah kalau daftarnya panjang (VVIP+VIP bisa puluhan nama).
    const pages = []; let cur = '<b>📋 Daftar Role Khusus</b>\n';
    for (const sec of sections) {
      if ((cur + '\n' + sec).length > 3600) { pages.push(cur); cur = ''; }
      cur += '\n' + sec;
    }
    pages.push(cur);
    for (let i = 0; i < pages.length; i++) await sendMessageTo(chatId, pages[i] + (i === pages.length - 1 ? '\n\n' + footer : ''));
    return;
  }

  const checkRoleMatch = text.match(/^\/checkrole\s+(\S+)$/i);
  if (checkRoleMatch) {
    const { getRole, getDisplayName, getVvipDaysLeft } = require('../lib/roles');
    const role = getRole(checkRoleMatch[1]);
    const shown = getDisplayName(checkRoleMatch[1]);
    const daysLeft = getVvipDaysLeft(checkRoleMatch[1]);
    await sendMessageTo(chatId,
      `👤 <code>${checkRoleMatch[1]}</code> role-nya: <b>${role.toUpperCase()}</b>` +
      (shown !== checkRoleMatch[1] ? `\n🔒 Tampil ke publik sebagai: <b>${shown}</b>` : '') +
      (daysLeft !== null ? `\n⏳ Sisa masa VIP: <b>${daysLeft} hari</b>` : '')
    );
    return;
  }

  if (text === '/limitstats') {
    const rates = readRates();
    const { readSongSession } = require('../lib/songSchedule');
    const { isVvip, isPremium, roleLimit, VVIP_RESET_MS } = require('../lib/roles');
    const session = readSongSession();

    let songFull = 0, bannerFull = 0, totalTracked = 0;
    const songLimit   = RATE_LIMITS.song;
    const bannerLimit = RATE_LIMITS.banner;

    for (const key of Object.keys(rates)) {
      if (!key.startsWith('u:')) continue; // skip entri berbasis IP (bukan username)
      totalTracked++;
      const uname  = key.slice(2);
      const bucket = rates[key];
      const vip = isPremium(uname);
      const cutoff = Date.now() - VVIP_RESET_MS;
      const songHits   = vip ? (bucket.song   || []).filter(t => t > cutoff).length : (bucket.song   || []).length;
      const bannerHits = vip ? (bucket.banner || []).filter(t => t > cutoff).length : (bucket.banner || []).length;
      const sLimit = vip ? roleLimit(uname, 'song')   : (songLimit   + getBonus(uname, 'song'));
      const bLimit = vip ? roleLimit(uname, 'banner') : (bannerLimit + getBonus(uname, 'banner'));
      if (songHits   >= sLimit) songFull++;
      if (bannerHits >= bLimit) bannerFull++;
    }

    function sessionLine(type, label) {
      const t = session[type];
      if (!t || !t.active) return `${label} : 🔴 Sesi TERTUTUP (bukan limit personal yang jadi masalah, tapi sesi belum/tidak dibuka)`;
      if (t.quota == null) return `${label} : 🟢 Aktif (kuota global unlimited)`;
      return `${label} : 🟢 Aktif — kuota global ${t.count}/${t.quota}`;
    }

    await sendMessageTo(chatId,
      `<b>📊 Statistik Limit Personal</b>\n\n` +
      `👤 User tercatat       : <b>${totalTracked}</b>\n` +
      `🎵 Limit lagu habis    : <b>${songFull}</b> user (dari limit ${songLimit}x)\n` +
      `🖼️ Limit banner habis  : <b>${bannerFull}</b> user (dari limit ${bannerLimit}x)\n\n` +
      `<b>Status sesi saat ini:</b>\n` +
      sessionLine('song', '🎵 Lagu  ') + `\n` +
      sessionLine('banner', '🖼️ Banner') + `\n\n` +
      `<i>Ketik /resetalllimit buat reset limit personal semua user secara manual kapan aja.</i>`
    );
    return;
  }

  const detailMatch = text.match(/^\/detail[_ ](\S+)$/i);
  if (detailMatch) {
    const entry = findEntry(detailMatch[1]);
    if (!entry) { await sendMessage('Request tidak ditemukan.'); return; }
    const claim = getClaim(entry.id);
    await sendMessage(
      `<b>🔎 Detail Request</b>  <code>#${entry.id}</code>\n\n` +
      `Tipe      : ${entry.type === 'song' ? '🎵 Lagu' : '🖼️ Banner'}\n` +
      `Dari      : ${entry.requester}\n` +
      (entry.username ? `Username  : ${entry.username}\n` : '') +
      (entry.title ? `Judul     : ${entry.title}\n` : '') +
      (entry.link ? `Link      : ${entry.link}\n` : '') +
      `Status    : ${statusLabel[entry.status]}\n` +
      `Waktu     : ${entry.time}\n` +
      (isPinned(entry.id) ? `📌 Dipin\n` : '') +
      (entry.reminded ? `⏰ Sudah di-remind\n` : '') +
      (entry.note ? `Catatan   : ${entry.note}\n` : '') +
      (claim ? `Diklaim   : ${claim.name} (${claim.time})\n` : '') +
      (entry.lastActionBy ? `Diproses oleh : ${entry.lastActionBy.name}\n` : '')
    );
    return;
  }

  const claimMatch = text.match(/^\/claim[_ ](\S+)$/i);
  if (claimMatch) {
    const entry = findEntry(claimMatch[1]);
    if (!entry) { await sendMessage('Request tidak ditemukan.'); return; }
    const existing = getClaim(entry.id);
    if (existing) { await sendMessage(`⚠️ Request <code>#${entry.id}</code> sudah diklaim oleh <b>${existing.name}</b>.`); return; }
    setClaim(entry.id, actorFrom(msg.from));
    await sendMessage(`🙋 Request <code>#${entry.id}</code> (${entry.requester}) sekarang diklaim oleh <b>${actorFrom(msg.from).name}</b>.`);
    return;
  }

  const unclaimMatch = text.match(/^\/unclaim[_ ](\S+)$/i);
  if (unclaimMatch) {
    const id = unclaimMatch[1];
    if (!getClaim(id)) { await sendMessage('Request itu tidak sedang diklaim siapa-siapa.'); return; }
    removeClaim(id);
    await sendMessage(`🔓 Klaim request <code>#${id}</code> sudah dilepas.`);
    return;
  }

  if (text === '/myclaims') {
    const me = actorFrom(msg.from);
    const claims = readClaims();
    const mine = Object.entries(claims).filter(([, c]) => String(c.id) === me.id);
    if (!mine.length) { await sendMessage('Kamu belum klaim request apapun.'); return; }
    const lines = mine.map(([id, c]) => {
      const e = findEntry(id);
      return `<code>#${id}</code> — ${e ? e.requester + (e.title ? ' — ' + e.title : '') : '(log terhapus)'} <i>(${c.time})</i>`;
    });
    await sendMessage(`<b>🙋 Klaim Aktif Kamu (${mine.length})</b>\n\n${lines.join('\n')}`);
    return;
  }

  const whoclaimMatch = text.match(/^\/whoclaim[_ ](\S+)$/i);
  if (whoclaimMatch) {
    const c = getClaim(whoclaimMatch[1]);
    await sendMessage(c ? `Request <code>#${whoclaimMatch[1]}</code> diklaim oleh <b>${c.name}</b> sejak ${c.time}.` : `Request <code>#${whoclaimMatch[1]}</code> belum diklaim siapapun.`);
    return;
  }

  const reopenMatch = text.match(/^\/(?:reopen|pending)[_ ](\S+)$/i);
  if (reopenMatch) {
    const entry = await applyStatus(reopenMatch[1], 'pending', actorFrom(msg.from));
    await sendMessage(entry ? `⏳ Request <code>#${reopenMatch[1]}</code> (${entry.requester}) dikembalikan ke Pending — tombol ACC/Tolak muncul lagi.` : 'Request tidak ditemukan.');
    return;
  }

  const pinMatch = text.match(/^\/pin[_ ](\S+)$/i);
  if (pinMatch) {
    const entry = findEntry(pinMatch[1]);
    if (!entry) { await sendMessage('Request tidak ditemukan.'); return; }
    const pins = readPins();
    if (!pins.map(String).includes(String(pinMatch[1]))) { pins.push(String(pinMatch[1])); savePins(pins); }
    await sendMessage(`📌 Request <code>#${pinMatch[1]}</code> (${entry.requester}) sudah dipin.`);
    return;
  }

  const unpinMatch = text.match(/^\/unpin[_ ](\S+)$/i);
  if (unpinMatch) {
    const pins = readPins().filter(p => String(p) !== String(unpinMatch[1]));
    savePins(pins);
    await sendMessage(`📌 Pin request <code>#${unpinMatch[1]}</code> dilepas.`);
    return;
  }

  if (text === '/pinned') {
    const pins = readPins();
    if (!pins.length) { await sendMessage('Belum ada request yang dipin.'); return; }
    const lines = pins.map(id => {
      const e = findEntry(id);
      return `📌 <code>#${id}</code> — ${e ? e.requester + (e.title ? ' — ' + e.title : '') + ' — ' + statusLabel[e.status] : '(log terhapus)'}`;
    });
    await sendMessage(`<b>📌 Request Dipin (${pins.length})</b>\n\n${lines.join('\n')}`);
    return;
  }

  if (text === '/lastacc') {
    const acc = readLogs().filter(l => l.status === 'approved').slice(0, 5);
    if (!acc.length) { await sendMessage('Belum ada request yang di-ACC.'); return; }
    const lines = acc.map(l => `<code>#${l.id}</code> — ${l.requester}${l.title ? ' — ' + l.title : ''} <i>(oleh ${l.lastActionBy?.name || '?'})</i>`);
    await sendMessage(`<b>✅ 5 Terakhir Di-ACC</b>\n\n${lines.join('\n')}`);
    return;
  }

  if (text === '/lasttolak') {
    const rej = readLogs().filter(l => l.status === 'rejected').slice(0, 5);
    if (!rej.length) { await sendMessage('Belum ada request yang ditolak.'); return; }
    const lines = rej.map(l => `<code>#${l.id}</code> — ${l.requester}${l.title ? ' — ' + l.title : ''} <i>(oleh ${l.lastActionBy?.name || '?'})</i>`);
    await sendMessage(`<b>❌ 5 Terakhir Ditolak</b>\n\n${lines.join('\n')}`);
    return;
  }

  if (text === '/myinfo') {
    const me = actorFrom(msg.from);
    const logs = readLogs();
    const accCount = logs.filter(l => l.lastActionBy?.id === me.id && l.status === 'approved').length;
    const rejCount = logs.filter(l => l.lastActionBy?.id === me.id && l.status === 'rejected').length;
    const claimCount = Object.values(readClaims()).filter(c => c.id === me.id).length;
    await sendMessage(
      `<b>👤 Info Kamu</b>\n\n` +
      `Nama       : ${me.name}\n` +
      `Telegram ID: <code>${me.id}</code>\n` +
      `Role       : ${isOwner(me.id) ? '👑 Owner' : '🛠️ Sub-admin'}\n\n` +
      `✅ Total ACC   : ${accCount}\n` +
      `❌ Total Tolak : ${rejCount}\n` +
      `🙋 Klaim aktif : ${claimCount}`
    );
    return;
  }

  const finduserMatch = text.match(/^\/finduser[_ ](\S+)$/i);
  if (finduserMatch) {
    const uname = finduserMatch[1].replace(/^@/, '').toLowerCase();
    const found = readLogs().filter(l => (l.username || '').toLowerCase() === uname || (l.requester || '').toLowerCase() === uname);
    if (!found.length) { await sendMessage(`Tidak ada request dari "${finduserMatch[1]}".`); return; }
    const lines = found.slice(0, 20).map(l => `<code>#${l.id}</code> [${l.type === 'song' ? '🎵' : '🖼️'}] ${l.title || '-'} — ${statusLabel[l.status]}`);
    await sendMessage(`<b>Request dari "${finduserMatch[1]}" (${found.length})</b>\n\n${lines.join('\n')}`);
    return;
  }

  if (text === '/unreadtickets') {
    const open = readTickets().filter(t => t.status !== 'closed');
    const unread = open.filter(t => !t.messages.some(m => m.from === 'admin'));
    if (!unread.length) { await sendMessage('Semua tiket terbuka sudah pernah dibalas. 🎉'); return; }
    const lines = unread.map(t => `<code>#${t.id}</code> — ${t.name}${t.username ? ' (@' + t.username + ')' : ''}`);
    await sendMessage(`<b>📭 Tiket Belum Dibalas (${unread.length})</b>\n\n${lines.join('\n')}\n\n<i>Reply pesan tiket aslinya untuk membalas.</i>`);
    return;
  }

  if (text === '/lastticket') {
    const tickets = readTickets();
    if (!tickets.length) { await sendMessage('Belum ada tiket sama sekali.'); return; }
    const t = tickets[tickets.length - 1];
    const last = t.messages[t.messages.length - 1];
    await sendMessage(
      `<b>🎫 Tiket Terbaru</b>  <code>#${t.id}</code>\n\n` +
      `Nama   : ${t.name}${t.username ? ' (@' + t.username + ')' : ''}\n` +
      `Status : ${t.status}\n\n` +
      `<i>"${(last?.text || '').slice(0, 200)}"</i>`
    );
    return;
  }

  const remindMatch = text.match(/^\/remind[_ ](\S+)$/i);
  if (remindMatch) {
    const logs = readLogs();
    const entry = logs.find(l => String(l.id) === String(remindMatch[1]));
    if (!entry) { await sendMessage('Request tidak ditemukan.'); return; }
    entry.reminded = true;
    entry.remindedAt = getTime();
    saveLogs(logs);
    await sendMessage(`⏰ Request <code>#${entry.id}</code> (${entry.requester}) ditandai sudah di-remind pada ${entry.remindedAt}.`);
    return;
  }

  const cancelMatch = text.match(/^\/cancel[_ ](\S+)\s*(.*)$/i);
  if (cancelMatch) {
    const [, id, reason] = cancelMatch;
    const logs = readLogs();
    const entry = logs.find(l => String(l.id) === String(id));
    if (!entry) { await sendMessage('Request tidak ditemukan.'); return; }
    entry.note = (reason || 'Dibatalkan oleh admin').trim();
    saveLogs(logs);
    await applyStatus(id, 'rejected', actorFrom(msg.from));
    await sendMessage(`🚫 Request <code>#${id}</code> (${entry.requester}) dibatalkan.${reason ? '\nAlasan: ' + reason.trim() : ''}`);
    return;
  }

  if (text === '/shortcuts') {
    await sendMessage(
      `<b>⚡ Shortcut Command</b>\n\n` +
      `<code>/a</code> &lt;id&gt;  = <code>/acc</code> &lt;id&gt;\n` +
      `<code>/t</code> &lt;id&gt;  = <code>/tolak</code> &lt;id&gt;\n` +
      `<code>/r</code> &lt;id&gt;  = <code>/reopen</code> &lt;id&gt;\n\n` +
      `<i>Cuma versi pendek, fungsinya identik dengan command aslinya.</i>`
    );
    return;
  }
  const shortAccMatch = text.match(/^\/a[_ ](\S+)$/i);
  if (shortAccMatch) {
    const entry = await applyStatus(shortAccMatch[1], 'approved', actorFrom(msg.from));
    await sendMessage(entry ? `✅ Request <code>#${shortAccMatch[1]}</code> (${entry.requester}) disetujui.` : 'Request tidak ditemukan.');
    return;
  }
  const shortRejMatch = text.match(/^\/t[_ ](\S+)$/i);
  if (shortRejMatch) {
    const entry = await applyStatus(shortRejMatch[1], 'rejected', actorFrom(msg.from));
    await sendMessage(entry ? `❌ Request <code>#${shortRejMatch[1]}</code> (${entry.requester}) ditolak.` : 'Request tidak ditemukan.');
    return;
  }
  const shortReopenMatch = text.match(/^\/r[_ ](\S+)$/i);
  if (shortReopenMatch) {
    const entry = await applyStatus(shortReopenMatch[1], 'pending', actorFrom(msg.from));
    await sendMessage(entry ? `⏳ Request <code>#${shortReopenMatch[1]}</code> (${entry.requester}) dikembalikan ke Pending.` : 'Request tidak ditemukan.');
    return;
  }

  if (text.startsWith('/appoff')) {
    const parts = text.split(' ').slice(1).join(' ').trim();
    writeAppStatus({ mode: 'offline', message: parts || 'App sementara dimatikan oleh admin.' });
    await sendMessageTo(chatId, '🔴 <b>App dimatikan.</b>\nUser akan melihat halaman offline.\n\nKetik <code>/appon</code> untuk menghidupkan kembali.');
    return;
  }

  if (text.startsWith('/maintenance') || text.startsWith('/app maintenance')) {
    const parts = text.replace(/^\/app maintenance|^\/maintenance/, '').trim();
    writeAppStatus({ mode: 'maintenance', message: parts || 'Kami sedang melakukan pembaruan. Mohon tunggu.' });
    await sendMessageTo(chatId, '🔧 <b>Mode Maintenance aktif.</b>\nSemua user (termasuk VIP/VVIP) akan melihat halaman maintenance dan tidak bisa request. VIP/VVIP tetap bisa membuka halaman <b>ID Saya</b>. Admin/owner/dev tidak terpengaruh.\n\nKetik <code>/appon</code> untuk menghidupkan kembali.');
    return;
  }

  if (text === '/appon' || text === '/app on' || text === '/online') {
    writeAppStatus({ mode: 'online', message: '' });
    await sendMessageTo(chatId, '🟢 <b>App kembali online!</b>\nUser sudah bisa mengakses panel.');
    return;
  }

  if (text === '/appstatus') {
    const s = readAppStatus();
    const icon = s.mode === 'online' ? '🟢' : s.mode === 'maintenance' ? '🔧' : '🔴';
    await sendMessageTo(chatId, `${icon} <b>Status App:</b> <code>${s.mode}</code>\n${s.message ? '<i>' + s.message + '</i>' : ''}`);
    return;
  }

  const addLimitMatch = text.match(/^\/addlimit\s+(\S+)\s+(song|banner)\s+(\d+)$/i);
  if (addLimitMatch) {
    const [, uname, type, amountStr] = addLimitMatch;
    const amount = parseInt(amountStr, 10);
    const total = addBonus(uname, type.toLowerCase(), amount);
    await sendMessageTo(chatId, `✅ Bonus limit <b>${type}</b> untuk <code>${uname}</code> ditambah <b>+${amount}</b>.\nTotal bonus sekarang: <b>${total}</b> (di atas limit normal ${RATE_LIMITS[type.toLowerCase()]}).`);
    return;
  }

  const resetLimitMatch = text.match(/^\/resetlimit\s+(\S+)$/i);
  if (resetLimitMatch) {
    resetUserRate(resetLimitMatch[1]);
    await sendMessageTo(chatId, `🔄 Limit pemakaian untuk <code>${resetLimitMatch[1]}</code> sudah direset. Kuota mereka kembali penuh.`);
    return;
  }

  const setLimitMatch = text.match(/^\/setlimit\s+(song|banner)\s+(\d+)$/i);
  if (setLimitMatch) {
    const [, type, amountStr] = setLimitMatch;
    RATE_LIMITS[type.toLowerCase()] = parseInt(amountStr, 10);
    saveLimitsConfig();
    await sendMessageTo(chatId, `⚙️ Limit default <b>${type}</b> sekarang: <b>${RATE_LIMITS[type.toLowerCase()]}x</b> (berlaku untuk semua user, reset saat sesi request dibuka lagi).`);
    return;
  }

  const setMaxQueueMatch = text.match(/^\/setmaxqueue\s+(\d+)$/i);
  if (setMaxQueueMatch) {
    const n = parseInt(setMaxQueueMatch[1], 10);
    setMaxQueue(n);
    const pending = readLogs().filter(l => l.status === 'pending').length;
    if (n === 0) {
      await sendMessageTo(chatId, `✅ Batas antrian <b>dinonaktifkan</b>. Request akan diterima tanpa batas jumlah antrian.`);
    } else {
      await sendMessageTo(chatId,
        `✅ Batas antrian diatur ke <b>${n} request pending</b>.\n\n` +
        `Antrian saat ini: <b>${pending}/${n}</b>\n` +
        `${pending >= n ? '⚠️ Antrian sudah penuh! Request baru akan ditolak.' : '🟢 Masih bisa menerima request.'}`
      );
    }
    return;
  }

  const setLimitResetMatch = text.match(/^\/setlimitreset\s+(\d+)(?:,(\d+))?$/i);
  if (setLimitResetMatch) {
    const hours   = parseInt(setLimitResetMatch[1], 10);
    const minutes = setLimitResetMatch[2] !== undefined ? parseInt(setLimitResetMatch[2], 10) : 0;

    if (hours === 0 && minutes === 0) {
      await sendMessageTo(chatId, '❌ Durasi tidak boleh 0. Minimal 1 menit.\n\nContoh:\n<code>/setlimitreset 1</code> → 1 jam\n<code>/setlimitreset 1,30</code> → 1 jam 30 menit\n<code>/setlimitreset 0,30</code> → 30 menit');
      return;
    }
    if (minutes >= 60) {
      await sendMessageTo(chatId, `❌ Menit tidak boleh lebih dari 59. Gunakan format: <code>/setlimitreset ${hours + Math.floor(minutes / 60)},${minutes % 60}</code>`);
      return;
    }

    const ms = (hours * 60 + minutes) * 60 * 1000;
    setWindow(ms);
    await sendMessageTo(chatId,
      `⚠️ <b>Catatan:</b> sejak update terbaru, limit user <b>tidak lagi reset otomatis berdasarkan waktu</b>. ` +
      `Nilai ${fmtWindow(ms)} ini disimpan tapi tidak dipakai untuk auto-reset lagi.\n\n` +
      `Limit sekarang cuma reset saat:\n` +
      `• Sesi request global dibuka lagi (otomatis untuk SEMUA user)\n` +
      `• Admin pakai /resetlimit <username> atau /resetalllimit\n\n` +
      `Limit saat ini:\n` +
      `🎵 Lagu   : ${RATE_LIMITS.song}x\n` +
      `🖼️ Banner : ${RATE_LIMITS.banner}x`
    );
    return;
  }

  const addwaMatch = text.match(/^\/addwa\s+(\S+)$/i);
  if (addwaMatch) {
    const phone = addwaMatch[1];
    const { requestPairingCode, isRegistered } = require('../lib/whatsapp');
    if (isRegistered()) {
      await sendMessageTo(chatId, '✅ WhatsApp udah login. Kalau mau ganti akun, hapus folder <code>wa_auth/</code> di server, restart server, baru <code>/addwa</code> lagi.');
      return;
    }
    await sendMessageTo(chatId, '⏳ Lagi nyambung ke WhatsApp & minta kode pairing (~5 detik)...');
    try {
      const code = await requestPairingCode(phone);
      await sendMessageTo(chatId,
        `🔗 <b>Kode Pairing WhatsApp</b>\n\n` +
        `<code>${code}</code>\n\n` +
        `Caranya:\n` +
        `1. Buka WhatsApp di HP (pakai akun owner/admin saluran)\n` +
        `2. Pengaturan → Perangkat Tertaut → Tautkan Perangkat\n` +
        `3. Pilih <b>"Tautkan dengan nomor telepon"</b>\n` +
        `4. Masukkan kode di atas\n\n` +
        `<i>Sistem bakal terus nyambung ulang otomatis selama 5 menit ke depan buat nunggu kode ini dimasukin — jadi santai aja, gak perlu buru-buru. Kalau lewat 5 menit belum dimasukin, ketik /addwa ${phone} lagi buat minta kode baru. Setelah kode dimasukin, kamu bakal dapat notif "WhatsApp berhasil terhubung" di sini kalau berhasil.</i>`
      );
    } catch (e) {
      await sendMessageTo(chatId, `❌ Gagal minta kode pairing: ${e.message}\n\nCoba ketik /addwa ${phone} lagi.`);
    }
    return;
  }

  const checkLimitMatch = text.match(/^\/checklimit\s+(\S+)$/i);
  if (checkLimitMatch) {
    const uname = checkLimitMatch[1];
    const rates = readRates();
    const bucket = rates['u:' + uname.toLowerCase()] || {};
    const lines = ['song', 'banner'].map(type => {
      const limit = RATE_LIMITS[type] + getBonus(uname, type);
      const used = (bucket[type] || []).length;
      return `${type === 'song' ? '🎵 Song' : '🖼️ Banner'}: ${used}/${limit} terpakai (sisa ${Math.max(0, limit - used)})`;
    });
    await sendMessageTo(chatId, `<b>Limit untuk ${uname}</b>\n\n${lines.join('\n')}\n\n<i>Reset otomatis saat sesi request dibuka lagi, atau pakai /resetlimit ${uname}.</i>`);
    return;
  }

  const banMatch = text.match(/^\/ban\s+(\S+)(?:\s+([\s\S]+))?$/i);
  if (banMatch) {
    const [, uname, reason] = banMatch;
    const bans = readBans();
    bans[uname.toLowerCase()] = { reason: reason?.trim() || 'Tidak disebutkan', bannedAt: getTime() };
    saveBans(bans);
    // Ikut ban SEMUA IP yang pernah kepakai username ini (lihat recordUserIp di
    // routes/api.js & routes/api-mobile.js) -- jadi ganti akun/username berapa kali
    // pun, selama masih dari perangkat/jaringan yang sama, tetap ketolak.
    const ips = getUserIps(uname);
    for (const ip of ips) banIp(ip, `Ikut ke-ban dari user "${uname}"`, uname);
    const ipNote = ips.length ? `\n🌐 ${ips.length} IP yang pernah dipakai user ini ikut diblokir (ganti akun tetap ketolak).` : '\n🌐 Belum ada IP tercatat buat user ini (baru ke-ban kalau dia request lagi).';
    await sendMessageTo(chatId, `🚫 User <code>${uname}</code> sudah diblokir dari fitur request.\nAlasan: ${reason?.trim() || '-'}${ipNote}`);
    return;
  }

  const unbanMatch = text.match(/^\/unban\s+(\S+)$/i);
  if (unbanMatch) {
    const bans = readBans();
    const uname = unbanMatch[1].toLowerCase();
    if (!bans[uname]) { await sendMessageTo(chatId, 'User itu tidak sedang diblokir.'); return; }
    delete bans[uname];
    saveBans(bans);
    // Kebalikan dari /ban: IP yang ikut ke-ban gara-gara user ini ikut dibuka lagi.
    const ips = getUserIps(uname);
    let ipUnbanned = 0;
    for (const ip of ips) { if (unbanIp(ip)) ipUnbanned++; }
    const ipNote = ipUnbanned ? `\n🌐 ${ipUnbanned} IP yang ikut diblokir dari user ini sudah dibuka lagi.` : '';
    await sendMessageTo(chatId, `✅ Blokir untuk <code>${unbanMatch[1]}</code> sudah dicabut.${ipNote}`);
    return;
  }

  if (text === '/banlist') {
    const bans = readBans();
    const keys = Object.keys(bans);
    if (!keys.length) { await sendMessageTo(chatId, 'Tidak ada user yang diblokir saat ini. ✅'); return; }
    const lines = keys.map(u => {
      const ipCount = getUserIps(u).filter(ip => isIpBanned(ip)).length;
      return `<code>${u}</code> — ${bans[u].reason} <i>(${bans[u].bannedAt})</i>${ipCount ? ` · 🌐${ipCount} IP` : ''}`;
    });
    await sendMessageTo(chatId, `<b>Daftar User Diblokir (${keys.length})</b>\n\n${lines.join('\n')}`);
    return;
  }

  const announceMatch = text.match(/^\/announce\s+([\s\S]+)$/i);
  if (announceMatch) {
    saveAnnounce({ message: announceMatch[1].trim(), setAt: getTime() });
    await sendMessageTo(chatId, `📢 Pengumuman dipasang di website:\n\n<i>"${announceMatch[1].trim()}"</i>\n\nKetik /clearannounce untuk menghapusnya.`);
    return;
  }

  if (text === '/clearannounce') {
    clearAnnounce();
    await sendMessageTo(chatId, '🧹 Pengumuman di website sudah dihapus.');
    return;
  }

  if (text === '/privatonly') {
    writeChatMode({ mode: 'private' });
    await sendMessageTo(chatId,
      '🔒 <b>Mode diubah ke Private Only.</b>\n\n' +
      'Sekarang semua command bot — termasuk /list, /acc, /tolak, /tickets, /mixing, dll — ' +
      'HANYA bisa dipakai lewat chat private dengan bot, tidak bisa dari grup.\n\n' +
      '📋 Request lagu/banner & tiket CS dari website juga BERHENTI dibroadcast ke grup khusus ' +
      `(<code>${activeGroupId()}</code>) — kembali cuma ke private/sub-admin saja.\n\n` +
      '<i>Kontrol app/website (owner only) memang dari awal selalu private, tidak terpengaruh mode ini.</i>'
    );
    return;
  }

  if (text === '/grouponly') {
    writeChatMode({ mode: 'group' });
    await sendMessageTo(chatId,
      '🔓 <b>Mode diubah ke Group Allowed.</b>\n\n' +
      'Command biasa (/list, /acc, /tolak, /pending, /tickets, /closetiket, /mixing, /uptime, /myid, /menu) ' +
      'sekarang bisa juga dipakai dari grup oleh owner/sub-admin.\n\n' +
      `📋 Mulai sekarang, <b>setiap request lagu &amp; banner, dan juga tiket CS dari website</b>, ` +
      `otomatis ikut dibroadcast ke grup khusus <code>${activeGroupId()}</code> — request lengkap dengan tombol ✅ ACC / ❌ Tolak / ⏳ Pending, dan tiket bisa langsung dibalas dengan reply di grup itu juga.\n\n` +
      '⚠️ <b>Kontrol app/website & seluruh command owner-only tetap WAJIB private chat</b> ' +
      '(appoff, maintenance, appon, offreq, onreq, announce, ban, setlimit, addadmin, dll) — tidak bisa dari grup apapun mode ini.\n\n' +
      '<i>Catatan: jika bot belum merespon command / tidak bisa kirim ke grup, pastikan bot sudah join grup tersebut, jadi admin grup (kalau perlu), dan matikan "Group Privacy" lewat @BotFather → /setprivacy → Disable.</i>'
    );
    return;
  }

  if (text === '/stats') {
    const logs = readLogs();
    const songs = logs.filter(l => l.type === 'song');
    const banners = logs.filter(l => l.type === 'banner');
    const cnt = (arr, st) => arr.filter(l => l.status === st).length;
    const tickets = readTickets();
    await sendMessageTo(chatId,
      `<b>📊 Statistik</b>\n\n` +
      `<b>🎵 Lagu:</b> ${songs.length} total — ✅${cnt(songs,'approved')} ⏳${cnt(songs,'pending')} ❌${cnt(songs,'rejected')}\n` +
      `<b>🖼️ Banner:</b> ${banners.length} total — ✅${cnt(banners,'approved')} ⏳${cnt(banners,'pending')} ❌${cnt(banners,'rejected')}\n\n` +
      `<b>🎫 Tiket:</b> ${tickets.length} total — terbuka: ${tickets.filter(t=>t.status!=='closed').length}, tertutup: ${tickets.filter(t=>t.status==='closed').length}\n\n` +
      `<b>🚫 User diblokir:</b> ${Object.keys(readBans()).length}`
    );
    return;
  }

  if (text === '/top') {
    const logs = readLogs();
    const count = {};
    logs.forEach(l => { count[l.requester] = (count[l.requester] || 0) + 1; });
    const sorted = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sorted.length) { await sendMessageTo(chatId, 'Belum ada request sama sekali.'); return; }
    const lines = sorted.map(([name, c], i) => `${i + 1}. ${name} — ${c}x request`);
    await sendMessageTo(chatId, `<b>🏆 Top Requester</b>\n\n${lines.join('\n')}`);
    return;
  }

  const searchMatch = text.match(/^\/search\s+([\s\S]+)$/i);
  if (searchMatch) {
    const q = searchMatch[1].trim().toLowerCase();
    const logs = readLogs().filter(l =>
      (l.requester || '').toLowerCase().includes(q) || (l.title || '').toLowerCase().includes(q)
    );
    if (!logs.length) { await sendMessageTo(chatId, `Tidak ada hasil untuk "${q}".`); return; }
    const lines = logs.slice(0, 15).map(l =>
      `<code>#${l.id}</code> [${l.type === 'song' ? '🎵' : '🖼️'}] ${statusLabel[l.status] || l.status} — ${l.requester}${l.title ? ' — ' + l.title : ''}`
    );
    await sendMessageTo(chatId, `<b>Hasil pencarian "${q}" (${logs.length})</b>\n\n${lines.join('\n')}`);
    return;
  }

  const delReqMatch = text.match(/^\/delreq\s+(\S+)$/i);
  if (delReqMatch) {
    const id = delReqMatch[1].replace(/^#/, '');
    const logs = readLogs();
    const idx = logs.findIndex(l => String(l.id) === id);
    if (idx === -1) { await sendMessageTo(chatId, 'Request tidak ditemukan.'); return; }
    const [removed] = logs.splice(idx, 1);
    saveLogs(logs);
    await sendMessageTo(chatId, `🗑️ Request <code>#${id}</code> (${removed.requester}) sudah dihapus dari log.`);
    return;
  }

  const noteMatch = text.match(/^\/note\s+(\S+)\s+([\s\S]+)$/i);
  if (noteMatch) {
    const [, id, note] = noteMatch;
    const logs = readLogs();
    const entry = logs.find(l => String(l.id) === id.replace(/^#/, ''));
    if (!entry) { await sendMessageTo(chatId, 'Request tidak ditemukan.'); return; }
    entry.adminNote = note.trim();
    saveLogs(logs);
    await sendMessageTo(chatId, `📝 Catatan disimpan untuk <code>#${entry.id}</code>:\n<i>"${note.trim()}"</i>`);
    return;
  }

  if (text === '/export') {
    await sendMessageTo(chatId, '📦 Menyiapkan file backup...');
    try {
      await sendDocument(LOGS_FILE, `📄 Backup logs.json — ${getTime()}`);
      await sendDocument(TICKETS_FILE, `📄 Backup tickets.json — ${getTime()}`);
    } catch (e) {
      await sendMessageTo(chatId, '❌ Gagal mengirim file backup: ' + e.message);
    }
    return;
  }

  if (text.startsWith('/offreq')) {
    const args = text.replace(/^\/offreq\s*/i, '').trim();
    const [type, ...rest] = args.split(/\s+/);
    const key = type?.toLowerCase();
    if (!['lagu', 'banner', 'video'].includes(key)) {
      await sendMessageTo(chatId,
        '⚠️ Format salah.\n\n' +
        'Gunakan:\n' +
        '<code>/offreq lagu [alasan]</code>\n' +
        '<code>/offreq banner [alasan]</code>\n' +
        '<code>/offreq video [alasan]</code>'
      );
      return;
    }
    // CATATAN: 'video' SENGAJA nempel ke key 'banner' yang sama (bukan key
    // terpisah) -- video emang numpang kuota & toggle buka/tutup punya
    // banner dari awal, jadi /offreq banner otomatis nutup video juga & sebaliknya.
    const statusKey = key === 'video' ? 'banner' : key;
    const reason = rest.join(' ').trim();
    const stat = readReqStatus();
    stat[statusKey] = { enabled: false, message: reason || `Request ${key} sedang ditutup oleh admin.` };
    writeReqStatus(stat);
    const label = key === 'lagu' ? '🎵 Song Request' : key === 'video' ? '🎬 Video Tron (ikut nutup Banner juga)' : '🖼️ Banner Request (ikut nutup Video juga)';
    await sendMessageTo(chatId,
      `🔒 <b>${label} ditutup.</b>\n` +
      `Alasan: <i>${reason || '(tidak ada)'}</i>\n\n` +
      `Ketik <code>/onreq ${key}</code> untuk membuka kembali.`
    );
    return;
  }

  if (text.startsWith('/onreq')) {
    const key = text.replace(/^\/onreq\s*/i, '').trim().toLowerCase();
    if (!['lagu', 'banner', 'video'].includes(key)) {
      await sendMessageTo(chatId,
        '⚠️ Format salah.\n\n' +
        'Gunakan:\n' +
        '<code>/onreq lagu</code>\n' +
        '<code>/onreq banner</code>\n' +
        '<code>/onreq video</code>'
      );
      return;
    }
    const statusKey = key === 'video' ? 'banner' : key;
    const stat = readReqStatus();
    delete stat[statusKey];
    writeReqStatus(stat);
    const label = key === 'lagu' ? '🎵 Song Request' : key === 'video' ? '🎬 Video Tron (ikut buka Banner juga)' : '🖼️ Banner Request (ikut buka Video juga)';
    await sendMessageTo(chatId, `🔓 <b>${label} dibuka kembali.</b>`);
    return;
  }

  if (text === '/reqstatus') {
    const stat = readReqStatus();
    const songStat  = stat.lagu?.enabled === false ? `🔒 <b>TUTUP</b> — ${stat.lagu.message}` : '✅ Buka';
    const bnrStat   = stat.banner?.enabled === false ? `🔒 <b>TUTUP</b> — ${stat.banner.message}` : '✅ Buka';
    const vidStat   = stat.banner?.enabled === false ? `🔒 <b>TUTUP</b> — ${stat.banner.message}` : '✅ Buka'; // nempel status banner (lihat catatan /offreq)
    await sendMessageTo(chatId,
      `<b>📋 Status Request</b>\n\n` +
      `🎵 Song Request: ${songStat}\n` +
      `🖼️ Banner Request: ${bnrStat}\n` +
      `🎬 Video Tron: ${vidStat} <i>(nempel status Banner)</i>`
    );
    return;
  }

  if (text === '/uptime') {
    const sec = process.uptime();
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    const mem = process.memoryUsage().rss / 1024 / 1024;
    await sendMessageTo(chatId,
      `<b>🖥️ Status Server</b>\n\n` +
      `Uptime: ${h}j ${m}m ${s}d\n` +
      `Memori dipakai: ${mem.toFixed(1)} MB\n` +
      `Node.js: ${process.version}`
    );
    return;
  }

  if (text === '/myid') {
    await sendMessageTo(chatId,
      `<b>Info Telegram Kamu</b>\n\n` +
      `Chat ID: <code>${msg.chat.id}</code>\n` +
      `User ID: <code>${msg.from?.id || '-'}</code>\n` +
      `Username: ${msg.from?.username ? '@' + msg.from.username : '-'}`
    );
    return;
  }

  // ══════════════════ Roblox Audio Auto-Upload (diintegrasikan dari audio-bot-v22) ══════════════════

  if (text === '/upload') {
    const replied = msg.reply_to_message;
    const media = replied ? RoAudio.extractMediaFromMessage(replied) : null;
    if (!media) {
      await sendMessageTo(chatId, 'Reply command ini ke pesan yang berisi file audio (mp3) atau gambar ya.');
      return;
    }
    if (RoAudio.checkDuplicate(chatId, media)) return;
    const queuePos = RoAudio.getQueuePosition();
    const statusMsg = await RoAudio.sendInfoFast(chatId, {
      title: media.title,
      status: queuePos === 0 ? '📥 Diterima, langsung diproses...' : `📥 Diterima, antre di posisi ${queuePos}...`,
      id: null
    });
    RoAudio.runQueued(() =>
      RoAudio.handleAssetUpload(chatId, media.fileId, media.fileName, media.title, media.fileUniqueId, media.assetType, media.contentType, statusMsg)
    ).catch((err) => console.error('[RobloxAudio] Upload queue error:', err.message));
    return;
  }

  if (text === '/uploadpending') {
    const { loadPendingList } = require('../lib/robloxAudio');
    const list = loadPendingList();
    if (list.length === 0) {
      await sendMessageTo(chatId, 'Nggak ada yang lagi dipantau di background saat ini.');
      return;
    }
    const lines = list.map((e, i) => `${i + 1}. ${escapeHtml(e.title || e.fileName)} (assetId: <code>${escapeHtml(e.assetId)}</code>)`);
    await sendMessageTo(chatId, `📋 Sedang dipantau (${list.length}):\n${lines.join('\n')}`);
    return;
  }

  if (text === '/id') {
    const { loadHistory } = require('../lib/robloxAudio');
    const history = loadHistory();
    if (history.length === 0) {
      await sendMessageTo(chatId, 'Belum ada riwayat upload.');
      return;
    }
    const lines = history.map((e) => {
      const idLine = e.status === 'approved' ? `id:<code>${escapeHtml(e.assetId)}</code>` : 'id:(tolak)';
      return `${escapeHtml(e.title || e.fileName)}\n${idLine}`;
    });
    const CHUNK = 25;
    for (let i = 0; i < lines.length; i += CHUNK) {
      await sendMessageTo(chatId, lines.slice(i, i + CHUNK).join('\n\n'));
    }
    return;
  }

  if (text === '/links') {
    const { loadHistory } = require('../lib/robloxAudio');
    const history = loadHistory();
    const needLink = history.filter((e) => e.status === 'approved' && !e.permissionGranted);
    if (needLink.length === 0) {
      await sendMessageTo(chatId, 'Semua audio approved sudah punya izin — nggak ada yang perlu di-grant manual.');
      return;
    }
    const lines = needLink.map((e) => `${e.title || e.fileName}\nhttps://create.roblox.com/dashboard/creations/store/${e.assetId}/permissions`);
    const CHUNK = 15;
    for (let i = 0; i < lines.length; i += CHUNK) {
      await sendMessageTo(chatId, lines.slice(i, i + CHUNK).join('\n\n'));
    }
    return;
  }

  if (text === '/cek') {
    const { loadHistory, saveHistory, loadPendingList, getAsset, normalizeModerationState } = require('../lib/robloxAudio');
    const history = loadHistory();
    const pending = loadPendingList();
    const combined = [
      ...history.map((e) => ({ ...e, source: 'history' })),
      ...pending.filter((p) => !history.some((h) => h.assetId === p.assetId)).map((p) => ({ fileName: p.fileName, title: p.title, assetId: p.assetId, status: 'reviewing', source: 'pending' }))
    ];
    if (combined.length === 0) {
      await sendMessageTo(chatId, 'Belum ada riwayat upload maupun yang sedang dipantau sama sekali.');
      return;
    }
    await sendMessageTo(chatId, `🔍 Mengecek ulang ${combined.length} audio langsung ke Roblox, tunggu ya...`);

    let approvedCount = 0, rejectedCount = 0, reviewingCount = 0, errorCount = 0;
    const resultLines = [];
    for (const entry of combined) {
      try {
        const asset = await getAsset(entry.assetId, entry.assetType);
        const state = asset?.moderationResult?.moderationState;
        let label;
        if (normalizeModerationState(state) === 'APPROVED') {
          label = '✅ Approved'; approvedCount++;
          if (entry.source === 'history') entry.status = 'approved';
        } else if (normalizeModerationState(state) === 'REJECTED') {
          label = '🚫 Rejected'; rejectedCount++;
          if (entry.source === 'history') entry.status = 'rejected';
        } else {
          label = '⏳ Masih review'; reviewingCount++;
        }
        resultLines.push(`${entry.title || entry.fileName}: ${label}`);
      } catch (e) {
        errorCount++;
        resultLines.push(`${entry.title || entry.fileName}: ⚠️ Gagal dicek (${e?.response?.status || e.message})`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    saveHistory(history);

    const CHUNK = 20;
    for (let i = 0; i < resultLines.length; i += CHUNK) {
      await sendMessageTo(chatId, resultLines.slice(i, i + CHUNK).join('\n'));
    }
    await sendMessageTo(chatId,
      `✅ Selesai cek ulang ${combined.length} audio:\n` +
      `✅ Approved: ${approvedCount}\n🚫 Rejected: ${rejectedCount}\n⏳ Masih review: ${reviewingCount}\n⚠️ Gagal dicek: ${errorCount}\n\n` +
      `Catatan: yang masih "review" tetap otomatis dipantau di background.`
    );
    return;
  }

  if (text === '/rejectremove') {
    const { loadHistory, saveHistory, archiveAssetOnRoblox } = require('../lib/robloxAudio');
    const history = loadHistory();
    const toArchive = history.filter((e) => e.status === 'rejected' && !e.archived);
    if (toArchive.length === 0) {
      await sendMessageTo(chatId, 'Nggak ada yang perlu diarsipkan — semua rejected sudah diarsip di Roblox.');
      return;
    }
    await sendMessageTo(chatId, `📦 Mengarsipkan ${toArchive.length} audio di Roblox...`);
    let archived = 0, failed = 0;
    const failDetails = [];
    for (const entry of toArchive) {
      try {
        await archiveAssetOnRoblox(entry.assetId);
        entry.archived = true; archived++;
      } catch (e) {
        failed++;
        const detail = e?.response?.data?.error?.message || e?.response?.data?.message || e.message;
        failDetails.push(`${entry.title || entry.fileName}: ${detail}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    saveHistory(history);
    let summary = `📦 Selesai. Diarsipkan di Roblox: ${archived}, gagal: ${failed}`;
    if (failDetails.length > 0) summary += `\n\nDetail gagal:\n${failDetails.slice(0, 10).join('\n')}`;
    await sendMessageTo(chatId, summary.slice(0, 4000));
    return;
  }

  if (text === '/premision' || text === '/premision force') {
    const { loadHistory, saveHistory, autoGrantPermission } = require('../lib/robloxAudio');
    const isForce = text === '/premision force';
    const history = loadHistory();
    const toGrant = isForce ? history.filter((e) => e.status === 'approved') : history.filter((e) => e.status === 'approved' && !e.permissionGranted);
    if (toGrant.length === 0) {
      await sendMessageTo(chatId, isForce ? 'Nggak ada audio berstatus approved di riwayat.' : 'Semua audio approved sudah ditandai punya izin kolaborasi. Coba /premision force buat paksa ulang ke semuanya.');
      return;
    }
    await sendMessageTo(chatId, `🔓 Memberikan izin ke ${toGrant.length} audio${isForce ? ' (mode force)' : ''}...`);
    let granted = 0, failed = 0;
    const failDetails = [];
    for (const entry of toGrant) {
      try {
        const perm = await autoGrantPermission(entry.assetId);
        if (!perm.skipped) { entry.permissionGranted = true; granted++; }
        else { failed++; failDetails.push(`${entry.title || entry.fileName}: dilewati (${perm.reason})`); }
      } catch (e) {
        failed++;
        const detail = require('../lib/robloxAudio').describePermError(e);
        failDetails.push(`${entry.title || entry.fileName} (${entry.assetId}): ${detail}\n   → https://create.roblox.com/dashboard/creations/store/${entry.assetId}/permissions`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    saveHistory(history);
    let summary = `🔓 Selesai. Berhasil: ${granted}, gagal: ${failed}`;
    if (failDetails.length > 0) summary += `\n\nYang gagal (kasih izin manual pakai link ini):\n${failDetails.slice(0, 10).join('\n\n')}`;
    await sendMessageTo(chatId, summary.slice(0, 4000));
    return;
  }

  // /permtest [assetId] — diagnosa auto-grant izin: cek konfigurasi lalu coba SEMUA bentuk request
  // ke Roblox (berhenti di yang pertama berhasil) dan tampilkan hasil tiap percobaan.
  const permTestMatch = text.match(/^\/permtest(?:\s+(\d+))?$/i);
  if (permTestMatch) {
    const { diagnosePermission, loadHistory } = require('../lib/robloxAudio');
    const assetId = permTestMatch[1] || (loadHistory().filter(e => e.status === 'approved' && e.assetType !== 'Image' && e.assetType !== 'VideoFrames' && e.assetId).slice(-1)[0] || {}).assetId;
    if (!assetId) { await sendMessageTo(chatId, 'Belum ada audio approved di riwayat. Pakai: <code>/permtest &lt;assetId&gt;</code>'); return; }
    await sendMessageTo(chatId, `🔬 Mengetes auto-grant izin untuk asset <code>${assetId}</code>...`);
    try {
      const d = await diagnosePermission(assetId);
      const rows = d.result.attempts.map(a => `${a.ok ? '✅' : '✖'} ${a.label}\n   → HTTP ${a.status}${a.message ? ' — ' + escapeHtml(a.message) : ''}`);
      await sendMessageTo(chatId,
        `🔬 <b>Hasil tes auto-grant</b> (asset ${assetId})\n\n` + d.info.map(x => '• ' + escapeHtml(x)).join('\n') + '\n\n' +
        (rows.length ? rows.join('\n') : '(tidak ada percobaan)') + '\n\n' +
        (d.result.ok ? `✅ <b>BERHASIL</b> lewat: ${escapeHtml(d.result.usedVariant)}\n<i>Bentuk ini diingat & dipakai untuk grant berikutnya.</i>` : `❌ <b>GAGAL</b>\n💡 ${escapeHtml(d.hint)}`));
    } catch (e) {
      await sendMessageTo(chatId, `❌ Tes error: ${escapeHtml(e.message)}`);
    }
    return;
  }

  const grantIdMatch = text.match(/^\/grantid\s+(\S+)$/i);
  if (grantIdMatch) {
    const { autoGrantPermission } = require('../lib/robloxAudio');
    const assetId = grantIdMatch[1];
    try {
      const perm = await autoGrantPermission(assetId);
      await sendMessageTo(chatId, `🔍 Raw grant response assetId ${assetId} (subjectType dipakai: ${perm.usedVariant || '-'}):\n\n${JSON.stringify(perm.data || perm, null, 2).slice(0, 3500)}`);
    } catch (e) {
      const status = e?.response?.status;
      const detail = JSON.stringify(e?.response?.data || e.message);
      await sendMessageTo(chatId, `❌ Gagal grant assetId ${assetId}${status ? `\nHTTP ${status}` : ''}\n\n💡 ${e.permHint || e.message}\n\nRincian Roblox: ${detail.slice(0, 1500)}\n\nUntuk melihat semua percobaan: /permtest ${assetId}`);
    }
    return;
  }

  const checkIdMatch = text.match(/^\/checkid\s+(\S+)(?:\s+(image|audio))?$/i);
  if (checkIdMatch) {
    const { getAsset } = require('../lib/robloxAudio');
    const assetId = checkIdMatch[1];
    // Opsional: /checkid <id> image -- kalau assetId itu banner/gambar,
    // biar pakai IMAGE_ASSET_TOKEN (kalau diisi), bukan ASSET_TOKEN audio.
    const assetType = checkIdMatch[2] ? (checkIdMatch[2].toLowerCase() === 'image' ? 'Image' : 'Audio') : undefined;
    try {
      const asset = await getAsset(assetId, assetType);
      const state = asset?.moderationResult?.moderationState || '(tidak ada field moderationResult)';
      await sendMessageTo(chatId, `🔍 Raw check assetId ${assetId}:\nmoderationState: ${state}\n\nFull response:\n${JSON.stringify(asset, null, 2).slice(0, 3000)}`);
    } catch (e) {
      const status = e?.response?.status;
      const detail = e?.response?.data?.message || e.message;
      await sendMessageTo(chatId, `❌ Gagal cek assetId ${assetId}\nHTTP ${status}\n${detail}`);
    }
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════

  if (text === '/backup') {
    await sendMessageTo(chatId, '⏳ Membuat backup (zip seluruh folder database) & mengirim ke chat Owner...');
    try {
      const { sentToTelegram } = await runBackup('🖐️ Backup manual (/backup)');
      if (!sentToTelegram) {
        await sendMessageTo(chatId, '⚠️ Backup dibuat tapi gagal terkirim ke Telegram -- salinannya tersimpan di server (database/user/backups/), coba /backup lagi nanti.');
      }
      // Kalau berhasil, dokumennya udah otomatis nyampe duluan ke chat Owner
      // (dikirim dari dalam runBackup) -- gak perlu kirim summary lagi di sini.
    } catch (e) {
      await sendMessageTo(chatId, `❌ Backup gagal: ${e.message}`);
    }
    return;
  }

  if (text.startsWith('/addadmin')) {
    const newId = text.replace(/^\/addadmin\s*/i, '').trim();
    if (!newId || !/^\d+$/.test(newId)) {
      await sendMessageTo(chatId, '⚠️ Format: <code>/addadmin &lt;telegram_id&gt;</code>'); return;
    }
    if (newId === OWNER_ID) { await sendMessageTo(chatId, '⚠️ ID tersebut adalah Owner.'); return; }
    const admins = readAdmins();
    if (admins.map(String).includes(newId)) {
      await sendMessageTo(chatId, `⚠️ <code>${newId}</code> sudah jadi sub-admin.`); return;
    }
    admins.push(newId);
    writeAdmins(admins);
    await sendMessageTo(chatId,
      `✅ Sub-admin <code>${newId}</code> berhasil ditambahkan.\n` +
      `Total sub-admin: <b>${admins.length}</b>`
    );
    return;
  }

  if (text.startsWith('/removeadmin')) {
    const rmId = text.replace(/^\/removeadmin\s*/i, '').trim();
    if (!rmId) { await sendMessageTo(chatId, '⚠️ Format: <code>/removeadmin &lt;telegram_id&gt;</code>'); return; }
    const before = readAdmins();
    const after  = before.filter(id => String(id) !== rmId);
    writeAdmins(after);
    const removed = before.length !== after.length;
    await sendMessageTo(chatId,
      removed
        ? `✅ Sub-admin <code>${rmId}</code> dihapus. Sisa: <b>${after.length}</b>`
        : `⚠️ ID <code>${rmId}</code> tidak ditemukan di daftar sub-admin.`
    );
    return;
  }

  if (text === '/admins') {
    const admins = readAdmins();
    if (!admins.length) {
      await sendMessageTo(chatId,
        '📋 Belum ada sub-admin.\n\nGunakan <code>/addadmin &lt;telegram_id&gt;</code> untuk menambahkan.'
      );
      return;
    }
    const list = admins.map((id, i) => `${i + 1}. <code>${id}</code>`).join('\n');
    await sendMessageTo(chatId,
      `<b>👥 Daftar Sub-Admin (${admins.length})</b>\n\n` +
      list + '\n\n' +
      `👑 Owner: <code>${OWNER_ID}</code>\n\n` +
      '<i>Hapus: /removeadmin &lt;id&gt;</i>'
    );
    return;
  }

  const broadcastMatch = text.match(/^\/broadcast\s+([\s\S]+)$/i);
  if (broadcastMatch) {
    const admins = readAdmins();
    if (!admins.length) { await sendMessageTo(chatId, '⚠️ Belum ada sub-admin untuk dikirimi broadcast.'); return; }
    const msgText = `📣 <b>Broadcast dari Owner</b>\n\n${broadcastMatch[1].trim()}`;
    let sent = 0;
    for (const aid of admins) { try { await sendMessageTo(aid, msgText); sent++; } catch {} }
    await sendMessageTo(chatId, `📣 Broadcast terkirim ke ${sent}/${admins.length} sub-admin.`);
    return;
  }

  // Broadcast ke DM WA PRIBADI vvip yang nomornya MASIH tersimpan dari sebelum
  // fitur nomor WA dihapus (nomor baru gak bisa didaftarin lagi). BEDA sama
  // saluran WA (yang publik/semua orang bisa liat).
  const broadcastWaMatch = text.match(/^\/boardcastwa\s+([\s\S]+)$/i);
  if (broadcastWaMatch) {
    const { listRoles, getWaNumber } = require('../lib/roles');
    const { sendDirectMessage } = require('../lib/whatsapp');
    const vvipUsernames = Object.entries(listRoles()).filter(([, role]) => role === 'vvip').map(([u]) => u);
    const targets = vvipUsernames.map((u) => ({ u, num: getWaNumber(u) })).filter((t) => t.num);

    if (!targets.length) {
      await sendMessageTo(chatId, '⚠️ Gak ada vvip yang punya nomor WA tersimpan. Nomor WA sudah tidak bisa didaftarkan lagi (ID privat sekarang lewat halaman "ID Saya").');
      return;
    }

    await sendMessageTo(chatId, `📲 Ngirim broadcast ke ${targets.length} nomor WA vvip...`);
    const msgText = broadcastWaMatch[1].trim();
    let sent = 0;
    const failed = [];
    for (const t of targets) {
      try {
        const ok = await sendDirectMessage(t.num, msgText);
        if (ok) sent++; else failed.push(t.u);
      } catch { failed.push(t.u); }
    }
    await sendMessageTo(chatId,
      `📲 Broadcast WA pribadi selesai: ${sent}/${targets.length} berhasil.` +
      (failed.length ? `\n\n⚠️ Gagal ke: ${failed.map((u) => `<code>${u}</code>`).join(', ')}\n<i>(kemungkinan WA belum terhubung, atau nomor gak valid/gak punya WA)</i>` : '')
    );
    return;
  }
  if (/^\/boardcastwa(\s|$)/i.test(text)) {
    await sendMessageTo(chatId, '⚠️ Format: <code>/boardcastwa &lt;pesan&gt;</code>\n\nContoh: <code>/boardcastwa Sesi lagu VVIP dibuka lagi ya, buruan request!</code>\n\n<i>Cuma kekirim ke vvip yang nomor WA-nya masih tersimpan dari sebelumnya (pendaftaran nomor baru sudah ditutup).</i>');
    return;
  }

  const globalbanMatch = text.match(/^\/globalban\s+(\S+)(?:\s+([\s\S]+))?$/i);
  if (globalbanMatch) {
    const [, uname, reason] = globalbanMatch;
    const bans = readBans();
    bans[uname.toLowerCase()] = { reason: reason?.trim() || 'Tidak disebutkan', bannedAt: getTime() };
    saveBans(bans);
    const ips = getUserIps(uname);
    for (const ip of ips) banIp(ip, `Ikut ke-ban dari user "${uname}" (/globalban)`, uname);
    const logs = readLogs();
    let affected = 0;
    for (const l of logs) {
      if (l.status === 'pending' && (l.username || '').toLowerCase() === uname.toLowerCase()) {
        l.status = 'rejected';
        l.lastActionBy = actorFrom(msg.from);
        l.note = 'Auto-ditolak: user diban (/globalban)';
        affected++;
      }
    }
    saveLogs(logs);
    const ipNote = ips.length ? `\n🌐 ${ips.length} IP yang pernah dipakai user ini ikut diblokir.` : '';
    await sendMessageTo(chatId, `🚫🌐 User <code>${uname}</code> diban total.\nAlasan: ${reason?.trim() || '-'}\n📋 ${affected} request pending miliknya otomatis ditolak.${ipNote}`);
    return;
  }

  const purgeMatch = text.match(/^\/purge\s+(\d+)$/i);
  if (purgeMatch) {
    const days = parseInt(purgeMatch[1], 10);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const logs = readLogs();
    const kept = logs.filter(l => {
      const t = Date.parse(l.time);
      return isNaN(t) ? true : t >= cutoff;
    });
    const removed = logs.length - kept.length;
    saveLogs(kept);
    await sendMessageTo(chatId, `🧹 Purge selesai. ${removed} log lebih tua dari ${days} hari sudah dihapus.\nSisa log: ${kept.length}.`);
    return;
  }

  if (text === '/resetalllimit') {
    saveRates({});
    await sendMessageTo(chatId, '🔄 Rate limit SEMUA user sudah direset ke 0.');
    return;
  }

  const lockdownMatch = text.match(/^\/lockdown(?:\s+([\s\S]+))?$/i);
  if (lockdownMatch) {
    const reason = lockdownMatch[1]?.trim() || 'Sedang ada perbaikan darurat.';
    writeReqStatus({
      lagu:   { enabled: false, message: reason },
      banner: { enabled: false, message: reason }
    });
    writeAppStatus({ mode: 'maintenance', message: reason });
    await sendMessageTo(chatId,
      `🔒 <b>LOCKDOWN AKTIF.</b>\n` +
      `Request lagu, request banner, & seluruh website dimatikan sementara.\n` +
      `Alasan: <i>${reason}</i>\n\n` +
      `Ketik <code>/unlock</code> untuk membuka semuanya lagi.`
    );
    return;
  }

  if (text === '/unlock') {
    writeReqStatus({
      lagu:   { enabled: true },
      banner: { enabled: true }
    });
    writeAppStatus({ mode: 'online' });
    await sendMessageTo(chatId, '🔓 <b>Lockdown dimatikan.</b>\nRequest lagu, banner, & website sudah online kembali.');
    return;
  }

  const promoteMatch = text.match(/^\/promote\s+(\S+)$/i);
  if (promoteMatch) {
    const newId = promoteMatch[1].trim();
    const admins = readAdmins();
    if (admins.map(String).includes(newId) || newId === OWNER_ID) {
      await sendMessageTo(chatId, '⚠️ ID itu sudah jadi admin.'); return;
    }
    admins.push(newId);
    writeAdmins(admins);
    await sendMessageTo(chatId, `⬆️ <code>${newId}</code> sudah dipromote jadi sub-admin.\nMinta dia /start bot ini buat mulai pakai command admin.`);
    return;
  }

  const demoteMatch = text.match(/^\/demote\s+(\S+)$/i);
  if (demoteMatch) {
    const rmId = demoteMatch[1].trim();
    const admins = readAdmins().filter(a => String(a) !== rmId);
    writeAdmins(admins);
    await sendMessageTo(chatId, `⬇️ <code>${rmId}</code> sudah didemote, bukan sub-admin lagi.`);
    return;
  }

  if (text === '/listbackup') {
    // Salinan zip terbaru (database-*.zip di database/user/backups/) + snapshot
    // JSON lama (backups/backup_*.json) kalau masih ada.
    const { BACKUPS_DIR } = require('../lib/dbBackup');
    let files = [];
    try { files.push(...fs.readdirSync(BACKUPS_DIR).filter(f => f.endsWith('.zip'))); } catch {}
    try { files.push(...fs.readdirSync(BACKUP_DIR)); } catch {}
    files = files.sort().reverse();
    if (!files.length) { await sendMessageTo(chatId, 'Belum ada file backup.'); return; }
    const lines = files.slice(0, 20).map(f => `<code>${f}</code>`);
    await sendMessageTo(chatId, `<b>🗄️ Daftar Backup (${files.length})</b>\n\n${lines.join('\n')}\n\n<i>Ambil: /getbackup &lt;nama_file&gt;</i>`);
    return;
  }

  const getbackupMatch = text.match(/^\/getbackup\s+(\S+)$/i);
  if (getbackupMatch) {
    const fname = getbackupMatch[1].replace(/[\\/]/g, '');
    const { BACKUPS_DIR } = require('../lib/dbBackup');
    const fpath = [path.join(BACKUPS_DIR, fname), path.join(BACKUP_DIR, fname)].find(p => fs.existsSync(p)) || path.join(BACKUP_DIR, fname);
    if (!fs.existsSync(fpath)) { await sendMessageTo(chatId, '⚠️ File backup itu tidak ditemukan. Cek /listbackup.'); return; }
    try { await sendDocument(fpath, `🗄️ Backup file: ${fname}`); }
    catch (e) { await sendMessageTo(chatId, '❌ Gagal kirim file: ' + e.message); }
    return;
  }

  if (text === '/wipelogs') {
    await sendMessageTo(chatId, '⚠️ Ini akan MENGHAPUS SEMUA log request, tidak bisa dibalikin.\nKetik <code>/wipelogs confirm</code> kalau yakin.');
    return;
  }
  if (text === '/wipelogs confirm') {
    saveLogs([]);
    saveClaims({});
    savePins([]);
    await sendMessageTo(chatId, '🧨 Semua log request sudah dihapus total.');
    return;
  }

  if (text === '/wipetickets') {
    await sendMessageTo(chatId, '⚠️ Ini akan MENGHAPUS SEMUA tiket, tidak bisa dibalikin.\nKetik <code>/wipetickets confirm</code> kalau yakin.');
    return;
  }
  if (text === '/wipetickets confirm') {
    saveTickets([]);
    await sendMessageTo(chatId, '🧨 Semua tiket sudah dihapus total.');
    return;
  }

  const setgroupMatch = text.match(/^\/setgroup\s+(\S+)$/i);
  if (setgroupMatch) {
    const val = setgroupMatch[1].trim();
    if (val.toLowerCase() === 'off') {
      writeGroupOverride({ groupId: null });
      await sendMessageTo(chatId, `🔁 Grup tujuan broadcast dikembalikan ke default (config.js): <code>${CFG.REQUEST_GROUP_ID}</code>.`);
    } else {
      writeGroupOverride({ groupId: val });
      await sendMessageTo(chatId, `✅ Grup tujuan broadcast diganti ke <code>${val}</code>.\n<i>Aktif kalau mode sedang /grouponly. Ketik /setgroup off untuk kembali ke default.</i>`);
    }
    return;
  }

  if (text === '/auditlog') {
    const log = readAudit().slice(0, 15);
    if (!log.length) { await sendMessageTo(chatId, 'Belum ada riwayat command.'); return; }
    const lines = log.map(a => `<code>${a.time}</code> — ${a.name}: <code>${a.command}</code>`);
    await sendMessageTo(chatId, `<b>🕵️ 15 Command Terakhir</b>\n\n${lines.join('\n')}`);
    return;
  }

  const { readSchedule, setSlotTime, clearSlot, clearAll, fmtSlot, MAX_SLOTS } = require('../lib/scheduler');

  const setopenMatch  = text.match(/^\/setopenapp([123])\s+(\d{1,2}:\d{2})$/i);
  const setcloseMatch = text.match(/^\/setcloseapp([123])\s+(\d{1,2}:\d{2})$/i);
  const clearMatch    = text.match(/^\/clearschedule([123])$/i);

  if (setopenMatch || setcloseMatch) {
    const m     = setopenMatch || setcloseMatch;
    const slot  = parseInt(m[1], 10);
    const field = setopenMatch ? 'openTime' : 'closeTime';
    const label = setopenMatch ? '🟢 Buka' : '🔴 Tutup';

    const [hStr, minStr] = m[2].split(':');
    const h = parseInt(hStr, 10), min = parseInt(minStr, 10);
    if (h < 0 || h > 23 || min < 0 || min > 59) {
      await sendMessageTo(chatId, '❌ Format jam tidak valid. Contoh: <code>08:00</code>, <code>22:30</code>');
      return;
    }
    const timeStr = `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
    const entry = setSlotTime(slot, field, timeStr);
    await sendMessageTo(chatId,
      `✅ <b>${label} Jadwal ${slot}</b> diatur ke <b>${timeStr} WIB</b>.\n\n` +
      fmtSlot(entry) + '\n\n' +
      '<i>Bot akan otomatis buka/tutup app saat jam ini tiba.</i>'
    );
    return;
  }

  if (clearMatch) {
    const slot = parseInt(clearMatch[1], 10);
    clearSlot(slot);
    await sendMessageTo(chatId, `🗑️ Jadwal ${slot} dihapus.`);
    return;
  }

  if (text === '/clearallschedule') {
    clearAll();
    await sendMessageTo(chatId, '🗑️ Semua jadwal buka/tutup app dihapus.');
    return;
  }

  if (text === '/listschedule') {
    const schedules = readSchedule();
    if (!schedules.length) {
      await sendMessageTo(chatId,
        '📅 <b>Belum ada jadwal terdaftar.</b>\n\n' +
        'Format command:\n' +
        '<code>/setopenapp1 08:00</code>  — buka otomatis jam 08.00 WIB\n' +
        '<code>/setcloseapp1 22:00</code> — tutup otomatis jam 22.00 WIB\n' +
        '<code>/setopenapp2 ...</code>    — jadwal ke-2\n' +
        '<code>/setopenapp3 ...</code>    — jadwal ke-3 (maks)\n\n' +
        '<i>Bisa ditumpuk hingga 3 jadwal sekaligus.</i>'
      );
      return;
    }
    const lines = schedules.map(fmtSlot).join('\n\n');
    await sendMessageTo(chatId,
      `<b>📅 Jadwal Buka/Tutup App (${schedules.length}/${MAX_SLOTS})</b>\n\n` +
      lines + '\n\n' +
      '<i>Semua waktu dalam WIB. /clearschedule1 untuk hapus slot 1, dst.</i>'
    );
    return;
  }

  if (text === '/version') {
    await sendMessageTo(chatId,
      `<b>🤖 Roblox Song Request — by wanz</b>\n\n` +
      `Mode chat aktif : <code>${readChatMode().mode}</code>\n` +
      `Grup broadcast  : <code>${activeGroupId() || '(belum diset)'}</code>\n` +
      `Sub-admin       : ${readAdmins().length} orang\n` +
      `Total log       : ${readLogs().length}\n` +
      `Total tiket     : ${readTickets().length}\n\n` +
      `<i>Website: ${'https://copyright.by-wanzz.my.id/'}</i>`
    );
    return;
  }

  const genmobileMatch = text.match(/^\/genmobilekey(?:\s+(.+))?$/i);
  if (genmobileMatch) {
    const { createToken } = require('../lib/mobile-tokens');
    const label  = genmobileMatch[1]?.trim() || 'APK Token';
    const result = createToken(label);
    await sendMessageTo(chatId,
      `📱 <b>Mobile API Key dibuat!</b>\n\n` +
      `Label : <b>${result.label}</b>\n` +
      `Key   : <code>${result.key}</code>\n\n` +
      `Masukkan key ini ke APK saat setup pertama kali.\n` +
      `<i>Jangan bagikan key ini ke sembarangan orang.</i>`
    );
    return;
  }

  if (text === '/mobiletokens') {
    const { listTokens } = require('../lib/mobile-tokens');
    const tokens = listTokens();
    if (!tokens.length) { await sendMessageTo(chatId, '📱 Belum ada mobile API key yang dibuat.\n\nGunakan <code>/genmobilekey [label]</code> untuk membuat.'); return; }
    const lines = tokens.map((t, i) =>
      `${i + 1}. <b>${t.label}</b>\n` +
      `   Key: <code>${t.key}</code>\n` +
      `   Status: ${t.active ? '✅ Aktif' : '❌ Dinonaktifkan'}\n` +
      `   Dibuat: ${t.created?.slice(0, 10) || '-'}\n` +
      `   Terakhir: ${t.lastUsed ? t.lastUsed.slice(0, 10) : 'Belum pernah'}`
    );
    await sendMessageTo(chatId, `<b>📱 Mobile API Keys (${tokens.length})</b>\n\n${lines.join('\n\n')}\n\n<i>/revokemobilekey &lt;key&gt; untuk nonaktifkan.</i>`);
    return;
  }

  const revokeMatch = text.match(/^\/revokemobilekey\s+(\S+)$/i);
  if (revokeMatch) {
    const { revokeToken } = require('../lib/mobile-tokens');
    const ok = revokeToken(revokeMatch[1].trim());
    await sendMessageTo(chatId, ok ? `🚫 Mobile key <code>${revokeMatch[1].trim()}</code> dinonaktifkan. APK yang pakai key ini tidak bisa request lagi.` : '⚠️ Key tidak ditemukan.');
    return;
  }

  const {
    readSongSchedule, setSongSlot, clearSongSlot, clearAllSongSchedule, fmtSongSlot,
    readSongSession, openSession, closeSession, openSongSession, closeSongSession,
    isBannerPaused, pauseBanner, resumeBanner,
    MAX_SLOTS: SONG_MAX_SLOTS
  } = require('../lib/songSchedule');

  function fmtTypeStatus(t, label) {
    if (!t || t.quota == null) return `${label} : — (gak ikut kuota)`;
    return `${label} : ${t.active ? '🟢' : '🔴'} ${t.count}/${t.quota}`;
  }

  // /setsongslot1 14:00 25 5 Sesi Siang   → slot, jam, kuota lagu, kuota banner (opsional), label (opsional)
  // /setsongslot1 14:00 25 Sesi Siang     → format lama, kuota banner gak diubah
  const setSongSlotMatch = text.match(/^\/setsongslot([123])\s+(\d{1,2}:\d{2})\s+(\d+)(?:\s+(\d+))?(?:\s+([\s\S]+))?$/i);
  if (setSongSlotMatch) {
    const slot = parseInt(setSongSlotMatch[1], 10);
    const [hStr, minStr] = setSongSlotMatch[2].split(':');
    const h = parseInt(hStr, 10), min = parseInt(minStr, 10);
    if (h < 0 || h > 23 || min < 0 || min > 59) {
      await sendMessageTo(chatId, '❌ Format jam tidak valid. Contoh: <code>14:00</code>, <code>19:30</code>');
      return;
    }
    const openTime    = `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
    const songQuota   = parseInt(setSongSlotMatch[3], 10);
    const bannerQuota = setSongSlotMatch[4] !== undefined ? parseInt(setSongSlotMatch[4], 10) : undefined;
    const label       = setSongSlotMatch[5]?.trim() || undefined;
    const entry = setSongSlot(slot, { openTime, songQuota, bannerQuota, label });
    await sendMessageTo(chatId,
      `✅ <b>Jadwal slot ${slot} disimpan.</b>\n\n` +
      fmtSongSlot(entry) + '\n\n' +
      '<i>Lagu & banner akan buka otomatis jam segini dengan kuota masing-masing di atas.</i>'
    );
    return;
  }

  const clearSongSlotMatch = text.match(/^\/clearsongslot([123])$/i);
  if (clearSongSlotMatch) {
    const slot = parseInt(clearSongSlotMatch[1], 10);
    clearSongSlot(slot);
    await sendMessageTo(chatId, `🗑️ Jadwal slot ${slot} dihapus.`);
    return;
  }

  if (text === '/clearallsongschedule') {
    clearAllSongSchedule();
    await sendMessageTo(chatId, '🗑️ Semua jadwal & kuota (lagu+banner) dihapus. (Tidak otomatis buka/tutup lagi sampai diatur ulang)');
    return;
  }

  if (text === '/listsongschedule') {
    const schedules = readSongSchedule();
    const session = readSongSession();
    const sessionText = session.active
      ? `🟢 <b>Sesi aktif:</b> ${session.label || '(manual)'}\n` +
        `   ${fmtTypeStatus(session.song, '🎵 Lagu  ')}\n` +
        `   ${fmtTypeStatus(session.banner, '🖼️ Banner')}\n` +
        `   Sumber : ${session.source === 'schedule' ? 'otomatis (jadwal)' : session.source === 'auto-quota' ? 'auto-tutup kuota' : 'manual'}\n` +
        `   Dibuka : ${session.openedAt || '-'}`
      : `🔴 <b>Tidak ada sesi aktif</b> (lagu/banner ikut status /reqstatus biasa)`;
    if (!schedules.length) {
      await sendMessageTo(chatId,
        '📅 <b>Belum ada jadwal kuota.</b>\n\n' +
        'Format command:\n' +
        '<code>/setsongslot1 14:00 25 5 Sesi Siang</code> (jam, kuota lagu, kuota banner, label)\n' +
        '<code>/setsongslot2 19:00 10 5 Sesi Malam</code>\n' +
        `<i>Bisa sampai ${SONG_MAX_SLOTS} slot sekaligus. Kuota banner opsional (boleh dikosongin).</i>\n\n` +
        'Mau buka sesi kuota sekarang juga (di luar jadwal)?\n' +
        '<code>/setgloballimit 25 5</code> — buka lagu+banner + reset limit semua user\n\n' +
        sessionText
      );
      return;
    }
    const lines = schedules.map(fmtSongSlot).join('\n\n');
    await sendMessageTo(chatId,
      `<b>📅 Jadwal &amp; Kuota (${schedules.length}/${SONG_MAX_SLOTS})</b>\n\n` +
      lines + '\n\n' +
      sessionText + '\n\n' +
      '<i>/clearsongslot1 hapus slot 1, dst. /opensong, /openbanner, /closesong, /closebanner untuk override manual. /setgloballimit &lt;lagu&gt; [banner] buka sesi kuota sendiri + reset limit semua user.</i>'
    );
    return;
  }

  const openSongMatch = text.match(/^\/opensong(?:\s+(\d+))?$/i);
  if (openSongMatch) {
    const quota = openSongMatch[1] ? parseInt(openSongMatch[1], 10) : null;
    openSession({ slot: null, label: 'Dibuka Manual', songQuota: quota, source: 'manual' });
    await sendMessageTo(chatId,
      `🔓 <b>Request lagu dibuka manual.</b>\n` +
      `Kuota: <b>${quota != null ? quota + ' ID lagu' : 'unlimited'}</b>\n\n` +
      `<i>Jadwal otomatis tetap jalan seperti biasa dan akan override sesi ini saat jamnya tiba.</i>`
    );
    return;
  }

  const openBannerMatch = text.match(/^\/openbanner(?:\s+(\d+))?$/i);
  if (openBannerMatch) {
    const quota = openBannerMatch[1] ? parseInt(openBannerMatch[1], 10) : null;
    openSession({ slot: null, label: 'Dibuka Manual', bannerQuota: quota, source: 'manual' });
    await sendMessageTo(chatId,
      `🔓 <b>Request banner dibuka manual.</b>\n` +
      `Kuota: <b>${quota != null ? quota + ' ID banner' : 'unlimited'}</b>\n\n` +
      `<i>Jadwal otomatis tetap jalan seperti biasa dan akan override sesi ini saat jamnya tiba.</i>`
    );
    return;
  }

  // /setgloballimit 25 5 [label]  → kuota lagu 25, kuota banner 5 (opsional), label opsional
  const setGlobalLimitMatch = text.match(/^\/setgloballimit\s+(\d+)(?:\s+(\d+))?(?:\s+([\s\S]+))?$/i);
  if (setGlobalLimitMatch) {
    const songQuota   = parseInt(setGlobalLimitMatch[1], 10);
    const bannerQuota = setGlobalLimitMatch[2] !== undefined ? parseInt(setGlobalLimitMatch[2], 10) : undefined;
    const label = setGlobalLimitMatch[3]?.trim() || 'Global Limit Manual';
    openSession({ slot: null, label, songQuota, bannerQuota, source: 'manual' });
    await sendMessageTo(chatId,
      `🌐 <b>Global limit diset.</b>\n\n` +
      `🎵 Kuota lagu   : <b>${songQuota}</b>\n` +
      `🖼️ Kuota banner : <b>${bannerQuota != null ? bannerQuota : '— (gak diubah)'}</b>\n\n` +
      `✅ Request dibuka.\n` +
      `✅ Limit personal SEMUA user ikut direset penuh (gak ketahan cooldown lama).\n\n` +
      `<i>Kuota tutup otomatis begitu limit tercapai. Jadwal otomatis tetap jalan seperti biasa.</i>`
    );
    return;
  }

  const closeSongMatch = text.match(/^\/closesong(?:\s+([\s\S]+))?$/i);
  if (closeSongMatch) {
    const reason = closeSongMatch[1]?.trim() || 'Request lagu ditutup oleh admin.';
    closeSession('song', reason, 'manual');
    await sendMessageTo(chatId,
      `🔒 <b>Request lagu ditutup manual.</b>\n` +
      `Alasan: <i>${reason}</i>\n\n` +
      `<i>Jadwal otomatis tetap jalan dan akan buka lagi sesuai jadwal berikutnya. Ketik /opensong untuk buka manual sekarang.</i>`
    );
    return;
  }

  const closeBannerMatch = text.match(/^\/closebanner(?:\s+([\s\S]+))?$/i);
  if (closeBannerMatch) {
    const reason = closeBannerMatch[1]?.trim() || 'Request banner ditutup oleh admin.';
    closeSession('banner', reason, 'manual');
    await sendMessageTo(chatId,
      `🔒 <b>Request banner ditutup manual.</b>\n` +
      `Alasan: <i>${reason}</i>\n\n` +
      `<i>Jadwal otomatis tetap jalan dan akan buka lagi sesuai jadwal berikutnya. Ketik /openbanner untuk buka manual sekarang.</i>`
    );
    return;
  }

  const pauseBannerMatch = text.match(/^\/pausebanner(?:\s+([\s\S]+))?$/i);
  if (pauseBannerMatch) {
    const reason = pauseBannerMatch[1]?.trim();
    pauseBanner(reason);
    await sendMessageTo(chatId,
      `⏸️ <b>Banner di-pause TOTAL.</b>\n` +
      `Alasan: <i>${reason || 'Fitur request banner sedang dinonaktifkan sementara oleh admin (ada masalah upload gambar).'}</i>\n\n` +
      `<b>Beda dengan /closebanner:</b> jadwal otomatis <b>gak akan buka banner lagi</b> sampai kamu ketik /resumebanner — kuota banner di jadwal bakal di-skip terus.\n` +
      `Request lagu & fitur lain tetap normal.`
    );
    return;
  }

  if (text === '/resumebanner') {
    resumeBanner();
    await sendMessageTo(chatId,
      `▶️ <b>Pause banner dicabut.</b>\n\n` +
      `Banner sekarang ikut jadwal otomatis lagi seperti biasa. Kalau mau buka sekarang juga, ketik /openbanner.`
    );
    return;
  }

  if (text === '/songstatus') {
    const session = readSongSession();
    if (!session.active) {
      await sendMessageTo(chatId, '🔴 <b>Tidak ada sesi lagu/banner aktif saat ini.</b>\n\nGunakan <code>/opensong</code> atau <code>/openbanner</code>, atau tunggu jadwal berikutnya (<code>/listsongschedule</code>).');
      return;
    }
    await sendMessageTo(chatId,
      `<b>🎵 Status Sesi Kuota</b>\n\n` +
      `Nama    : <b>${session.label || '(manual)'}</b>\n` +
      `${fmtTypeStatus(session.song, '🎵 Lagu  ')}\n` +
      `${fmtTypeStatus(session.banner, '🖼️ Banner')}${isBannerPaused() ? ' — ⏸️ PAUSED (jadwal di-skip)' : ''}\n` +
      `Sumber  : ${session.source === 'schedule' ? 'otomatis (jadwal)' : 'manual'}\n` +
      `Dibuka  : ${session.openedAt || '-'}`
    );
    return;
  }

  if (text === '/menu' || text === '/start') {
    const buttons = [[{ text: '🛠️ Admin Menu', callback_data: 'mtype:admin', style: 'primary' }]];
    if (isOwner(senderId)) buttons[0].push({ text: '👑 Own Menu', callback_data: 'mtype:owner', style: 'danger' });
    await sendMessageTo(chatId,
      MENU_HEADER + MENU_SEP +
      'Pilih menu yang mau dibuka:\n\n' +
      '🛠️ <b>Admin Menu</b> — fitur harian kelola request, tiket, klaim, dll (bisa dipakai semua admin/sub-admin)\n' +
      (isOwner(senderId) ? '👑 <b>Own Menu</b> — kontrol penuh app/website, broadcast, backup, dll (khusus owner)\n' : '') +
      '\n<i>Tap salah satu tombol di bawah 👇</i>',
      { inline_keyboard: buttons }
    );
    return;
  }

  // ── Panduan command tidak lengkap / typo ──
  // Semua command di atas udah punya handler masing-masing dan udah "return".
  // Kalau sampai sini dan teksnya diawali "/", berarti: nama commandnya bener
  // tapi argumennya kurang/salah format, ATAU nama commandnya typo.
  if (text.startsWith('/')) {
    await guideIncompleteCommand(chatId, text);
  }
}

// Format command yang butuh argumen — dipakai buat kasih contoh format yang benar
// PENTING: pesan ini dikirim dengan parse_mode HTML (lihat guideIncompleteCommand ->
// sendMessageTo), jadi placeholder WAJIB pakai &lt;...&gt; -- bukan <...> mentah.
// <...> mentah dibaca Telegram sebagai tag HTML sungguhan; kalau bukan tag yang
// dikenal (mis. <user>, <id>), Telegram nolak SELURUH pesan (400 can't parse
// entities) dan pesannya gak pernah terkirim -- gagalnya diam-diam, gak ada log
// error sama sekali karena sendMessageTo gak ngecek hasil kiriman.
const COMMAND_USAGE = {
  acc: '/acc &lt;id&gt;', tolak: '/tolak &lt;id&gt;', pending: '/pending &lt;id&gt;',
  a: '/a &lt;id&gt;', t: '/t &lt;id&gt;', r: '/r &lt;id&gt;',
  detail: '/detail &lt;id&gt;', delreq: '/delreq &lt;id&gt;',
  claim: '/claim &lt;id&gt;', unclaim: '/unclaim &lt;id&gt;', whoclaim: '/whoclaim &lt;id&gt;',
  pin: '/pin &lt;id&gt;', unpin: '/unpin &lt;id&gt;', remind: '/remind &lt;id&gt;',
  cancel: '/cancel &lt;id&gt; [alasan]', closetiket: '/closetiket &lt;id&gt;',
  finduser: '/finduser &lt;username&gt;', search: '/search &lt;kata kunci&gt;',
  note: '/note &lt;id&gt; &lt;catatan&gt;',
  setrole: '/setrole username,display,role[,durasi]\n\nrole: member|vip|vvip|admin|owner|dev\ndurasi (vip/vvip): angka + d(hari)/w(minggu)/m(bulan), mis. 1d, 21w, 1m — boleh digabung: 1m,2w\n\nContoh: /setrole rahasia123,-,vvip,1m',
  checkrole: '/checkrole &lt;username&gt;',
  addlimit: '/addlimit &lt;user&gt; &lt;song|banner&gt; &lt;jumlah&gt;',
  resetlimit: '/resetlimit &lt;user&gt;', checklimit: '/checklimit &lt;user&gt;',
  setlimit: '/setlimit &lt;song|banner&gt; &lt;jumlah&gt;',
  setmaxqueue: '/setmaxqueue &lt;jumlah&gt;',
  setlimitreset: '/setlimitreset &lt;jam&gt;[,&lt;menit&gt;]',
  addwa: '/addwa &lt;nomor&gt;',
  ban: '/ban &lt;user&gt; [alasan]', unban: '/unban &lt;user&gt;',
  globalban: '/globalban &lt;user&gt; [alasan]',
  announce: '/announce &lt;pesan&gt;', broadcast: '/broadcast &lt;pesan&gt;', boardcastwa: '/boardcastwa &lt;pesan&gt;',
  purge: '/purge &lt;hari&gt;',
  promote: '/promote &lt;telegram_id&gt;', demote: '/demote &lt;telegram_id&gt;',
  addadmin: '/addadmin &lt;telegram_id&gt;', removeadmin: '/removeadmin &lt;telegram_id&gt;',
  getbackup: '/getbackup &lt;nama_file&gt;', setgroup: '/setgroup &lt;group_id|off&gt;',
  offreq: '/offreq &lt;lagu|banner&gt; [alasan]', onreq: '/onreq &lt;lagu|banner&gt;',
  setopenapp1: '/setopenapp1 &lt;jam:menit&gt;', setopenapp2: '/setopenapp2 &lt;jam:menit&gt;', setopenapp3: '/setopenapp3 &lt;jam:menit&gt;',
  setcloseapp1: '/setcloseapp1 &lt;jam:menit&gt;', setcloseapp2: '/setcloseapp2 &lt;jam:menit&gt;', setcloseapp3: '/setcloseapp3 &lt;jam:menit&gt;',
  revokemobilekey: '/revokemobilekey &lt;key&gt;',
  setsongslot1: '/setsongslot1 &lt;jam:menit&gt; &lt;kuota_lagu&gt; [kuota_banner] [label]',
  setsongslot2: '/setsongslot2 &lt;jam:menit&gt; &lt;kuota_lagu&gt; [kuota_banner] [label]',
  setsongslot3: '/setsongslot3 &lt;jam:menit&gt; &lt;kuota_lagu&gt; [kuota_banner] [label]',
  setgloballimit: '/setgloballimit &lt;lagu&gt; [banner] [label]',
  apkadduser: '/apkadduser &lt;user&gt; [hari] [member|vip|vvip|admin|owner|dev]',
  apkdeluser: '/apkdeluser &lt;user&gt;', apkextend: '/apkextend &lt;user&gt; &lt;hari&gt;',
  apkinfo: '/apkinfo &lt;user&gt;', apkkick: '/apkkick &lt;user&gt;',
  grantid: '/grantid &lt;assetId&gt;', checkid: '/checkid &lt;assetId&gt;',
};

// Command yang gak butuh argumen (buat referensi saran typo)
const NO_ARG_COMMANDS = [
  'list','today','queue','shortcuts','mixing','myclaims','pinned','uptime','myid',
  'tickets','tiket','unreadtickets','lastticket','lastacc','lasttolak','myinfo',
  'admins','auditlog','version','banlist','limitstats','apklist','apkstats',
  'export','backup','listbackup','clearannounce','privatonly','grouponly',
  'wipelogs','wipetickets','unlock','appon','online','appstatus','reqstatus',
  'songstatus','resumebanner','listschedule','listsongschedule','clearallschedule',
  'clearallsongschedule','stats','top','menu','start','listroles',
  'clearschedule1','clearschedule2','clearschedule3',
  'clearsongslot1','clearsongslot2','clearsongslot3',
  'uploadpending','id','links','cek','rejectremove','premision',
];

async function guideIncompleteCommand(chatId, text) {
  const wordMatch = text.match(/^\/([a-zA-Z0-9_]+)/);
  const word = (wordMatch ? wordMatch[1] : '').toLowerCase();

  if (COMMAND_USAGE[word]) {
    await sendMessageTo(chatId,
      `⚠️ <b>Format /${word} kurang lengkap atau salah.</b>\n\n` +
      `Cara penggunaan yang benar:\n${COMMAND_USAGE[word]}`
    );
    return;
  }

  if (NO_ARG_COMMANDS.includes(word)) {
    await sendMessageTo(chatId,
      `⚠️ <b>/${word}</b> gak butuh argumen tambahan.\n\nCukup ketik: /${word}`
    );
    return;
  }

  await sendMessageTo(chatId,
    `❓ Command <b>/${word}</b> tidak dikenal.\n\nKetik /menu untuk lihat daftar menu, atau /shortcuts untuk lihat cara pakai semua command.`
  );
}

module.exports = { handleMessage };
