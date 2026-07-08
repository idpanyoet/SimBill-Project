'use strict';
// ===========================================================================
// SNMP poller buat ZTE C300 (read-only). Khusus monitoring cepat (traffic).
// Provisioning/write TETAP lewat SSH (services/olt.js). SNMP cuma BACA.
//
// Discovery yang udah dipastiin di OLT rfnet (C300 V2.1.0, MIB 3902.1082):
//   sysObjectID : 1.3.6.1.4.1.3902.1082.1001.300.2.1
//   Tabel octet : 1.3.6.1.4.1.3902.1082.500.10.2.3.2.2.1.<COL>.<ponIfIndex>.<onuId>
//   ponIfIndex  : 0x11000000 + (rack<<16) + (slot<<8) + port
//                 contoh 1/8/2 -> 285280258 ; 1/8/1 -> 285280257  (terverifikasi)
//   Kolom octet : col2 (kecil) & col8 (gede). Arah (down/up) -> lihat COL_DOWN/COL_UP,
//                 dikunci setelah dicocokkan dgn 'show interface' SSH.
// ===========================================================================

let snmp;
try { snmp = require('net-snmp'); } catch (e) { snmp = null; }

const fs = require('fs');
const path = require('path');

// --- Konfigurasi (boleh override via config/olt.json per-OLT: { snmp:{community,port,colDown,colUp} }) ---
const OCTET_BASE = '1.3.6.1.4.1.3902.1082.500.10.2.3.2.2.1';
const COL_DOWN_DEFAULT = 8;   // octet download (OLT->ONU). Tuker ke 2 kalau verifikasi kebalik.
const COL_UP_DEFAULT   = 2;   // octet upload   (ONU->OLT).
const PON_BASE = 0x11000000;

function ponIfIndex(rack, slot, port) {
  return PON_BASE + ((rack & 0xff) << 16) + ((slot & 0xff) << 8) + (port & 0xff);
}

// "1/8/2:15" -> { ifIndex, onuId }  (juga terima "1/8/2" tanpa :onu)
function indexToSnmp(onuIndex) {
  const m = String(onuIndex).match(/^(\d+)\/(\d+)\/(\d+)(?::(\d+))?$/);
  if (!m) throw new Error('Index ONU tidak valid: ' + onuIndex);
  const ifIndex = ponIfIndex(Number(m[1]), Number(m[2]), Number(m[3]));
  const onuId = m[4] !== undefined ? Number(m[4]) : null;
  return { ifIndex, onuId };
}

// Ambil setelan SNMP sebuah OLT (dari objek olt yg sudah di-load services/olt.js)
function snmpCfg(olt) {
  const c = (olt && olt.snmp) || {};
  return {
    host: olt.host,
    community: c.community || 'public',
    port: c.port || 161,
    colDown: c.colDown || COL_DOWN_DEFAULT,
    colUp: c.colUp || COL_UP_DEFAULT,
    timeout: c.timeout || 4000,
    retries: c.retries != null ? c.retries : 1,
  };
}

function withSession(cfg, fn) {
  if (!snmp) return Promise.reject(new Error('Library net-snmp belum terpasang (npm install net-snmp)'));
  return new Promise((resolve, reject) => {
    const session = snmp.createSession(cfg.host, cfg.community, {
      port: cfg.port, version: snmp.Version2c, timeout: cfg.timeout, retries: cfg.retries,
      idBitsSize: 16, // ZTE C300 (agent lawas) nolak request-ID 32-bit -> wajib 16-bit
    });
    let done = false;
    const finish = (err, val) => {
      if (done) return; done = true;
      try { session.close(); } catch (e) {}
      err ? reject(err) : resolve(val);
    };
    session.on('error', (e) => finish(e));
    try { fn(session, finish); } catch (e) { finish(e); }
  });
}

// GET beberapa OID -> { oid: value(Number/null) }
// ZTE C300 gak reliable kalau diminta banyak OID sekaligus -> query SATU per SATU.
function snmpGet(cfg, oids) {
  return withSession(cfg, (session, finish) => {
    const out = {};
    let i = 0;
    const parseVb = (vb) => {
      if (snmp.isVarbindError(vb)) return null;
      let v = vb.value;
      if (Buffer.isBuffer(v)) {
        if (v.length === 8) { try { v = Number(v.readBigUInt64BE(0)); } catch (e) { v = parseInt(v.toString('hex') || '0', 16); } }
        else if (v.length > 0 && v.length <= 6) { v = v.readUIntBE(0, v.length); }
        else { v = parseInt(v.toString('hex') || '0', 16); }
      } else if (typeof v === 'bigint') { v = Number(v); }
      else { v = Number(v); }
      return Number.isFinite(v) ? v : null;
    };
    const next = () => {
      if (i >= oids.length) return finish(null, out);
      const oid = oids[i++];
      session.get([oid], (err, varbinds) => {
        if (err) return finish(err);
        out[oid] = parseVb(varbinds[0]);
        next();
      });
    };
    next();
  });
}

// --- Snapshot octet 1 ONU: { down, up, ts } (bytes kumulatif) ---
async function octetSnapshot(olt, onuIndex) {
  const cfg = snmpCfg(olt);
  const { ifIndex, onuId } = indexToSnmp(onuIndex);
  if (onuId == null) throw new Error('Butuh index lengkap dgn :onu (mis 1/8/2:15)');
  const oidDown = `${OCTET_BASE}.${cfg.colDown}.${ifIndex}.${onuId}`;
  const oidUp = `${OCTET_BASE}.${cfg.colUp}.${ifIndex}.${onuId}`;
  const r = await snmpGet(cfg, [oidDown, oidUp]);
  return { down: r[oidDown], up: r[oidUp], ts: Date.now() };
}

// --- Rate 1 ONU: dua snapshot berjarak `gapMs`, hasil bps ---
// State counter disimpan in-memory biar polling beruntun gak perlu 2x tunggu.
const _last = new Map(); // key oltId|index -> {down,up,ts}

function _rateFrom(prev, cur) {
  if (!prev) return { downBps: null, upBps: null, first: true };
  const dt = (cur.ts - prev.ts) / 1000;
  if (dt <= 0) return { downBps: null, upBps: null };
  const diff = (a, b) => { if (a == null || b == null) return null; let d = a - b; if (d < 0) d = a; return d; }; // wrap -> pakai nilai skrg
  const dD = diff(cur.down, prev.down), dU = diff(cur.up, prev.up);
  return {
    downBps: dD == null ? null : Math.max(0, dD * 8 / dt),
    upBps: dU == null ? null : Math.max(0, dU * 8 / dt),
    downBytes: cur.down, upBytes: cur.up, dt,
  };
}

// Polling beruntun (dipanggil tiap N detik dari panel): pakai snapshot sebelumnya.
async function pollRate(olt, onuIndex) {
  const key = `${olt.id}|${onuIndex}`;
  const cur = await octetSnapshot(olt, onuIndex);
  const prev = _last.get(key);
  _last.set(key, cur);
  const rate = _rateFrom(prev, cur);
  return {
    downBps: rate.downBps, upBps: rate.upBps,
    downBytesTotal: cur.down, upBytesTotal: cur.up,
    first: !!rate.first, ts: cur.ts,
  };
}

// Sekali panggil yg pasti dapat rate: 2 snapshot berjarak gapMs (buat tes/CLI).
async function measureRate(olt, onuIndex, gapMs = 3000) {
  const a = await octetSnapshot(olt, onuIndex);
  await new Promise((r) => setTimeout(r, gapMs));
  const b = await octetSnapshot(olt, onuIndex);
  return _rateFrom(a, b);
}

// Tes konektivitas SNMP (sysDescr)
async function ping(olt) {
  const cfg = snmpCfg(olt);
  const oid = '1.3.6.1.2.1.1.1.0';
  const r = await snmpGet(cfg, [oid]);
  return r[oid] != null ? 'ok' : 'no-response';
}

module.exports = {
  available: () => !!snmp,
  ponIfIndex, indexToSnmp, snmpGet, snmpCfg,
  octetSnapshot, pollRate, measureRate, ping,
  OCTET_BASE,
};
