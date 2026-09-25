// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Roblox Request — API Router (mobile/APK)           ║
// ║                                                           ║
// ║   Dulu ini proses Node terpisah (api/index.js, port       ║
// ║   sendiri). Sekarang di-mount jadi router di server.js     ║
// ║   yang SAMA dengan panel (di path /mobile-api), soalnya    ║
// ║   hosting sewaan biasanya cuma kasih 1 allocation/port     ║
// ║   per server — jadi gak perlu server/port kedua lagi.      ║
// ║   APK akses lewat: <domain-website>/mobile-api/...         ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝

const CFG     = require('./config');
const { roleTitle, getDisplayName } = require('../lib/roles');
const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const fetch   = require('node-fetch');
const FormData = require('form-data');
const multer  = require('multer');

const router = express.Router();

// Catatan: express.json()/urlencoded() dan header CORS udah di-apply secara
// global di server.js (parent app), jadi gak perlu diulang di sini.

// Data akun & sesi login sekarang di database/api/ (lihat lib/dataPaths.js) -- bukan lagi di folder api/.
const { dataFile } = require('../lib/dataPaths');
const DB_FILE   = dataFile('api/database.json');
const KEYS_FILE = dataFile('api/keyList.json');

function loadDB()   { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }   catch { return []; } }
function saveDB(d)  { fs.writeFileSync(DB_FILE,   JSON.stringify(d,  null, 2)); }
function loadKeys() { try { return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch { return []; } }
function saveKeys(d){ fs.writeFileSync(KEYS_FILE, JSON.stringify(d,  null, 2)); }

function genKey() { return 'rsk_' + crypto.randomBytes(20).toString('hex'); }

function getTime() {
  return new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'full', timeStyle: 'short' });
}

function isExpired(user) {
  if (!user.expiredDate) return false;
  return new Date(user.expiredDate) < new Date();
}

function validateSession(key) {
  if (!key) return null;
  const keys = loadKeys();
  const entry = keys.find(k => k.sessionKey === key);
  if (!entry) return null;
  const db = loadDB();
  const user = db.find(u => u.username === entry.username);
  if (!user || isExpired(user)) return null;
  entry.lastUsed = new Date().toISOString();
  saveKeys(keys);
  return { user, entry };
}

function sessionMiddleware(req, res, next) {
  const key = req.headers['x-session-key'] || req.query.sessionKey;
  const result = validateSession(key);
  if (!result) return res.status(401).json({ valid: false, message: 'Session tidak valid atau sudah expired. Silakan login ulang.' });
  req.apiUser = result.user;
  req.apiEntry = result.entry;
  next();
}

// Panel sekarang ada di proses YANG SAMA (server.js) -> panggil lewat
// localhost, gak perlu domain publik buat komunikasi internal ini.
const SELF_PORT = process.env.SERVER_PORT || process.env.PORT || 3000;
const PANEL = (CFG.PANEL_URL || `http://localhost:${SELF_PORT}`).replace(/\/$/, '');
const MOB_HEADERS = {
  'x-mobile-key': CFG.PANEL_MOBILE_TOKEN,
  'Content-Type': 'application/json'
};

async function panelGet(p) {
  const url = PANEL + p;
  const r = await fetch(url, { headers: MOB_HEADERS, signal: AbortSignal.timeout(12000) });
  return r.json();
}

async function panelPost(p, body) {
  const r = await fetch(PANEL + p, {
    method: 'POST',
    headers: MOB_HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000)
  });
  return r.json();
}

const mUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ─── LOGIN ───────────────────────────────────────────────────────────────────
router.post('/validate', (req, res) => {
  const { username, androidId } = req.body;
  if (!username) return res.json({ valid: false, message: 'username wajib diisi.' });
  const cleanUsername = username.trim().replace(/\s+/g, '_');
  if (!cleanUsername) return res.json({ valid: false, message: 'username wajib diisi.' });

  const db  = loadDB();
  let user = db.find(u => u.username.toLowerCase() === cleanUsername.toLowerCase());

  // Persis kayak website: gak perlu didaftarin admin dulu, ketik username apa
  // aja langsung kepake (auto-register). expiredDate dikosongin -> gak pernah
  // expired, sama kayak akun web yang cuma nyimpen username di localStorage.
  if (!user) {
    user = { username: cleanUsername, role: 'member', expiredDate: null };
    db.push(user);
    saveDB(db);
  }

  if (isExpired(user)) return res.json({ valid: true, expired: true, message: 'Akun kamu sudah expired. Hubungi owner.' });

  const key     = genKey();
  const expires = new Date(Date.now() + CFG.SESSION_DURATION_MS).toISOString();

  const keys = loadKeys();
  const idx  = keys.findIndex(k => k.username === cleanUsername);
  const entry = { username: cleanUsername, sessionKey: key, androidId: androidId || null, expires, lastLogin: new Date().toISOString(), lastUsed: null };
  if (idx !== -1) keys[idx] = entry; else keys.push(entry);
  saveKeys(keys);

  return res.json({
    valid      : true,
    expired    : false,
    sessionKey : key,
    expires,
    role       : user.role || 'member',
    expiredDate: user.expiredDate || null
  });
});

// ─── INFO SESI ───────────────────────────────────────────────────────────────
router.get('/myInfo', sessionMiddleware, (req, res) => {
  const u = req.apiUser;
  res.json({
    valid      : true,
    username   : u.username,
    role       : u.role || 'member',
    expiredDate: u.expiredDate || null,
    expired    : isExpired(u)
  });
});

// ─── PANEL PROXY ─────────────────────────────────────────────────────────────
router.get('/ping', sessionMiddleware, async (req, res) => {
  try {
    const d = await panelGet('/api/mobile/ping?username=' + encodeURIComponent(req.apiUser.username));
    res.json({ ...d, apiOk: true, apiUser: req.apiUser.username });
  } catch (e) {
    res.json({ success: false, apiOk: false, message: 'Panel tidak dapat dijangkau: ' + e.message });
  }
});

router.get('/limits', sessionMiddleware, async (req, res) => {
  const { username } = req.apiUser;
  try { res.json(await panelGet('/api/mobile/limits?username=' + encodeURIComponent(username))); }
  catch { res.status(503).json({ success: false, message: 'Panel tidak dapat dijangkau.' }); }
});

router.get('/myrequests', sessionMiddleware, async (req, res) => {
  const { username } = req.apiUser;
  try { res.json(await panelGet('/api/mobile/myrequests?username=' + encodeURIComponent(username))); }
  catch { res.status(503).json({ success: false, message: 'Panel tidak dapat dijangkau.' }); }
});

router.get('/track/:id', sessionMiddleware, async (req, res) => {
  try { res.json(await panelGet('/api/mobile/track/' + req.params.id)); }
  catch { res.status(503).json({ success: false, message: 'Panel tidak dapat dijangkau.' }); }
});

router.post('/request', sessionMiddleware, mUpload.single('song_file'), async (req, res) => {
  const { username } = req.apiUser;
  try {
    const form = new FormData();
    form.append('username', username);
    Object.entries(req.body).forEach(([k, v]) => { if (v) form.append(k, v); });
    if (req.file) form.append('song_file', req.file.buffer, { filename: req.file.originalname, contentType: req.file.mimetype });
    const r = await fetch(PANEL + '/api/mobile/request', {
      method: 'POST',
      headers: { 'x-mobile-key': CFG.PANEL_MOBILE_TOKEN, ...form.getHeaders() },
      body: form,
      signal: AbortSignal.timeout(30000)
    });
    res.json(await r.json());
  } catch (e) { res.status(503).json({ success: false, message: 'Panel tidak dapat dijangkau: ' + e.message }); }
});

router.post('/banner', sessionMiddleware, mUpload.single('banner_image'), async (req, res) => {
  const { username } = req.apiUser;
  try {
    const form = new FormData();
    form.append('username', username);
    Object.entries(req.body).forEach(([k, v]) => { if (v) form.append(k, v); });
    if (req.file) form.append('banner_image', req.file.buffer, { filename: req.file.originalname, contentType: req.file.mimetype });
    const r = await fetch(PANEL + '/api/mobile/banner', {
      method: 'POST',
      headers: { 'x-mobile-key': CFG.PANEL_MOBILE_TOKEN, ...form.getHeaders() },
      body: form,
      signal: AbortSignal.timeout(30000)
    });
    res.json(await r.json());
  } catch (e) { res.status(503).json({ success: false, message: 'Panel tidak dapat dijangkau: ' + e.message }); }
});

router.post('/req/:id/rating', sessionMiddleware, async (req, res) => {
  try { res.json(await panelPost('/api/mobile/request/' + req.params.id + '/rating', req.body)); }
  catch { res.status(503).json({ success: false, message: 'Panel tidak dapat dijangkau.' }); }
});

router.get('/ticket/:id', sessionMiddleware, async (req, res) => {
  try { res.json(await panelGet('/api/mobile/ticket/' + req.params.id)); }
  catch { res.status(503).json({ success: false, message: 'Panel tidak dapat dijangkau.' }); }
});

router.post('/ticket', sessionMiddleware, async (req, res) => {
  const { username } = req.apiUser;

  // Generalisasi getDisplayNameWithTitle(): SIAPA AJA yang di-/setrole dengan
  // displayname custom (nama rahasia) bakal tampil pakai nama itu ke admin,
  // username LOGIN aslinya gak ikut ditampilkan sama sekali. Kalau gak ada
  // displayname custom, tampil apa adanya + titel role di belakangnya.
  const displayName = getDisplayName(username);
  const title = roleTitle(username); // null kalau role-nya 'member'
  const isHidden = displayName.toLowerCase() !== username?.toLowerCase();

  let payload;
  if (isHidden) {
    payload = { name: title ? `${displayName} (${title})` : displayName, username: null, ...req.body };
  } else if (title) {
    payload = { name: `${username} (${title})`, username, ...req.body };
  } else {
    payload = { name: username, username, ...req.body };
  }

  try { res.json(await panelPost('/api/mobile/ticket', payload)); }
  catch { res.status(503).json({ success: false, message: 'Panel tidak dapat dijangkau.' }); }
});

router.post('/ticket/:id/message', sessionMiddleware, async (req, res) => {
  try { res.json(await panelPost('/api/mobile/ticket/' + req.params.id + '/message', req.body)); }
  catch { res.status(503).json({ success: false, message: 'Panel tidak dapat dijangkau.' }); }
});

router.post('/ticket/:id/close', sessionMiddleware, async (req, res) => {
  try { res.json(await panelPost('/api/mobile/ticket/' + req.params.id + '/close', {})); }
  catch { res.status(503).json({ success: false, message: 'Panel tidak dapat dijangkau.' }); }
});

router.get('/yt/search', sessionMiddleware, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ success: false, message: 'Query kosong.' });
  try { res.json(await panelGet('/api/yt/search?q=' + encodeURIComponent(q))); }
  catch (e) { res.status(503).json({ success: false, message: 'Panel tidak dapat dijangkau: ' + e.message }); }
});

// ─── TIKET PUBLIK (tanpa login, persis .tk-fab di login.html) ───────────────
// Website punya tombol chat CS yang "selalu aktif walau belum login/maintenance".
// Endpoint ini forward LANGSUNG ke /api/ticket versi web (bukan /api/mobile/ticket
// yang butuh session), jadi APK bisa nyediain fitur yang sama persis di layar Login.
router.post('/public/ticket', async (req, res) => {
  try { res.json(await panelPost('/api/ticket', req.body)); }
  catch { res.status(503).json({ success: false, message: 'Panel tidak dapat dijangkau.' }); }
});

router.get('/public/ticket/:id', async (req, res) => {
  try { res.json(await panelGet('/api/ticket/' + req.params.id)); }
  catch { res.status(503).json({ success: false, message: 'Panel tidak dapat dijangkau.' }); }
});

router.post('/public/ticket/:id/message', async (req, res) => {
  try { res.json(await panelPost('/api/ticket/' + req.params.id + '/message', req.body)); }
  catch { res.status(503).json({ success: false, message: 'Panel tidak dapat dijangkau.' }); }
});

router.get('/announce', async (req, res) => {
  try { res.json(await panelGet('/api/announce')); }
  catch { res.status(503).json({ success: false, message: 'Panel tidak dapat dijangkau.' }); }
});

router.get('/health', (req, res) => {
  const db = loadDB();
  res.json({
    status : 'ok',
    time   : getTime(),
    users  : db.length,
    uptime : Math.floor(process.uptime()) + 's',
    mode   : 'merged-with-panel'
  });
});

// ─── ADMIN ENDPOINTS ─────────────────────────────────────────────────────────
// Dipanggil dari bot panel utama (bot/messages.js: /apkadduser, /apkdeluser,
// /apkextend, /apklist, /apkinfo, /apkkick, /apkstats) lewat HTTP localhost,
// dilindungi header x-admin-key yang harus sama persis dengan CFG.PANEL_MOBILE_TOKEN.
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== CFG.PANEL_MOBILE_TOKEN) {
    return res.status(401).json({ success: false, message: 'x-admin-key tidak valid.' });
  }
  next();
}

router.get('/admin/users', adminAuth, (req, res) => {
  res.json({ success: true, users: loadDB() });
});

router.post('/admin/users', adminAuth, (req, res) => {
  const { username, days, role } = req.body;
  if (!username) return res.status(400).json({ success: false, message: 'username wajib diisi.' });
  const db = loadDB();
  if (db.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.json({ success: false, message: `Username ${username} sudah ada.` });
  }
  const entry = { username, role: role || 'member', expiredDate: null };
  if (days) { const exp = new Date(); exp.setDate(exp.getDate() + parseInt(days)); entry.expiredDate = exp.toISOString().split('T')[0]; }
  db.push(entry);
  saveDB(db);
  res.json({ success: true, user: entry });
});

router.post('/admin/users/:username/extend', adminAuth, (req, res) => {
  const db   = loadDB();
  const user = db.find(u => u.username === req.params.username);
  if (!user) return res.json({ success: false, message: 'User tidak ditemukan.' });
  const base = user.expiredDate ? new Date(user.expiredDate) : new Date();
  base.setDate(base.getDate() + parseInt(req.body.days || 0));
  user.expiredDate = base.toISOString().split('T')[0];
  saveDB(db);
  res.json({ success: true, expiredDate: user.expiredDate });
});

router.delete('/admin/users/:username', adminAuth, (req, res) => {
  const db  = loadDB();
  const idx = db.findIndex(u => u.username === req.params.username);
  if (idx === -1) return res.json({ success: false, message: 'User tidak ditemukan.' });
  db.splice(idx, 1);
  saveDB(db);
  saveKeys(loadKeys().filter(k => k.username !== req.params.username));
  res.json({ success: true });
});

router.post('/admin/users/:username/kick', adminAuth, (req, res) => {
  saveKeys(loadKeys().filter(k => k.username !== req.params.username));
  res.json({ success: true });
});

router.get('/admin/users/:username', adminAuth, (req, res) => {
  const user = loadDB().find(u => u.username === req.params.username);
  if (!user) return res.json({ success: false, message: 'User tidak ditemukan.' });
  const sess = loadKeys().find(k => k.username === req.params.username);
  res.json({ success: true, user, session: sess || null, expired: isExpired(user) });
});

router.get('/admin/stats', adminAuth, (req, res) => {
  const db   = loadDB();
  const keys = loadKeys();
  const now  = new Date();
  const active = keys.filter(k => {
    const u = db.find(u => u.username === k.username);
    return u && !isExpired(u) && k.expires && new Date(k.expires) > now;
  }).length;
  const roles = {};
  db.forEach(u => { const r = u.role || 'member'; roles[r] = (roles[r] || 0) + 1; });
  res.json({ success: true, totalUsers: db.length, activeSessions: active, roles, uptime: Math.floor(process.uptime()) });
});

module.exports = router;
