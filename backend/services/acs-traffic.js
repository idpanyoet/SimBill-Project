'use strict';
// ===========================================================================
// acs-traffic.js — Traffic per-ONU via GenieACS (TR-069 byte counters).
// Sumber download/upload yang AKURAT per-ONU (ONU ngitung sendiri di WAN-nya),
// beda dgn OLT yg gak bisa pisah downstream per-ONU.
//
// Reuse helper dari services/genieacs.js (axios + auth + task). TIDAK mengubah
// file itu. Cukup require & pasang route.
//
// Mekanisme (terverifikasi di OLT rfnet, device F660 04:48):
//   1) refreshObject WANDevice.1  (connection_request -> ONU lapor)
//   2) tunggu ~waitMs
//   3) baca TotalBytesReceived/Sent (universal) atau path EPON/PPP/IP
//   4) rate = selisih byte / selisih waktu (disimpan in-memory antar polling)
// ===========================================================================

const axios = require('axios');
const genie = require('./genieacs');

// Path counter, diurut dari paling universal. down & up berpasangan.
const PATHS = [
  {
    down: 'InternetGatewayDevice.WANDevice.1.WANCommonInterfaceConfig.TotalBytesReceived',
    up: 'InternetGatewayDevice.WANDevice.1.WANCommonInterfaceConfig.TotalBytesSent',
  },
  {
    down: 'InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.Stats.BytesReceived',
    up: 'InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.Stats.BytesSent',
  },
  {
    down: 'InternetGatewayDevice.WANDevice.1.X_CU_WANEPONInterfaceConfig.Stats.BytesReceived',
    up: 'InternetGatewayDevice.WANDevice.1.X_CU_WANEPONInterfaceConfig.Stats.BytesSent',
  },
  {
    down: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Stats.EthernetBytesReceived',
    up: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Stats.EthernetBytesSent',
  },
  {
    down: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Stats.EthernetBytesReceived',
    up: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Stats.EthernetBytesSent',
  },
];

// Ambil device penuh by genieId (genieacs.js gak ekspor getDevice publik utk semua,
// jadi kita query NBI langsung pakai cfg + auth dari genieacs.js).
async function fetchDevice(genieId) {
  const cfg = await genie.getGenieCfg();
  const q = encodeURIComponent(JSON.stringify({ _id: genieId }));
  const o = { timeout: 15000 };
  if (cfg.user) o.auth = { username: cfg.user, password: cfg.password };
  const url = `${cfg.url}/devices/?query=${q}`;
  const r = await axios.get(url, o);
  return Array.isArray(r.data) && r.data[0] ? r.data[0] : null;
}

// Baca _value lewat path bertitik (versi lokal; genie.gv tidak diekspor).
function gv(obj, path) {
  let cur = obj;
  for (const p of path.split('.')) {
    if (cur == null) return null;
    cur = cur[p];
  }
  if (cur && typeof cur === 'object') return ('_value' in cur) ? cur._value : null;
  return cur;
}

// Pilih pasangan path pertama yg keisi. Return {down,up,pathIdx} | null.
function pickBytes(dev) {
  for (let i = 0; i < PATHS.length; i++) {
    const d = gv(dev, PATHS[i].down);
    const u = gv(dev, PATHS[i].up);
    if (d != null || u != null) {
      return { down: d == null ? null : Number(d), up: u == null ? null : Number(u), pathIdx: i };
    }
  }
  return null;
}

// Snapshot byte 1 ONU (refresh dulu biar fresh).
async function snapshot(genieId, { refresh = true, waitMs = 6000 } = {}) {
  if (refresh) {
    try {
      await genie.kirimTask(genieId, { name: 'refreshObject', objectName: 'InternetGatewayDevice.WANDevice.1' }, { connectionRequest: true });
    } catch (e) { /* timeout connection_request bukan fatal (genie.kirimTask sudah handle) */ }
    if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
  }
  const dev = await fetchDevice(genieId);
  if (!dev) return null;
  const b = pickBytes(dev);
  if (!b) return null;
  return { down: b.down, up: b.up, pathIdx: b.pathIdx, ts: Date.now() };
}

// State antar-poll (in-memory). key = genieId.
const _last = new Map();

function _rate(prev, cur) {
  if (!prev) return { first: true };
  const dt = (cur.ts - prev.ts) / 1000;
  if (dt <= 0) return { first: false, downBps: null, upBps: null };
  const diff = (a, b) => { if (a == null || b == null) return null; let d = a - b; if (d < 0) d = a; return d; };
  const dD = diff(cur.down, prev.down), dU = diff(cur.up, prev.up);
  return {
    first: false,
    downBps: dD == null ? null : Math.max(0, dD * 8 / dt),
    upBps: dU == null ? null : Math.max(0, dU * 8 / dt),
    dt,
  };
}

// Polling beruntun: refresh + baca + hitung rate vs snapshot sebelumnya.
// Dipanggil tiap N detik dari panel.
async function pollRateByGenieId(genieId, opts = {}) {
  const cur = await snapshot(genieId, opts);
  if (!cur) return { error: 'no-data', first: true };
  const prev = _last.get(genieId);
  _last.set(genieId, cur);
  const r = _rate(prev, cur);
  return {
    first: !!r.first,
    downBps: r.downBps != null ? r.downBps : null,
    upBps: r.upBps != null ? r.upBps : null,
    downBytesTotal: cur.down, upBytesTotal: cur.up,
    pathIdx: cur.pathIdx, ts: cur.ts,
  };
}

// Versi by-serial (resolve ke genieId dulu).
async function pollRateBySerial(serial, opts = {}) {
  const genieId = await genie.cariIdBySerial(serial);
  if (!genieId) return { error: 'device-not-found', first: true };
  return pollRateByGenieId(genieId, opts);
}

// Sekali ukur pasti (2 snapshot berjarak gapMs) — buat tes/CLI.
async function measureBySerial(serial, gapMs = 6000) {
  const genieId = await genie.cariIdBySerial(serial);
  if (!genieId) throw new Error('device GenieACS tidak ditemukan utk serial ' + serial);
  const a = await snapshot(genieId, { refresh: true, waitMs: 6000 });
  await new Promise((r) => setTimeout(r, gapMs));
  const b = await snapshot(genieId, { refresh: true, waitMs: 6000 });
  if (!a || !b) throw new Error('counter Bytes tidak terbaca (ONU offline / path tidak ada)');
  const r = _rate(a, b);
  return { ...r, downBytesA: a.down, downBytesB: b.down, upBytesA: a.up, upBytesB: b.up, pathIdx: b.pathIdx };
}

module.exports = {
  PATHS, pickBytes, snapshot,
  pollRateByGenieId, pollRateBySerial, measureBySerial,
  fetchDevice,
};
