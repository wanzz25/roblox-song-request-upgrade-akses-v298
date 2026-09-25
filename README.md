# Roblox Song Request — by wanz

Website request lagu Roblox yang terhubung ke Telegram.

---

## Setup

### 1. Buat Telegram Bot

1. Chat `@BotFather` di Telegram
2. Ketik `/newbot`, ikuti instruksi, salin **Bot Token**
3. Kirim pesan ke bot kamu, lalu buka:
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Salin nilai `chat.id` dari response JSON

### 2. Edit `config.js`

Buka file `config.js` dan isi token serta chat ID kamu:

```js
TELEGRAM_BOT_TOKEN: 'isi_token_bot_kamu_disini',
TELEGRAM_CHAT_ID:   'isi_chat_id_kamu_disini',
```

Port tidak perlu diubah — otomatis diambil dari Pterodactyl.

### 3. Install & Jalankan

```bash
npm install
npm start
```

---

## Pterodactyl Egg (Node.js)

- **Startup Command:** `npm install && npm start`
- **Docker Image:** `node:20-alpine`
- Port dideteksi otomatis dari `SERVER_PORT` yang diinjeksi Pterodactyl

---

*— by wanz*
