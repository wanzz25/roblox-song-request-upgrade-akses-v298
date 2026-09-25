// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Roblox Song Request — API Eksternal                ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ║   By         : wanz                                       ║
// ║   Copyright  : © 2026 wanz. All Rights Reserved.         ║
// ║   Website    : https://copyright.by-wanzz.my.id/        ║
// ║                                                           ║
// ╚═══════════════════════════════════════════════════════════╝

module.exports = {

  TELEGRAM_BASE: 'https://api.telegram.org',

  // Search lagu (fitur "CARI LAGU DI YOUTUBE") -- diganti ke API nanzz (ytmusic).
  // Synoxcloud & provider search lama sudah dihapus total dari project ini.
  NANZZ_YTMUSIC_SEARCH: 'https://api-nanzz.my.id/docs/api/search/ytmusic.php',

  // Dipakai KHUSUS buat fitur lirik (/api/lyrics) & auto-fetch judul dari
  // link (/api/yt/filename) -- beda fitur dari search di atas, jangan dihapus.
  DANZY_SEARCH_PLAY: 'https://api.danzy.web.id/api/search/play',

  // Provider download YTMP3 (2026-08-13) -- Nanzz & Danzy-ytmp3 dihapus,
  // Neosoft & Kyzznekoo TETAP AKTIF (masih jalan bagus), Clutch paling utama.
  CLUTCH_YT_MP3:            'https://api.clutch.web.id/download/ytmp3?apikey=alip-ci0nxjmenpdj213gsrah',
  NEOSOFT_YT_DOWNLOADER:    'https://api.neosoft.best/api/downloader/youtube',
  KYZZNEKOO_DOWNLOADER:     'https://api.kyzznekoo.my.id/api/downloader/ytmp3',
  // AlwaysCodex (2026-09-20): path yang BENAR pakai huruf "v" -> youtubev1..v4.
  // (Dulu ditulis /youtube2 & /youtube3 tanpa "v" -> selalu error/404.)
  //   v1: ?url=<yt>&quality=mp3      v2: ?url=<yt>
  //   v3: ?url=<yt>&json=0           v4: ?url=<yt>
  ALWAYSCODEX_YOUTUBE_V1:   'https://api.alwayscodex.eu.cc/api/downloader/youtubev1',
  ALWAYSCODEX_YOUTUBE_V2:   'https://api.alwayscodex.eu.cc/api/downloader/youtubev2',
  ALWAYSCODEX_YOUTUBE_V3:   'https://api.alwayscodex.eu.cc/api/downloader/youtubev3',
  ALWAYSCODEX_YOUTUBE_V4:   'https://api.alwayscodex.eu.cc/api/downloader/youtubev4',
  XYLOAPI_YOUTUBE:          'https://xyloapi.qzz.io/api/downloader/youtube',
  JEREXD_YOUTUBE:           'https://api.jerexd.my.id/api/downloader/youtube?apikey=jere_HjqKxU3gnmqP',
  // Sylvatica (2026-09-25): sekarang POOL multi-apikey, bukan 1 apikey lagi --
  // lihat SYLVATICA_KEY_POOL di lib/audio.js buat cara pakainya. Base URL SAMA
  // buat semua apikey, cuma parameter apikey=... yang beda per key. Tambah
  // apikey baru cukup tambah 1 baris string di array SYLVATICA_API_KEYS,
  // GAK PERLU ubah kode di manapun lagi.
  // GET /api/download/ytmp3?url=<yt>&apikey=<key>
  SYLVATICA_YTMP3_BASE:     'https://sylvatica.my.id/api/download/ytmp3',
  SYLVATICA_API_KEYS: [
    'wanzzReq3368',
    // 'apikey-sylvatica-lain-di-sini',  <- tambah baris kayak gini kalau punya apikey lain
  ],
  // FAA (2026-09-20): GET /faa/ytmp3?url=<yt>  (tanpa apikey)
  FAA_YTMP3:                'https://api-faa.my.id/faa/ytmp3',
  // Xyurei (2026-09-20) -- 2 endpoint: ytmp3 (v1) & ytmp3v2. Kunci "free" yang sama buat dua-duanya.
  XYUREI_APIKEY:            'xyureifree-ecc06',
  XYUREI_YTMP3:             'https://www.api-xyurei.my.id/api/download/ytmp3',
  XYUREI_YTMP3_V2:          'https://www.api-xyurei.my.id/api/download/ytmp3v2',
  TERMAI_BASE:              'https://api.termai.cc',
  TERMAI_APIKEY:            'Trial-jXt6OOGEnFyQSMEF',
  MEDIADOWNLOADER_BASE:     'https://mediadownloader.web.id/api/download', // POST JSON {url}, beda dari provider lain yang GET

  YOUTUBE_OEMBED: 'https://www.youtube.com/oembed',

  TURNSTILE_VERIFY: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',

  // Auto-order VVIP via QRIS -- lihat lib/buatqris.js & routes/vvip.js.
  BUATQRIS_BASE: 'https://api.buatqris.site',

};
