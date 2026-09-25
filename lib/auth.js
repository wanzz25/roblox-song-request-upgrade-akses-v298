// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Auth — Middleware Admin Key                          ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝

const CFG = require('../config');

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!key || key !== CFG.ADMIN_KEY) {
    return res.status(401).json({ success: false, message: 'Akses ditolak. Admin key salah atau belum login.' });
  }
  next();
}

module.exports = { requireAdmin };
