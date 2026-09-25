// ╔═══════════════════════════════════════════════════════════╗
// ║                                                           ║
// ║        Scheduler — Jadwal Buka/Tutup App Otomatis         ║
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
const { readAppStatus, writeAppStatus } = require('./store');
const { sendMessage }  = require('./telegram');

const ROOT = path.join(__dirname, '..');
const SCHEDULE_FILE = dataFile('schedule.json');
const MAX_SLOTS = 3;

function readSchedule() {
  try { return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); } catch { return []; }
}
function saveSchedule(d) { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(d, null, 2)); }

function getSlot(schedules, slot) {
  return schedules.find(s => s.slot === slot) || null;
}

function setSlotTime(slot, field, timeStr) {
  const schedules = readSchedule();
  let entry = schedules.find(s => s.slot === slot);
  if (!entry) {
    entry = { slot, openTime: null, closeTime: null };
    schedules.push(entry);
    schedules.sort((a, b) => a.slot - b.slot);
  }
  entry[field] = timeStr;
  saveSchedule(schedules);
  return entry;
}

function clearSlot(slot) {
  const schedules = readSchedule().filter(s => s.slot !== slot);
  saveSchedule(schedules);
}

function clearAll() { saveSchedule([]); }

function fmtSlot(s) {
  const open  = s.openTime  ? `🟢 Buka  : <b>${s.openTime}</b> WIB`  : '🟢 Buka  : —';
  const close = s.closeTime ? `🔴 Tutup : <b>${s.closeTime}</b> WIB` : '🔴 Tutup : —';
  return `<b>Jadwal ${s.slot}</b>\n${open}\n${close}`;
}

function getNowWIB() {
  const now = new Date();
  const wib = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  const h = String(wib.getHours()).padStart(2, '0');
  const m = String(wib.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function startScheduler() {
  setInterval(async () => {
    const nowTime  = getNowWIB();
    const schedules = readSchedule();
    const appStatus = readAppStatus();

    for (const s of schedules) {
      if (s.openTime && s.openTime === nowTime && appStatus.mode !== 'online') {
        writeAppStatus({ mode: 'online' });
        sendMessage(
          `🟢 <b>Jadwal ${s.slot} — App dibuka otomatis</b>\n` +
          `Waktu : <b>${nowTime} WIB</b>`
        ).catch(() => {});
        console.log(`[Scheduler] Slot ${s.slot} → buka app jam ${nowTime} WIB`);
      }

      if (s.closeTime && s.closeTime === nowTime && appStatus.mode === 'online') {
        writeAppStatus({ mode: 'offline', message: 'App sedang offline — akan dibuka kembali sesuai jadwal.' });
        sendMessage(
          `🔴 <b>Jadwal ${s.slot} — App ditutup otomatis</b>\n` +
          `Waktu : <b>${nowTime} WIB</b>`
        ).catch(() => {});
        console.log(`[Scheduler] Slot ${s.slot} → tutup app jam ${nowTime} WIB`);
      }
    }
  }, 60 * 1000);

  console.log('  Scheduler jadwal app aktif');
}

module.exports = { startScheduler, readSchedule, saveSchedule, setSlotTime, clearSlot, clearAll, fmtSlot, MAX_SLOTS };
