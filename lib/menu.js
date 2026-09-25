// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Menu — Teks & Navigasi Admin Panel Telegram          ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝


function menuNav(type, cur, total) {
  const row = [];
  if (cur > 1)     row.push({ text: '◀ Kembali',  callback_data: `menu:${type}:${cur - 1}`, style: 'primary' });
                   row.push({ text: `${cur} / ${total}`, callback_data: 'noop'       });
  if (cur < total) row.push({ text: 'Lanjut ▶',   callback_data: `menu:${type}:${cur + 1}`, style: 'primary' });
  return { inline_keyboard: [row, [{ text: '🏠 Pilih Menu Lain', callback_data: 'mtype:home', style: 'primary' }]] };
}

const MENU_HEADER = '🤖 <b>Admin Panel</b> — Roblox Request <i>by wanz</i>\n';
const MENU_SEP    = '┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n';


function getAdminMenuPage(page) {
  const pages = [

    MENU_HEADER + MENU_SEP +
    '🛠️ <b>ADMIN MENU — Request Dasar</b>\n\n' +
    '/list\n' +
    '/today\n' +
    '/queue\n' +
    '/detail id\n\n' +
    '/acc id\n' +
    '/tolak id\n' +
    '/pending id\n' +
    '/a id\n' +
    '/t id\n' +
    '/r id\n\n' +
    '/shortcuts\n' +
    '/mixing',

    MENU_HEADER + MENU_SEP +
    '🛠️ <b>ADMIN MENU — Klaim & Pin</b>\n\n' +
    '/claim id\n' +
    '/unclaim id\n' +
    '/whoclaim id\n' +
    '/myclaims\n\n' +
    '/pin id\n' +
    '/unpin id\n' +
    '/pinned\n\n' +
    '/remind id\n' +
    '/cancel id',

    MENU_HEADER + MENU_SEP +
    '🛠️ <b>ADMIN MENU — Statistik & Pencarian</b>\n\n' +
    '/lastacc\n' +
    '/lasttolak\n' +
    '/myinfo\n' +
    '/finduser username',

    MENU_HEADER + MENU_SEP +
    '🛠️ <b>ADMIN MENU — Tiket & Lainnya</b>\n\n' +
    '/tickets\n' +
    '/unreadtickets\n' +
    '/lastticket\n' +
    '/closetiket id\n\n' +
    '/uptime\n' +
    '/myid',

  ];
  return { text: pages[page - 1], keyboard: menuNav('admin', page, pages.length), total: pages.length };
}


function getOwnerMenuPage(page) {
  const pages = [

    MENU_HEADER + MENU_SEP +
    '👑 <b>OWN MENU — Limit & Moderasi</b>\n\n' +
    '/setlimit song|banner n\n' +
    '/addlimit user song|banner n\n' +
    '/resetlimit user\n' +
    '/resetalllimit\n' +
    '/checklimit user\n\n' +
    '/ban user\n' +
    '/unban user\n' +
    '/banlist\n' +
    '/globalban user',

    MENU_HEADER + MENU_SEP +
    '👑 <b>OWN MENU — App & Request Control</b>\n\n' +
    '<b>App</b>\n' +
    '/appoff\n' +
    '/maintenance\n' +
    '/appon\n' +
    '/appstatus\n\n' +
    '<b>Request</b>\n' +
    '/offreq lagu|banner\n' +
    '/onreq lagu|banner\n' +
    '/reqstatus\n' +
    '/lockdown\n' +
    '/unlock\n\n' +
    '<b>Jadwal & Kuota</b>\n' +
    '/setsongslot1\n' +
    '/clearsongslot1\n' +
    '/clearallsongschedule\n' +
    '/listsongschedule\n' +
    '/opensong\n' +
    '/closesong\n' +
    '/openbanner\n' +
    '/closebanner\n' +
    '/songstatus\n' +
    '/setgloballimit',

    MENU_HEADER + MENU_SEP +
    '👑 <b>OWN MENU — Pengumuman, Backup & Data</b>\n\n' +
    '<b>Pengumuman</b>\n' +
    '/announce\n' +
    '/clearannounce\n\n' +
    '<b>Backup</b>\n' +
    '/export\n' +
    '/backup\n' +
    '/listbackup\n' +
    '/getbackup nama_file\n\n' +
    '<b>Hapus Data</b>\n' +
    '/purge hari\n' +
    '/wipelogs confirm\n' +
    '/wipetickets confirm',

    MENU_HEADER + MENU_SEP +
    '👑 <b>OWN MENU — Broadcast, Grup & Mode Chat</b>\n\n' +
    '/broadcast\n' +
    '/boardcastwa\n' +
    '/privatonly\n' +
    '/grouponly\n' +
    '/setgroup',

    MENU_HEADER + MENU_SEP +
    '👑 <b>OWN MENU — Admin Management & Info Server</b>\n\n' +
    '/addadmin tele_id\n' +
    '/removeadmin tele_id\n' +
    '/admins\n' +
    '/promote tele_id\n' +
    '/demote tele_id\n\n' +
    '/auditlog\n' +
    '/version',

    MENU_HEADER + MENU_SEP +
    '👑 <b>OWN MENU — Role & APK (satu bot buat semua)</b>\n\n' +
    '<b>Role</b>\n' +
    '/setrole usn,display,role[,1d|2w|1m]\n' +
    '/ytstatus (status provider download YT)\n' +
    '/disk (pemakaian penyimpanan) · /cleartmp (bersihin file sementara)\n' +
    '/autoupload on|off · /autoshare on|off · /autoall on|off (mode otomatis; /autostatus)\n' +
    '/permtest [assetId] (diagnosa auto-grant izin audio)\n' +
    '/cekorder [username|trxId] (cek order VIP/VVIP + pulihkan yang sudah bayar) · /aktifkanorder &lt;trxId&gt;\n' +
    '/listroles\n' +
    '/checkrole user\n' +
    '/limitstats\n\n' +
    '<b>Manage Akun APK</b>\n' +
    '/apkadduser user\n' +
    '/apkdeluser user\n' +
    '/apkextend user hari\n' +
    '/apklist\n' +
    '/apkinfo user\n' +
    '/apkkick user\n' +
    '/apkstats\n\n' +
    '<b>Backup Database</b>\n' +
    '/backupdb',

    MENU_HEADER + MENU_SEP +
    '👑 <b>OWN MENU — Roblox Audio Upload</b>\n\n' +
    '<b>Upload</b>\n' +
    'Kirim audio/gambar langsung ke bot (atau reply file + /upload)\n\n' +
    '<b>Setelah Lolos Moderasi</b>\n' +
    'Tap tombol ✅ Done setelah kasih izin manual → auto share ke saluran WA\n\n' +
    '<b>Cek & Kelola</b>\n' +
    '/uploadpending\n' +
    '/id\n' +
    '/links\n' +
    '/cek\n' +
    '/premision\n' +
    '/premision force\n' +
    '/rejectremove\n\n' +
    '<b>Debug</b>\n' +
    '/grantid assetId\n' +
    '/checkid assetId',

  ];
  return { text: pages[page - 1], keyboard: menuNav('owner', page, pages.length), total: pages.length };
}

module.exports = { menuNav, MENU_HEADER, MENU_SEP, getAdminMenuPage, getOwnerMenuPage };
