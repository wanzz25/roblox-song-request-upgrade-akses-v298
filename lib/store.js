// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Store — Persistensi Data JSON                        ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝

const fs   = require('fs');
const path = require('path');
const { dataFile } = require('./dataPaths');
const CFG  = require('../config');
const { getTime } = require('./util');

const ROOT = path.join(__dirname, '..');

const STATUS_FILE = dataFile('app_status.json');
function readAppStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); }
  catch { return { mode: 'online', message: '' }; }
}
function writeAppStatus(data) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2));
}

const LOGS_FILE = dataFile('logs.json');
function readLogs() {
  try { return JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8')); } catch { return []; }
}
function saveLogs(logs) {
  fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2));
}
function writeLog(entry) {
  const logs = readLogs();
  // ts numerik (epoch ms) buat perbandingan waktu yang akurat -- field `time`
  // yang lama cuma string lokal (contoh: "Jumat, 5 September 2026 pukul 07.20")
  // gak bisa dibandingkan langsung buat nentuin "request ini masuk sebelum/sesudah
  // sesi dibuka". Auto-isi di sini biar semua writeLog() dapet ini tanpa perlu
  // ubah satu-satu titik pemanggilannya.
  if (entry.ts === undefined) entry.ts = Date.now();
  logs.unshift(entry);
  if (logs.length > 200) logs.splice(200);
  saveLogs(logs);
  return entry;
}
function updateLogStatus(id, status, extra) {
  const logs = readLogs();
  const entry = logs.find(l => String(l.id) === String(id));
  if (!entry) return null;
  entry.status = status;
  if (extra) Object.assign(entry, extra);
  saveLogs(logs);
  // Request video DITOLAK/GAGAL -> file videonya (disimpan di uploads/ sambil nunggu diproses)
  // gak dibutuhin lagi, langsung dihapus biar gak numpuk. (Yang 'approved' sengaja tidak
  // dihapus di sini -- masih dipakai tahap share/kirim ke saluran.)
  if (status === 'rejected' && entry.videoPath) { try { fs.unlink(entry.videoPath, () => {}); } catch {} }
  return entry;
}

function findEntry(id) { return readLogs().find(l => String(l.id) === String(id)); }

const TICKETS_FILE = dataFile('tickets.json');
function readTickets() {
  try { return JSON.parse(fs.readFileSync(TICKETS_FILE, 'utf8')); } catch { return []; }
}
function saveTickets(tickets) {
  fs.writeFileSync(TICKETS_FILE, JSON.stringify(tickets, null, 2));
}
function makeTicketId() {
  return 'TK' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
}
function findTicket(id) {
  return readTickets().find(t => t.id === id) || null;
}
function findTicketByText(text) {
  if (!text) return null;
  const m = text.match(/TK[A-Z0-9]{6,}/);
  if (!m) return null;
  return findTicket(m[0]);
}
function saveTicket(ticket) {
  const tickets = readTickets();
  const idx = tickets.findIndex(t => t.id === ticket.id);
  if (idx >= 0) tickets[idx] = ticket; else tickets.unshift(ticket);
  if (tickets.length > 300) tickets.splice(300);
  saveTickets(tickets);
  return ticket;
}

const BAN_FILE = dataFile('banlist.json');
function readBans() { try { return JSON.parse(fs.readFileSync(BAN_FILE, 'utf8')); } catch { return {}; } }
function saveBans(b) { fs.writeFileSync(BAN_FILE, JSON.stringify(b, null, 2)); }
function isBanned(username) {
  if (!username) return null;
  const bans = readBans();
  return bans[username.trim().toLowerCase()] || null;
}

// ── Ban per-IP + riwayat IP per-username ────────────────────────────────────────
// Ban username biasa (readBans di atas) gampang diakalin -- tinggal ganti username
// (login di sini gak pakai password). Ban IP nempel ke perangkat/jaringannya, jadi
// GANTI AKUN BERAPA KALI PUN tetap ketolak selama masih dari IP yang sama.
const IP_BAN_FILE = dataFile('ip_banlist.json');
function readIpBans() { try { return JSON.parse(fs.readFileSync(IP_BAN_FILE, 'utf8')); } catch { return {}; } }
function saveIpBans(b) { fs.writeFileSync(IP_BAN_FILE, JSON.stringify(b, null, 2)); }
// ::ffff:1.2.3.4 (bentuk IPv4-mapped IPv6, bisa muncul kalau server dengerin dual-stack)
// disamakan ke 1.2.3.4 -- biar IP yang sama gak kecatet 2 bentuk beda & lolos dari ban.
function normalizeIp(ip) { return (ip && ip.startsWith('::ffff:')) ? ip.slice(7) : ip; }
function isIpBanned(ip) {
  if (!ip) return null;
  return readIpBans()[normalizeIp(ip)] || null;
}
function banIp(ip, reason, viaUser) {
  if (!ip) return;
  const bans = readIpBans();
  bans[normalizeIp(ip)] = { reason: reason || 'Tidak disebutkan', bannedAt: getTime(), viaUser: viaUser || null };
  saveIpBans(bans);
}
function unbanIp(ip) {
  const bans = readIpBans();
  const key = normalizeIp(ip);
  if (!bans[key]) return false;
  delete bans[key];
  saveIpBans(bans);
  return true;
}

// Riwayat "username ini pernah kepakai dari IP mana aja" -- dibangun DIAM-DIAM tiap ada
// request/ping yang bawa username (lihat titik panggil recordUserIp di web & APK).
// Tujuannya: pas admin /ban seseorang, kita udah tau IP mana aja yang perlu ikut
// diblokir -- bukan cuma IP pas kejadian TERAKHIR, tapi semua yang pernah kepakai.
const USER_IPS_FILE = dataFile('user_ips.json');
function readUserIps() { try { return JSON.parse(fs.readFileSync(USER_IPS_FILE, 'utf8')); } catch { return {}; } }
function saveUserIps(d) { fs.writeFileSync(USER_IPS_FILE, JSON.stringify(d, null, 2)); }
function recordUserIp(username, ip) {
  if (!username || !ip) return;
  ip = normalizeIp(ip);
  const uname = username.trim().toLowerCase();
  if (!uname) return;
  const map  = readUserIps();
  const list = map[uname] || [];
  if (list[0] === ip) return; // udah yang paling depan, gak perlu nulis ulang tiap request
  map[uname] = [ip, ...list.filter(x => x !== ip)].slice(0, 15); // simpan 15 IP terakhir/user
  saveUserIps(map);
}
function getUserIps(username) {
  if (!username) return [];
  return readUserIps()[username.trim().toLowerCase()] || [];
}

const ANNOUNCE_FILE = dataFile('announce.json');
function readAnnounce() { try { return JSON.parse(fs.readFileSync(ANNOUNCE_FILE, 'utf8')); } catch { return null; } }
function saveAnnounce(a) { fs.writeFileSync(ANNOUNCE_FILE, JSON.stringify(a, null, 2)); }
function clearAnnounce() { try { fs.unlinkSync(ANNOUNCE_FILE); } catch {} }

const CHAT_MODE_FILE = dataFile('chat_mode.json');
function readChatMode() { try { return JSON.parse(fs.readFileSync(CHAT_MODE_FILE, 'utf8')); } catch { return { mode: 'group' }; } }
function writeChatMode(d) { fs.writeFileSync(CHAT_MODE_FILE, JSON.stringify(d, null, 2)); }

const REQ_STATUS_FILE = dataFile('req_status.json');
function readReqStatus() { try { return JSON.parse(fs.readFileSync(REQ_STATUS_FILE, 'utf8')); } catch { return {}; } }
function writeReqStatus(d) { fs.writeFileSync(REQ_STATUS_FILE, JSON.stringify(d, null, 2)); }

const OWNER_ID    = String(CFG.TELEGRAM_CHAT_ID);
const ADMINS_FILE = dataFile('admins.json');
function readAdmins()    { try { return JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf8')); } catch { return []; } }
function writeAdmins(d)  { fs.writeFileSync(ADMINS_FILE, JSON.stringify(d, null, 2)); }
function isOwner(id)     { return String(id) === OWNER_ID; }
function isAdmin(id)     { const s = String(id); return s === OWNER_ID || readAdmins().map(String).includes(s); }

const CLAIMS_FILE = dataFile('claims.json');
function readClaims()  { try { return JSON.parse(fs.readFileSync(CLAIMS_FILE, 'utf8')); } catch { return {}; } }
function saveClaims(d) { fs.writeFileSync(CLAIMS_FILE, JSON.stringify(d, null, 2)); }
function setClaim(id, actor) { const c = readClaims(); c[String(id)] = { ...actor, time: getTime() }; saveClaims(c); }
function removeClaim(id)     { const c = readClaims(); delete c[String(id)]; saveClaims(c); }
function getClaim(id)        { return readClaims()[String(id)] || null; }

const PINS_FILE = dataFile('pins.json');
function readPins()    { try { return JSON.parse(fs.readFileSync(PINS_FILE, 'utf8')); } catch { return []; } }
function savePins(d)   { fs.writeFileSync(PINS_FILE, JSON.stringify(d, null, 2)); }
function isPinned(id)  { return readPins().map(String).includes(String(id)); }

const AUDIT_FILE = dataFile('audit.json');
function readAudit()  { try { return JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8')); } catch { return []; } }
function writeAudit(actor, command) {
  const a = readAudit();
  a.unshift({ time: getTime(), id: actor.id, name: actor.name, command });
  if (a.length > 200) a.splice(200);
  fs.writeFileSync(AUDIT_FILE, JSON.stringify(a, null, 2));
}

const GROUP_OVERRIDE_FILE = dataFile('group_override.json');
function readGroupOverride() { try { return JSON.parse(fs.readFileSync(GROUP_OVERRIDE_FILE, 'utf8')); } catch { return { groupId: null }; } }
function writeGroupOverride(d) { fs.writeFileSync(GROUP_OVERRIDE_FILE, JSON.stringify(d, null, 2)); }
function activeGroupId() { return readGroupOverride().groupId || CFG.REQUEST_GROUP_ID; }

const OWNER_ONLY = new Set([
  '/appoff','/maintenance','/appon','/appstatus',
  '/offreq','/onreq','/reqstatus',
  '/announce','/clearannounce',
  '/export',
  '/ban','/unban','/banlist',
  '/setlimit','/addlimit','/resetlimit',
  '/addadmin','/removeadmin','/admins',
  '/note','/delreq','/search','/top','/stats','/checklimit',
  '/backup',
  '/privatonly','/grouponly',
  '/broadcast','/boardcastwa','/globalban','/purge','/resetalllimit',
  '/lockdown','/unlock',
  '/promote','/demote',
  '/listbackup','/getbackup',
  '/wipelogs','/wipetickets',
  '/setgroup','/auditlog','/version',
  '/genmobilekey','/mobiletokens','/revokemobilekey',
  '/setlimitreset',
  '/addwa',
  '/setopenapp1','/setcloseapp1',
  '/setopenapp2','/setcloseapp2',
  '/setopenapp3','/setcloseapp3',
  '/clearschedule1','/clearschedule2','/clearschedule3',
  '/clearallschedule','/listschedule',
  '/setmaxqueue',
  '/setsongslot1','/setsongslot2','/setsongslot3',
  '/clearsongslot1','/clearsongslot2','/clearsongslot3',
  '/clearallsongschedule','/listsongschedule',
  '/opensong','/closesong','/openbanner','/closebanner','/songstatus','/setgloballimit',
  '/pausebanner','/resumebanner',
  '/setrole','/listroles','/checkrole','/setwa',
  '/apkadduser','/apkdeluser','/apkextend','/apklist','/apkinfo','/apkkick','/apkstats',
  '/backupdb',
]);
function isOwnerOnly(text) { return OWNER_ONLY.has(text.toLowerCase().split(/\s/)[0]); }

const QUEUE_CONFIG_FILE = dataFile('queue_config.json');
function readQueueConfig() {
  try { return JSON.parse(fs.readFileSync(QUEUE_CONFIG_FILE, 'utf8')); }
  catch { return { maxSize: CFG.MAX_QUEUE_SIZE ?? 10 }; }
}
function writeQueueConfig(d) { fs.writeFileSync(QUEUE_CONFIG_FILE, JSON.stringify(d, null, 2)); }
function getMaxQueue() { return readQueueConfig().maxSize; }
function setMaxQueue(n) { writeQueueConfig({ maxSize: n }); }
function isQueueFull(logs) {
  const max = getMaxQueue();
  if (max === 0) return false;
  const pending = logs.filter(l => l.status === 'pending').length;
  return pending >= max;
}

module.exports = {
  readAppStatus, writeAppStatus,
  readLogs, saveLogs, writeLog, updateLogStatus, findEntry, LOGS_FILE,
  readTickets, saveTickets, makeTicketId, findTicket, findTicketByText, saveTicket, TICKETS_FILE,
  readBans, saveBans, isBanned,
  readIpBans, saveIpBans, isIpBanned, banIp, unbanIp,
  readUserIps, recordUserIp, getUserIps,
  readAnnounce, saveAnnounce, clearAnnounce,
  readChatMode, writeChatMode,
  readReqStatus, writeReqStatus,
  OWNER_ID, readAdmins, writeAdmins, isOwner, isAdmin,
  readClaims, saveClaims, setClaim, removeClaim, getClaim,
  readPins, savePins, isPinned,
  readAudit, writeAudit,
  readGroupOverride, writeGroupOverride, activeGroupId,
  OWNER_ONLY, isOwnerOnly,
  getMaxQueue, setMaxQueue, isQueueFull
};
