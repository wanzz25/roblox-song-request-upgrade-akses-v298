// ╔═══════════════════════════════════════════════════════════╗
// ║   Upload Jobs — antrian upload Roblox yang TAHAN RESTART    ║
// ║                                                           ║
// ║   Tiap kali admin menekan "⬆️ Upload ke Roblox" di kartu    ║
// ║   request, 1 job dicatat di roblox_upload_jobs.json SEBELUM  ║
// ║   proses dimulai, lalu di-update tiap ada kemajuan (asset    ║
// ║   sudah dibuat di Roblox, klip video ke-N sudah terupload).  ║
// ║   Kalau server restart di tengah jalan, job yang belum       ║
// ║   selesai dilanjutkan otomatis dari titik terakhir           ║
// ║   (lihat resumeUploadJobs di bot/robloxAudioRequest.js).     ║
// ║                                                           ║
// ║   Developer  : wanz                                       ║
// ╚═══════════════════════════════════════════════════════════╝

const fs   = require('fs');
const path = require('path');

const { dataFile } = require('./dataPaths');
const JOBS_FILE = dataFile('roblox_upload_jobs.json');

function loadJobs() {
  try {
    const parsed = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { return []; }
}

// Tulis atomik (.tmp lalu rename) -- kalau proses mati pas lagi nulis, file
// job gak pernah kebaca setengah jadi.
function saveJobs(list) {
  const tmp = JOBS_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, JOBS_FILE);
  } catch (e) { console.error('[uploadJobs] Gagal simpan roblox_upload_jobs.json:', e.message); }
}

const same = (a, b) => String(a) === String(b);

function getJob(requestId) {
  return loadJobs().find((j) => same(j.requestId, requestId)) || null;
}

function addJob(job) {
  const list = loadJobs().filter((j) => !same(j.requestId, job.requestId));
  list.push({ attempts: 0, createdAt: Date.now(), ...job });
  saveJobs(list);
}

function updateJob(requestId, patch) {
  const list = loadJobs();
  const job = list.find((j) => same(j.requestId, requestId));
  if (!job) return null;
  Object.assign(job, patch);
  saveJobs(list);
  return job;
}

function removeJob(requestId) {
  const list = loadJobs();
  const next = list.filter((j) => !same(j.requestId, requestId));
  if (next.length !== list.length) saveJobs(next);
}

module.exports = { JOBS_FILE, loadJobs, getJob, addJob, updateJob, removeJob };
