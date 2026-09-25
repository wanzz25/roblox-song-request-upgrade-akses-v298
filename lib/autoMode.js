// ╔═══════════════════════════════════════════════════════════╗
// ║   Auto Mode — otomatis upload / share, bisa di-ON/OFF-kan   ║
// ║   lewat Telegram:                                          ║
// ║      /autoupload on|off   /autoshare on|off   /autoall on|off ║
// ║                                                           ║
// ║   • autoupload : request baru (dari web/APK) langsung         ║
// ║                  di-upload ke Roblox TANPA admin menekan     ║
// ║                  tombol "⬆️ Upload ke Roblox".               ║
// ║   • autoshare  : begitu upload selesai & lolos moderasi,      ║
// ║                  hasilnya LANGSUNG dibagikan (VIP/VVIP ->    ║
// ║                  "ID Saya", user biasa -> saluran WA)        ║
// ║                  TANPA menekan tombol "Done / Share".        ║
// ║   • izin (auto-grant permission) SELALU otomatis -- bukan     ║
// ║     bagian dari mode ini.                                    ║
// ║   Default: dua-duanya OFF (perilaku manual seperti biasa).    ║
// ║   Disimpan di database/auto_mode.json (ikut backup).          ║
// ╚═══════════════════════════════════════════════════════════╝

const fs = require('fs');
const { dataFile } = require('./dataPaths');

const FILE = dataFile('auto_mode.json');
const DEFAULT = { upload: false, share: false };

function getAutoMode() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { upload: !!j.upload, share: !!j.share, updatedAt: j.updatedAt || null, updatedBy: j.updatedBy || null };
  } catch {
    return { ...DEFAULT, updatedAt: null, updatedBy: null };
  }
}

// patch: { upload?: bool, share?: bool }. Tulis atomik. Balikin mode terbaru.
function setAutoMode(patch, actorName = null) {
  const cur = getAutoMode();
  const next = {
    upload: patch.upload === undefined ? cur.upload : !!patch.upload,
    share:  patch.share  === undefined ? cur.share  : !!patch.share,
    updatedAt: new Date().toISOString(),
    updatedBy: actorName || null,
  };
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, FILE);
  return next;
}

module.exports = { getAutoMode, setAutoMode, AUTO_MODE_FILE: FILE };
