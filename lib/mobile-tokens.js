// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Mobile Tokens — API Key Manajemen APK              ║
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
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const TOKENS_FILE = dataFile('mobile_tokens.json');

function readTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch { return {}; }
}
function saveTokens(d) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(d, null, 2));
}

function generateToken() {
  return 'wmob_' + crypto.randomBytes(24).toString('hex');
}

function createToken(label) {
  const tokens = readTokens();
  const key = generateToken();
  tokens[key] = {
    label   : label || 'APK Token',
    created : new Date().toISOString(),
    lastUsed: null,
    active  : true
  };
  saveTokens(tokens);
  return { key, ...tokens[key] };
}

function validateToken(key) {
  if (!key) return false;
  const tokens = readTokens();
  const t = tokens[String(key)];
  if (!t || !t.active) return false;
  t.lastUsed = new Date().toISOString();
  saveTokens(tokens);
  return true;
}

function revokeToken(key) {
  const tokens = readTokens();
  if (!tokens[key]) return false;
  tokens[key].active = false;
  saveTokens(tokens);
  return true;
}

function listTokens() {
  return Object.entries(readTokens()).map(([key, v]) => ({
    key,
    label   : v.label,
    created : v.created,
    lastUsed: v.lastUsed,
    active  : v.active
  }));
}

module.exports = { createToken, validateToken, revokeToken, listTokens, TOKENS_FILE };
