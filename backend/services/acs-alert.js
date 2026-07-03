'use strict';
// ─────────────────────────────────────────────────────────────────────────
// acs-alert.js — Notifikasi Telegram gangguan ONU berbasis GenieACS (TR-069).
//
// Berbeda dari olt-alert.js (yang polling OLT C300 dari sisi sentral), modul ini
// memantau kondisi perangkat pelanggan LANGSUNG dari data ACS:
//   1. RX POWER MEMBURUK — ONU masih online tapi redaman jelek (RX < ambang).
//      Ini PERINGATAN DINI sebelum benar-benar putus.
//   2. ONU OFFLINE DARI ACS — perangkat tidak Inform > batas waktu (kemungkinan
//      mati/putus). LOS sebenarnya membuat ONU tak bisa lapor, jadi "lama tidak
//      Inform" adalah sinyal paling andal dari sisi ACS.
//
// Catatan teknis penting: saat LOS BENERAN (fiber putus), ONU TIDAK bisa Inform
// ke GenieACS — deteksi paling akurat tetap dari OLT (olt-alert.js). Modul ini
// melengkapi dengan: deteksi dini (RX turun) + konfirmasi (ONU hilang dari ACS).
//
// Wire di server.js:  require('./services/acs-alert').start();
// Toggle Telegram: tg_ev_olt (default ON) — berbagi dengan OLT alert.
// ─────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const genie = require('./genieacs');
const tg = require('./telegram');
let db = null;
try { db = require('../config/db'); } catch (e) { db = null; }

const POLL_MS = 180000;           // 3 menit (lebih longgar dari OLT, ACS lebih berat)
const RX_WARN = -30;              // dBm: RX <= ini (-30, -31, ...) = redaman jelek → alert
const RX_CRIT = -32;              // dBm: RX <= ini = kritis (mendekati LOS)
const OFFLINE_MS = 15 * 60 * 1000; // 15 menit tak Inform = anggap offline/putus
const RENOTIFY_MS = 6 * 60 * 60 * 1000; // jangan ulang notif device sama < 6 jam
const STATE_FILE = path.join(__dirname, '..', 'config', '.acs-alert-state.json');

let _timer = null;
let _state = null;   // { serial: { lastNotify: ts, kind: 'rx'|'offline' } }

// ── util ──
function jam() {
  return new Date().toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
}
function esc(s) { return String(s == null ? '' : s); }
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) {}
}

// Target Telegram: master switch + toggle tg_ev_olt + grup teknisi.
async function alertTarget() {
  const cfg = await tg.getCfg();
  if (!cfg || cfg.tg_enabled !== '1') return null;
  if (cfg.tg_ev_olt === '0') return null;                 // toggle bersama OLT (default ON)
  return cfg.tg_chat_teknisi || cfg.tg_chat_owner || null;
}

// Ambil nama pelanggan dari username PPPoE (1 query untuk semua).
async function pelangganByUsername(usernames) {
  const map = {};
  if (!db || !usernames.length) return map;
  try {
    const uniq = [...new Set(usernames.filter(Boolean))];
    if (!uniq.length) return map;
    const ph = uniq.map(() => '?').join(',');
    const rows = await db.query(
      `SELECT username, nama FROM pelanggan WHERE username IN (${ph})`, uniq);
    rows.forEach(r => { map[r.username.toLowerCase()] = r.nama; });
  } catch (e) {}
  return map;
}

// Format pesan untuk satu device bermasalah.
function pesanGangguan(d, kind, namaPelanggan) {
  const nama = namaPelanggan || d.pppoe_username || d.serial_number || '-';
  const rx = (d.rx_power !== null && d.rx_power !== undefined) ? `${d.rx_power} dBm` : '—';
  const inform = d.last_inform ? new Date(d.last_inform).toLocaleString('id-ID') : '-';
  if (kind === 'offline') {
    return [
      '🔴 <b>ONU TIDAK TERPANTAU (ACS)</b>',
      `👤 ${esc(nama)}${d.pppoe_username ? ` (@${esc(d.pppoe_username)})` : ''}`,
      `📡 SN: ${esc(d.serial_number)} · ${esc(d.manufacturer)} ${esc(d.product_class || '')}`,
      `⚠️ Tidak Inform ke ACS > 15 menit — kemungkinan mati/putus.`,
      `🕐 Inform terakhir: ${inform}`,
      `📲 Cek: /redaman ${d.pppoe_username || d.serial_number}`,
    ].join('\n');
  }
  // kind === 'rx'
  const tingkat = (d.rx_power <= RX_CRIT) ? '🚨 KRITIS' : '⚠️ MEMBURUK';
  return [
    `${tingkat} — <b>REDAMAN ONU TINGGI</b>`,
    `👤 ${esc(nama)}${d.pppoe_username ? ` (@${esc(d.pppoe_username)})` : ''}`,
    `📡 SN: ${esc(d.serial_number)} · ${esc(d.manufacturer)} ${esc(d.product_class || '')}`,
    `⬇️ RX Power: <b>${rx}</b> (ambang ${RX_WARN} dBm)`,
    `💡 Sinyal optik lemah — cek fiber/konektor sebelum putus.`,
    `🕐 ${jam()}`,
  ].join('\n');
}

// Boleh notif device ini? (anti-spam: jangan ulang < RENOTIFY_MS untuk kind sama)
function bolehNotif(serial, kind) {
  const s = _state[serial];
  if (!s) return true;
  if (s.kind !== kind) return true;            // jenis gangguan beda → boleh
  return (Date.now() - (s.lastNotify || 0)) > RENOTIFY_MS;
}
function tandaiNotif(serial, kind) {
  _state[serial] = { lastNotify: Date.now(), kind };
  saveState(_state);
}

// Satu siklus poll: ambil semua device dari GenieACS, cek RX & offline.
async function tick() {
  try {
    const target = await alertTarget();
    if (!target) return; // Telegram/toggle off

    let list = [];
    try { list = await genie.listDevices({ limit: 5000 }); }
    catch (e) { console.warn('[acs-alert] listDevices:', e.message); return; }
    if (!Array.isArray(list) || !list.length) return;

    // Kumpulkan kandidat gangguan
    const masalah = []; // { d, kind }
    for (const d of list) {
      if (!d || !d.serial_number) continue;
      // Lewati device sistem GenieACS (probe/discovery)
      const pc = String(d.product_class || '').toLowerCase();
      if (pc.includes('probe') || pc.includes('discovery')) continue;

      const informAge = d.last_inform ? (Date.now() - new Date(d.last_inform).getTime()) : Infinity;

      // 1) OFFLINE dari ACS (lama tak Inform)
      if (informAge > OFFLINE_MS) {
        masalah.push({ d, kind: 'offline' });
        continue; // kalau offline, RX-nya pasti basi → jangan double-alert
      }

      // 2) RX MEMBURUK (hanya kalau device masih "online"/baru Inform)
      const rx = (d.rx_power !== null && d.rx_power !== undefined && !isNaN(parseFloat(d.rx_power)))
        ? parseFloat(d.rx_power) : null;
      if (rx !== null && rx <= RX_WARN) {
        masalah.push({ d, kind: 'rx' });
      }
    }

    if (!masalah.length) return;

    // Resolusi nama pelanggan (1 query)
    const usernames = masalah.map(m => m.d.pppoe_username).filter(Boolean);
    const pelMap = await pelangganByUsername(usernames);

    // Kirim (dengan anti-spam per device per kind)
    for (const { d, kind } of masalah) {
      if (!bolehNotif(d.serial_number, kind)) continue;
      const nama = d.pppoe_username ? pelMap[d.pppoe_username.toLowerCase()] : null;
      await tg.kirim(target, pesanGangguan(d, kind, nama)).catch(() => {});
      tandaiNotif(d.serial_number, kind);
    }

    // Bersihkan state device yang sudah pulih (RX membaik & online) agar kalau
    // nanti bermasalah lagi bisa langsung di-notif (tidak terblokir anti-spam).
    for (const d of list) {
      if (!d || !d.serial_number) continue;
      const informAge = d.last_inform ? (Date.now() - new Date(d.last_inform).getTime()) : Infinity;
      const rx = (d.rx_power !== null && d.rx_power !== undefined) ? parseFloat(d.rx_power) : null;
      const sehat = (informAge <= OFFLINE_MS) && (rx === null || rx > RX_WARN);
      if (sehat && _state[d.serial_number]) {
        delete _state[d.serial_number];
        saveState(_state);
      }
    }
  } catch (e) {
    console.warn('[acs-alert] tick:', e.message);
  }
}

function start() {
  if (_timer) return;
  _state = loadState();
  // Delay awal 45s (biar server & DB siap, GenieACS reachable), lalu poll berkala.
  setTimeout(() => { tick(); _timer = setInterval(tick, POLL_MS); }, 45000);
  console.log('[acs-alert] Monitoring GenieACS aktif (RX & offline) | poll 3 menit');
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { start, stop, tick, pesanGangguan, RX_WARN, RX_CRIT, OFFLINE_MS };
