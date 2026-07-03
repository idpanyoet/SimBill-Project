'use strict';
// ===========================================================================
// olt-alert.js — Notifikasi Telegram gangguan ONU (DyingGasp/LOS).
// - Poll state ONU tiap POLL_MS, deteksi transisi online -> offline.
// - Cuma alert kalau penyebabnya DyingGasp / LOS (gangguan beneran),
//   bukan reboot/dimatiin manual.
// - Massal-aware: kalau >= MASS_THRESHOLD ONU offline barengan (mati lampu
//   area / fiber putus), ringkas jadi 1 alert, bukan spam per-ONU.
// - Kirim via telegram.kirim() ke chat teknisi (toggle tg_ev_olt).
//   TIDAK mengubah services/telegram.js.
//
// Wire di server.js:  require('./services/olt-alert').start();
// ===========================================================================

const fs = require('fs');
const path = require('path');
const olt = require('./olt');
const tg = require('./telegram');
let db = null;
try { db = require('../config/db'); } catch (e) { db = null; }

const POLL_MS = 120000;        // 2 menit
const MASS_THRESHOLD = 5;      // >= sekian offline barengan = alert massal
const CAUSE_RE = /dying\s*gasp|dyinggasp|los[i]?\b|loss\s*of\s*signal/i;
// Pisahkan penyebab agar bisa di-filter terpisah:
//   DyingGasp = ONU mati daya (sering kedip → spam, dimatikan)
//   LOS       = loss of signal (gangguan fiber/redaman → tetap dialertkan)
const DYINGGASP_RE = /dying\s*gasp|dyinggasp/i;
const LOS_RE       = /los[i]?\b|loss\s*of\s*signal/i;
const STATE_FILE = path.join(__dirname, '..', 'config', '.olt-alert-state.json');

let _timer = null;
let _prev = null;              // { oltId: { index: online(bool) } }

// ── util ──
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return null; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) {}
}
function jam() {
  return new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
}
function esc(s) { return String(s == null ? '' : s); }

// Cek apakah alert OLT aktif + ambil chat tujuan (teknisi, fallback owner)
async function alertTarget() {
  const cfg = await tg.getCfg();
  if (!cfg || cfg.tg_enabled !== '1') return null;       // master switch Telegram
  if (cfg.tg_ev_olt === '0') return null;                // toggle khusus OLT (default ON)
  return cfg.tg_chat_teknisi || cfg.tg_chat_owner || null;
}

// Ambil data pelanggan utk sekumpulan index (1 query)
async function pelangganFor(oltId, indexes) {
  const map = {};
  if (!db || !indexes.length) return map;
  const ph = indexes.map(() => '?').join(',');
  const rows = await db.query(
    `SELECT l.onu_index, l.onu_name, l.sn, p.id AS pid, p.nama, p.username, p.status, p.tgl_expired, p.alamat
       FROM olt_link l LEFT JOIN pelanggan p ON p.id = l.pelanggan_id
      WHERE l.olt_id = ? AND l.onu_index IN (${ph})`,
    [oltId, ...indexes]
  ).catch(() => []);
  for (const r of rows) map[r.onu_index] = r;
  return map;
}

function billPill(r) {
  if (!r || !r.pid) return '';
  let st = 'aktif';
  try {
    const b = olt.billingStatus({ status: r.status, tgl_expired: r.tgl_expired });
    if (b && b.state) st = b.state;
  } catch (e) {}
  const m = { aktif: '✅ Aktif', nunggak: '⚠️ Nunggak', isolir: '🔒 Isolir', nonaktif: '⚫ Nonaktif' };
  const exp = r.tgl_expired ? ` (exp ${String(r.tgl_expired).slice(0, 10)})` : '';
  return (m[st] || st) + exp;
}

function namaOnu(r, index) {
  if (r && r.pid) return `${esc(r.nama)} (@${esc(r.username || '-')})`;
  if (r && r.onu_name) return `${esc(r.onu_name)} (belum tertaut)`;
  return `ONU ${index} (belum tertaut)`;
}

// Bangun pesan 1 ONU
function pesanSatu(index, r, cause) {
  return [
    '🔴 <b>GANGGUAN ONU</b>',
    `👤 ${namaOnu(r, index)}`,
    (r && r.alamat) ? `🏠 ${esc(r.alamat)}` : null,
    `📍 ONU ${index}`,
    `⚡ Penyebab: ${cause || 'offline'}`,
    r && r.pid ? `💳 ${billPill(r)}` : null,
    `🕐 ${jam()}`,
  ].filter(Boolean).join('\n');
}

// Bangun pesan massal
function pesanMassal(items, pelMap) {
  const perPon = {};
  for (const it of items) {
    const pon = it.index.split(':')[0];
    perPon[pon] = (perPon[pon] || 0) + 1;
  }
  const ponStr = Object.entries(perPon).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} (${n})`).join(', ');
  const nama = items.slice(0, 3).map((it) => {
    const r = pelMap[it.index];
    return r && r.pid ? esc(r.nama) : it.index;
  });
  const sisa = items.length - nama.length;
  return [
    `⚠️ <b>GANGGUAN MASSAL — ${items.length} ONU offline barengan</b>`,
    'Kemungkinan mati lampu area / fiber putus.',
    `📍 PON terdampak: ${ponStr}`,
    `👥 ${nama.join(', ')}${sisa > 0 ? ` +${sisa} lainnya` : ''}`,
    `🕐 ${jam()}`,
  ].join('\n');
}

// Satu siklus poll untuk 1 OLT
async function pollOlt(oltId) {
  const state = await olt.getOnuState(oltId);
  const cur = {};
  for (const o of state.onus) cur[o.index] = !!o.online;

  const prevForOlt = (_prev && _prev[oltId]) || null;
  // simpan state terbaru dulu
  if (!_prev) _prev = {};
  _prev[oltId] = cur;
  saveState(_prev);

  if (!prevForOlt) return; // run pertama (atau abis restart) = baseline, gak alert

  // cari yang BARU offline (sebelumnya online, sekarang offline)
  const newlyOffline = [];
  for (const idx in cur) {
    if (prevForOlt[idx] === true && cur[idx] === false) newlyOffline.push(idx);
  }
  if (!newlyOffline.length) return;

  const target = await alertTarget();
  if (!target) return; // Telegram off / toggle off

  const pelMap = await pelangganFor(oltId, newlyOffline);

  // ── MASSAL: banyak offline barengan -> 1 alert ringkas (skip cek cause per-ONU) ──
  if (newlyOffline.length >= MASS_THRESHOLD) {
    const items = newlyOffline.map((index) => ({ index }));
    await tg.kirim(target, pesanMassal(items, pelMap)).catch(() => {});
    return;
  }

  // ── SEDIKIT: cek cause tiap ONU, cuma alert kalau LOS (DyingGasp di-skip) ──
  // DyingGasp = ONU kehilangan daya/listrik (sering kedip → spam). LOS = loss
  // of signal (gangguan fiber/redaman → gangguan beneran yang perlu ditindak).
  // Per permintaan: notifikasi DyingGasp DIMATIKAN, hanya LOS yang dikirim.
  for (const index of newlyOffline) {
    let cause = '';
    try {
      const d = await olt.getOnuDetail(oltId, index);
      const h = (d && d.history) || [];
      const last = h[h.length - 1];
      cause = last ? (last.cause || '') : '';
    } catch (e) { cause = ''; }
    if (DYINGGASP_RE.test(cause)) continue;   // DyingGasp → skip (anti-spam)
    if (!LOS_RE.test(cause)) continue;        // selain LOS (mis. reboot) → skip
    await tg.kirim(target, pesanSatu(index, pelMap[index], cause)).catch(() => {});
  }
}

async function tick() {
  try {
    const olts = olt.listOlts();
    for (const o of olts) {
      try { await pollOlt(o.id); } catch (e) { console.warn('[olt-alert]', o.id, e.message); }
    }
  } catch (e) { console.warn('[olt-alert] tick', e.message); }
}

function start() {
  if (_timer) return;
  _prev = loadState();
  // delay awal 30 dtk biar server settle dulu
  setTimeout(() => { tick(); _timer = setInterval(tick, POLL_MS); }, 30000);
  console.log('[olt-alert] aktif (poll tiap', POLL_MS / 1000, 'dtk, ambang massal', MASS_THRESHOLD, ')');
}

function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { start, stop, tick, pollOlt, pesanSatu, pesanMassal, CAUSE_RE };
