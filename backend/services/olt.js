'use strict';
/**
 * services/olt.js — Integrasi OLT ZTE (C300/C320) untuk SimBill
 * FASE 1: READ-ONLY (monitoring). Tidak ada perintah yang mengubah config OLT.
 *
 * Akses lewat SSH (ssh2). Mendukung banyak OLT (lihat config/olt.json).
 * Fitur:
 *   - Mutex per-OLT  : cuma 1 sesi SSH jalan per OLT (ZTE rewel kalau di-hammer)
 *   - TTL cache      : hasil di-cache beberapa detik biar gak bolak-balik nge-SSH
 *   - Parser teruji  : dibikin dari output asli C300 V2.1.0 milik rfnet
 *
 * Semua perintah di sini READ-ONLY (show / terminal length). Koneksi ditutup
 * dengan conn.end() tanpa kirim "exit", jadi gak ada prompt "save config".
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

// DB panel (billing_radius). Di-require aman: kalau dipakai di luar app
// (mis. unit test), service tetap bisa di-load tanpa DB.
let db = null;
try { db = require('../config/db'); } catch (e) { db = null; }

// ---------------------------------------------------------------------------
// Konfigurasi OLT
// ---------------------------------------------------------------------------
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'olt.json');

function loadOlts() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((o, i) => ({
      id: o.id || `olt${i + 1}`,
      name: o.name || o.id || `OLT ${i + 1}`,
      host: o.host,
      port: parseInt(o.port || 22, 10),
      username: o.username,
      password: o.password,
      model: o.model || 'C300',
      snmp: o.snmp || null,
    }));
  } catch (e) {
    console.error('[olt] gagal baca config/olt.json:', e.message);
    return [];
  }
}

function getOlt(id) {
  const olts = loadOlts();
  if (!id) return olts[0] || null;
  return olts.find((o) => o.id === id) || null;
}

function listOlts() {
  // tanpa membocorkan password
  return loadOlts().map(({ id, name, host, port, model }) => ({ id, name, host, port, model }));
}

// ---------------------------------------------------------------------------
// SSH algorithms (ZTE sering pakai algoritma lawas)
// ---------------------------------------------------------------------------
const SSH_ALGORITHMS = {
  kex: [
    'diffie-hellman-group1-sha1',
    'diffie-hellman-group14-sha1',
    'diffie-hellman-group14-sha256',
    'diffie-hellman-group-exchange-sha1',
    'diffie-hellman-group-exchange-sha256',
    'ecdh-sha2-nistp256',
  ],
  serverHostKey: ['ssh-rsa', 'ssh-dss', 'rsa-sha2-256', 'rsa-sha2-512', 'ecdsa-sha2-nistp256'],
  cipher: ['aes128-cbc', '3des-cbc', 'aes192-cbc', 'aes256-cbc', 'aes128-ctr', 'aes192-ctr', 'aes256-ctr'],
  hmac: ['hmac-sha1', 'hmac-sha2-256', 'hmac-md5'],
};

// Prompt ZTE diakhiri '#' (privileged) atau '>'.
const PROMPT_RE = /[\r\n][^\r\n]*[#>]\s*$/;
const MORE_RE = /--\s*More\s*--|----\s*More|Press any key to continue/i;

// ---------------------------------------------------------------------------
// Mutex per-OLT: serialize akses SSH
// ---------------------------------------------------------------------------
const locks = new Map(); // oltId -> Promise (rantai)

function withLock(oltId, fn) {
  const prev = locks.get(oltId) || Promise.resolve();
  let release;
  const next = new Promise((res) => (release = res));
  locks.set(oltId, prev.then(() => next));
  return prev.then(fn).finally(() => release());
}

// ---------------------------------------------------------------------------
// TTL cache sederhana
// ---------------------------------------------------------------------------
const cache = new Map(); // key -> { ts, val }

function cached(key, ttlMs, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return Promise.resolve(hit.val);
  return Promise.resolve(producer()).then((val) => {
    cache.set(key, { ts: Date.now(), val });
    return val;
  });
}

// ---------------------------------------------------------------------------
// Pool koneksi SSH persisten per-OLT (reuse biar gak handshake tiap call).
// Auto-close setelah nganggur. Mutex (withLock) menjamin 1 batch/ OLT.
// ---------------------------------------------------------------------------
const shellPool = new Map(); // oltId -> { conn, stream, alive, onData, idleTimer }
const IDLE_CLOSE_MS = 30000;

function destroyShell(oltId) {
  const e = shellPool.get(oltId);
  if (!e) return;
  if (e.idleTimer) clearTimeout(e.idleTimer);
  e.alive = false;
  try { e.conn.end(); } catch (x) {}
  shellPool.delete(oltId);
}

function getShell(olt) {
  return new Promise((resolve, reject) => {
    const ex = shellPool.get(olt.id);
    if (ex && ex.alive) {
      if (ex.idleTimer) { clearTimeout(ex.idleTimer); ex.idleTimer = null; }
      return resolve(ex);
    }
    const conn = new Client();
    let settled = false;
    conn.on('ready', () => {
      conn.shell({ pty: { rows: 1000, cols: 256 } }, (err, s) => {
        if (err) { try { conn.end(); } catch (x) {} return reject(err); }
        s.setEncoding('utf8');
        const entry = { conn, stream: s, alive: true, onData: null, idleTimer: null };
        s.on('data', (d) => { if (entry.onData) entry.onData(d); });
        s.on('close', () => { entry.alive = false; if (shellPool.get(olt.id) === entry) shellPool.delete(olt.id); });
        conn.on('error', () => { entry.alive = false; if (shellPool.get(olt.id) === entry) shellPool.delete(olt.id); });
        shellPool.set(olt.id, entry);
        // tunggu prompt awal (lewati banner login)
        let buf = '';
        entry.onData = (d) => { buf += d; if (PROMPT_RE.test(buf)) { entry.onData = null; if (!settled) { settled = true; resolve(entry); } } };
        setTimeout(() => { if (!settled) { entry.onData = null; settled = true; resolve(entry); } }, 9000);
      });
    });
    conn.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    conn.connect({
      host: olt.host, port: olt.port, username: olt.username, password: olt.password,
      readyTimeout: 20000, keepaliveInterval: 5000, algorithms: SSH_ALGORITHMS,
    });
  });
}

// Jalankan beberapa perintah pada sesi (reuse). Kembalikan { cmd: output }.
async function runCommands(olt, commands, opts = {}) {
  if (!olt || !olt.host) throw new Error('OLT config tidak valid');
  const timeout = opts.timeout || 25000;
  let entry;
  try { entry = await getShell(olt); }
  catch (e) { destroyShell(olt.id); throw e; }

  return new Promise((resolve, reject) => {
    const results = {};
    let idx = -1, buffer = '', idleTimer = null, hardTimer = null, finished = false;

    const detach = () => { entry.onData = null; if (idleTimer) clearTimeout(idleTimer); if (hardTimer) clearTimeout(hardTimer); };
    const finish = (err) => {
      if (finished) return;
      finished = true;
      detach();
      if (err) { destroyShell(olt.id); return reject(err); }   // error -> buang koneksi (fresh next time)
      entry.idleTimer = setTimeout(() => destroyShell(olt.id), IDLE_CLOSE_MS); // sukses -> jaga koneksi hangat
      resolve(results);
    };

    hardTimer = setTimeout(() => finish(new Error('OLT timeout')), timeout);

    const commitCurrent = () => {
      if (idx >= 0 && idx < commands.length) {
        let out = buffer;
        const cmd = commands[idx];
        out = out.replace(new RegExp('^[^\\n]*' + cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\\n]*\\n?'), '');
        out = out.replace(/[^\r\n]*[#>]\s*$/, '');
        results[cmd] = out.trim();
      }
      buffer = '';
    };

    const sendNext = () => {
      commitCurrent();
      idx++;
      if (idx >= commands.length) return finish(null);
      try { entry.stream.write(commands[idx] + '\n'); } catch (e) { return finish(e); }
    };

    const resetIdle = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(sendNext, 1200); };

    entry.onData = (d) => {
      buffer += d;
      if (MORE_RE.test(d)) { try { entry.stream.write(' '); } catch (e) {} buffer = buffer.replace(MORE_RE, ''); }
      if (opts.autoConfirm && /\[yes\/no\]|\(y\/n\)|confirm|continue\?/i.test(d) && !/logout/i.test(d)) {
        try { entry.stream.write('y\n'); } catch (e) {}
      }
      if (idx >= 0 && PROMPT_RE.test(buffer)) { if (idleTimer) clearTimeout(idleTimer); return sendNext(); }
      resetIdle();
    };

    // sesi sudah di prompt -> langsung kirim perintah pertama
    sendNext();
  });
}

// ===========================================================================
// PARSERS  (dibikin & diuji dari output asli C300 V2.1.0)
// ===========================================================================

// --- show card ---
function parseCard(text) {
  const cards = [];
  const lines = (text || '').split(/\r?\n/);
  for (const line of lines) {
    const f = line.trim().split(/\s+/);
    // butuh minimal: rack shelf slot cfg real port hardver [softver] status
    if (f.length < 8) continue;
    if (!/^\d+$/.test(f[0]) || !/^\d+$/.test(f[2])) continue;
    const card = {
      rack: +f[0], shelf: +f[1], slot: +f[2],
      cfgType: f[3], realType: f[4], port: +f[5], hardVer: f[6],
    };
    if (f.length >= 9) { card.softVer = f[7]; card.status = f[8]; }
    else { card.softVer = ''; card.status = f[7]; }
    card.isGpon = /^GTGO/.test(card.realType) || /^GTGO/.test(card.cfgType);
    cards.push(card);
  }
  return cards;
}

// --- show gpon onu state ---
function parseOnuState(text) {
  const onus = [];
  const lines = (text || '').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*(\d+\/\d+\/\d+:\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/);
    if (!m) continue;
    const phase = m[4];
    onus.push({
      index: m[1],
      adminState: m[2],
      omccState: m[3],
      phaseState: phase,
      channel: m[5].trim(),
      online: /working/i.test(phase),
    });
  }
  let total = onus.length;
  let online = onus.filter((o) => o.online).length;
  const tot = (text || '').match(/ONU Number:\s*(\d+)\s*\/\s*(\d+)/i);
  if (tot) { online = +tot[1]; total = +tot[2]; }
  return { onus, online, offline: total - online, total };
}

// --- show gpon onu uncfg ---
// Catatan: saat probe, list kosong ("No related information"). Parser di bawah
// best-effort untuk format umum ZTE; kalau nanti ada ONU uncfg beneran dan
// formatnya beda, kirim outputnya ke Pus buat penyesuaian.
function parseUncfg(text) {
  if (!text || /No related information/i.test(text)) return [];
  const out = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/gpon-onu_(\S+)\s+([0-9A-Za-z]{8,})\s*(\S*)/);
    if (m) out.push({ index: m[1], sn: m[2], state: m[3] || '' });
  }
  return out;
}

// --- show pon power attenuation gpon-onu_x/y/z:n ---
function parsePower(text) {
  if (!text) return null;
  const num = '(-?\\d+(?:\\.\\d+)?)';
  const up = text.match(new RegExp('up\\s+Rx\\s*:\\s*' + num + '[^\\n]*?Tx\\s*:\\s*' + num + '[^\\n]*?' + num + '\\s*\\(dB\\)', 'i'));
  const down = text.match(new RegExp('down\\s+Tx\\s*:\\s*' + num + '[^\\n]*?Rx\\s*:\\s*' + num + '[^\\n]*?' + num + '\\s*\\(dB\\)', 'i'));
  if (!up && !down) return null;
  return {
    oltRx: up ? parseFloat(up[1]) : null,        // OLT terima dari ONU (upstream)
    onuTx: up ? parseFloat(up[2]) : null,        // ONU kirim (upstream)
    attenuationUp: up ? parseFloat(up[3]) : null,
    oltTx: down ? parseFloat(down[1]) : null,    // OLT kirim (downstream)
    onuRx: down ? parseFloat(down[2]) : null,    // <-- RX power pelanggan (paling penting)
    attenuationDown: down ? parseFloat(down[3]) : null,
  };
}

// --- show gpon onu detail-info gpon-onu_x/y/z:n ---
function parseDetail(text) {
  const kv = {};
  const lines = (text || '').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z0-9 +/()]+?)\s*:\s*(.*)$/);
    if (m) kv[m[1].trim()] = m[2].trim();
  }
  if (Object.keys(kv).length === 0) return null;
  const pick = (k) => (kv[k] !== undefined ? kv[k] : null);

  // riwayat offline (Authpass/OfflineTime/Cause)
  const history = [];
  for (const line of lines) {
    const m = line.match(/^\s*\d+\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*(\S*)/);
    if (m && m[1] !== '0000-00-00 00:00:00') {
      history.push({ authpass: m[1], offline: m[2] === '0000-00-00 00:00:00' ? null : m[2], cause: m[3] || '' });
    }
  }

  return {
    name: pick('Name'),
    sn: pick('Serial number'),
    type: pick('Type'),
    state: pick('State'),
    adminState: pick('Admin state'),
    phaseState: pick('Phase state'),
    configState: pick('Config state'),
    description: pick('Description'),
    distance: pick('ONU Distance'),
    onlineDuration: pick('Online Duration'),
    lineProfile: pick('Line Profile'),
    serviceProfile: pick('Service Profile'),
    history,
    raw: kv,
  };
}

// --- show gpon onu baseinfo gpon-olt_x/y/z  (SN massal per-PON) ---
function parseBaseinfo(text) {
  const out = [];
  const lines = (text || '').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*gpon-onu_(\d+\/\d+\/\d+:\d+)\s+(\S+)\s+(\S+)\s+(?:SN:)?(\S+)\s+(\S+)/);
    if (!m) continue;
    out.push({ index: m[1], type: m[2], mode: m[3], sn: m[4].replace(/^SN:/, ''), state: m[5] });
  }
  return out;
}

// --- show interface gpon-onu_x/y/z:n  (statistik traffic) ---
function parseTraffic(text) {
  if (!text || /Invalid|%Error/i.test(text)) return null;
  const num = (re) => { const m = text.match(re); return m ? Number(m[1]) : null; };
  const r = {
    inRate: num(/Input rate\s*:\s*([\d.]+)\s*Bps/i),
    inPps: num(/Input rate\s*:\s*[\d.]+\s*Bps\s+(\d+)\s*pps/i),
    outRate: num(/Output rate\s*:\s*([\d.]+)\s*Bps/i),
    outPps: num(/Output rate\s*:\s*[\d.]+\s*Bps\s+(\d+)\s*pps/i),
    inPeak: num(/Input peak rate\s*:\s*([\d.]+)\s*Bps/i),
    inPeakPps: num(/Input peak rate\s*:\s*[\d.]+\s*Bps\s+(\d+)\s*pps/i),
    outPeak: num(/Output peak rate\s*:\s*([\d.]+)\s*Bps/i),
    outPeakPps: num(/Output peak rate\s*:\s*[\d.]+\s*Bps\s+(\d+)\s*pps/i),
    inBytes: num(/Input:[\s\S]*?Bytes:\s*(\d+)/i),
    inPackets: num(/Input:[\s\S]*?Bytes:\s*\d+\s*Packets:\s*(\d+)/i),
    outBytes: num(/Output:[\s\S]*?Bytes:\s*(\d+)/i),
    outPackets: num(/Output:[\s\S]*?Bytes:\s*\d+\s*Packets:\s*(\d+)/i),
  };
  if (r.inRate === null && r.inBytes === null) return null;
  return r;
}

// ===========================================================================
// MATCHING: ONU  <->  pelanggan SimBill
// ===========================================================================

function norm(s) { return (s || '').toString().trim().toLowerCase(); }

function toYMD(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

// Status tagihan dari kolom pelanggan (status enum + tgl_expired)
function billingStatus(p) {
  if (!p) return null;
  const today = new Date().toISOString().slice(0, 10);
  const exp = toYMD(p.tgl_expired);
  if (p.status === 'nonaktif') return { state: 'nonaktif', label: 'Nonaktif', expired: exp };
  if (p.status === 'suspended') return { state: 'isolir', label: 'Isolir', expired: exp };
  if (exp && exp < today) return { state: 'nunggak', label: 'Jatuh tempo', expired: exp };
  return { state: 'aktif', label: 'Aktif', expired: exp };
}

/**
 * Resolusi 1 ONU ke pelanggan (fungsi murni, gampang dites).
 * Urutan prioritas: manual > sn(acs_link) > name=username > name=nama(unik).
 * ctx: { acsBySn:Map, byUsername:Map, byNamaUniq:Map }  (semua key di-normalize)
 */
function resolveMatch({ sn, name }, ctx) {
  const snN = norm(sn);
  if (snN && ctx.acsBySn.has(snN)) return { pelanggan_id: ctx.acsBySn.get(snN), source: 'sn' };
  const nm = norm(name);
  if (nm && ctx.byUsername.has(nm)) return { pelanggan_id: ctx.byUsername.get(nm), source: 'username' };
  if (nm && ctx.byNamaUniq.has(nm)) return { pelanggan_id: ctx.byNamaUniq.get(nm), source: 'nama' };
  return { pelanggan_id: null, source: null };
}

// Pastikan tabel olt_link ada (idempotent)
async function ensureSchema() {
  if (!db) throw new Error('DB tidak tersedia');
  await db.query(`CREATE TABLE IF NOT EXISTS olt_link (
    olt_id      varchar(32)  NOT NULL,
    onu_index   varchar(32)  NOT NULL,
    pelanggan_id int(10) unsigned DEFAULT NULL,
    sn          varchar(64)  DEFAULT NULL,
    onu_name    varchar(150) DEFAULT NULL,
    source      enum('manual','sn','username','nama','voucher') DEFAULT NULL,
    updated_at  timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
    PRIMARY KEY (olt_id, onu_index),
    KEY idx_pelanggan (pelanggan_id),
    KEY idx_sn (sn)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // tabel lama: pastikan enum punya 'voucher' (idempotent)
  try {
    await db.query("ALTER TABLE olt_link MODIFY COLUMN source enum('manual','sn','username','nama','voucher') DEFAULT NULL");
  } catch (e) { /* sudah sesuai / abaikan */ }
  // log aksi write (reboot/disable/hapus/dll)
  await db.query(`CREATE TABLE IF NOT EXISTS olt_action_log (
    id        bigint unsigned NOT NULL AUTO_INCREMENT,
    olt_id    varchar(32)  NOT NULL,
    onu_index varchar(32)  NOT NULL,
    action    varchar(32)  NOT NULL,
    ok        tinyint(1)   DEFAULT 1,
    dibuat    timestamp NULL DEFAULT current_timestamp(),
    PRIMARY KEY (id),
    KEY idx_onu (olt_id, onu_index),
    KEY idx_dibuat (dibuat)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

// Bangun konteks lookup dari DB
async function buildContext() {
  const acs = await db.query('SELECT serial_number, pelanggan_id FROM acs_link WHERE pelanggan_id IS NOT NULL');
  const acsBySn = new Map();
  acs.forEach((r) => acsBySn.set(norm(r.serial_number), r.pelanggan_id));

  const pel = await db.query('SELECT id, username, nama FROM pelanggan');
  const byUsername = new Map();
  const namaCount = new Map();
  const namaFirst = new Map();
  pel.forEach((p) => {
    if (p.username) byUsername.set(norm(p.username), p.id);
    const nm = norm(p.nama);
    if (nm) {
      namaCount.set(nm, (namaCount.get(nm) || 0) + 1);
      if (!namaFirst.has(nm)) namaFirst.set(nm, p.id);
    }
  });
  // hanya nama yang UNIK yang boleh dipakai auto-match
  const byNamaUniq = new Map();
  namaCount.forEach((cnt, nm) => { if (cnt === 1) byNamaUniq.set(nm, namaFirst.get(nm)); });

  return { acsBySn, byUsername, byNamaUniq };
}

// Ambil SN semua ONU (baseinfo per PON, 1 sesi SSH)
async function getSnMap(olt, pons) {
  const cmds = ['terminal length 0', ...pons.map((p) => `show gpon onu baseinfo gpon-olt_${p}`)];
  const out = await runCommands(olt, cmds, { timeout: 60000 });
  const map = {};
  pons.forEach((p) => {
    parseBaseinfo(out[`show gpon onu baseinfo gpon-olt_${p}`]).forEach((b) => { map[b.index] = b; });
  });
  return map;
}

// Ambil Name semua ONU (detail per ONU, 1 sesi SSH) — operasi berat
async function getNameMap(olt, indexes) {
  if (!indexes.length) return {};
  const cmds = ['terminal length 0', ...indexes.map((i) => `show gpon onu detail-info gpon-onu_${i}`)];
  const out = await runCommands(olt, cmds, { timeout: Math.max(60000, indexes.length * 2500) });
  const map = {};
  indexes.forEach((i) => {
    const d = parseDetail(out[`show gpon onu detail-info gpon-onu_${i}`]);
    if (d) map[i] = { name: d.name, description: d.description };
  });
  return map;
}

/**
 * SYNC MATCH — operasi berat (on-demand / cron). Walk semua ONU, resolve ke
 * pelanggan, simpan ke olt_link. Baris source='manual' TIDAK ditimpa.
 * fetchNames=false -> cuma match by SN (cepat). true -> ikut Name (lebih lengkap, lambat).
 */
async function syncMatch(oltId, { fetchNames = true } = {}) {
  if (!db) throw new Error('DB tidak tersedia');
  await ensureSchema();
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');

  return withLock(olt.id, async () => {
    // 1) daftar ONU + PON
    const stOut = await runCommands(olt, ['terminal length 0', 'show gpon onu state']);
    const state = parseOnuState(stOut['show gpon onu state']);
    const pons = [...new Set(state.onus.map((o) => o.index.split(':')[0]))];

    // 2) SN massal
    const snMap = await getSnMap(olt, pons);

    // 3) baris yang dikunci (manual + voucher) jangan ditimpa
    const lockedRows = await db.query(
      "SELECT onu_index FROM olt_link WHERE olt_id=? AND source IN ('manual','voucher')", [olt.id]
    );
    const locked = new Set(lockedRows.map((r) => r.onu_index));

    // 4) konteks lookup
    const ctx = await buildContext();

    // 5) Name (opsional, berat) — cuma utk ONU yg belum kekunci
    let nameMap = {};
    if (fetchNames) {
      const need = state.onus.map((o) => o.index).filter((i) => !locked.has(i));
      nameMap = await getNameMap(olt, need);
    }

    // 6) resolve + upsert
    const stats = { total: state.onus.length, manual: locked.size, sn: 0, username: 0, nama: 0, unmatched: 0 };
    for (const o of state.onus) {
      if (locked.has(o.index)) continue;
      const sn = snMap[o.index] ? snMap[o.index].sn : null;
      const name = nameMap[o.index] ? nameMap[o.index].name : null;
      const r = resolveMatch({ sn, name }, ctx);
      if (r.source) stats[r.source]++; else stats.unmatched++;
      await db.query(
        `INSERT INTO olt_link (olt_id, onu_index, pelanggan_id, sn, onu_name, source)
         VALUES (?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           pelanggan_id=VALUES(pelanggan_id), sn=VALUES(sn),
           onu_name=VALUES(onu_name), source=VALUES(source)`,
        [olt.id, o.index, r.pelanggan_id, sn, name, r.source]
      );
    }
    return stats;
  });
}

// Peta index -> pelanggan (buat enrich dashboard, baca DB doang, cepat)
async function getLinkMap(oltId) {
  if (!db) return {};
  const olt = getOlt(oltId);
  if (!olt) return {};
  try {
    const rows = await db.query(
      `SELECT l.onu_index, l.pelanggan_id, l.sn, l.source,
              p.nama, p.username, p.status, p.tgl_expired
         FROM olt_link l
         LEFT JOIN pelanggan p ON p.id = l.pelanggan_id
        WHERE l.olt_id = ?`, [olt.id]
    );
    const map = {};
    rows.forEach((r) => {
      map[r.onu_index] = {
        pelanggan_id: r.pelanggan_id,
        source: r.source,
        sn: r.sn,
        tag: (!r.pelanggan_id && r.source === 'voucher') ? 'voucher' : null,
        pelanggan: r.pelanggan_id ? {
          id: r.pelanggan_id, nama: r.nama, username: r.username,
          status: r.status, tgl_expired: toYMD(r.tgl_expired),
          billing: billingStatus(r),
        } : null,
      };
    });
    return map;
  } catch (e) {
    console.error('[olt] getLinkMap:', e.message);
    return {};
  }
}

// Link manual: set / hapus
async function setLink(oltId, index, pelangganId, extra = {}) {
  if (!db) throw new Error('DB tidak tersedia');
  await ensureSchema();
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  if (!validIndex(index)) throw new Error('Index ONU tidak valid');
  await db.query(
    `INSERT INTO olt_link (olt_id, onu_index, pelanggan_id, sn, onu_name, source)
     VALUES (?,?,?,?,?, 'manual')
     ON DUPLICATE KEY UPDATE pelanggan_id=VALUES(pelanggan_id), source='manual'`,
    [olt.id, index, pelangganId, extra.sn || null, extra.name || null]
  );
  return { ok: true };
}

async function deleteLink(oltId, index) {
  if (!db) throw new Error('DB tidak tersedia');
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  await db.query('DELETE FROM olt_link WHERE olt_id=? AND onu_index=?', [olt.id, index]);
  return { ok: true };
}

// Tandai / batalkan ONU sebagai voucher/hotspot (pelanggan_id NULL, source='voucher')
async function markVoucher(oltId, index, on, extra = {}) {
  if (!db) throw new Error('DB tidak tersedia');
  await ensureSchema();
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  if (!validIndex(index)) throw new Error('Index ONU tidak valid');
  if (on) {
    await db.query(
      `INSERT INTO olt_link (olt_id, onu_index, pelanggan_id, sn, onu_name, source)
       VALUES (?,?, NULL, ?, ?, 'voucher')
       ON DUPLICATE KEY UPDATE pelanggan_id=NULL, source='voucher',
         sn=COALESCE(VALUES(sn), sn), onu_name=COALESCE(VALUES(onu_name), onu_name)`,
      [olt.id, index, extra.sn || null, extra.name || null]
    );
  } else {
    await db.query('DELETE FROM olt_link WHERE olt_id=? AND onu_index=? AND source=?', [olt.id, index, 'voucher']);
  }
  return { ok: true };
}

// Cari pelanggan buat picker link manual
async function searchPelanggan(q) {
  if (!db) throw new Error('DB tidak tersedia');
  const term = '%' + (q || '').trim() + '%';
  const rows = await db.query(
    `SELECT id, nama, username, status, tgl_expired FROM pelanggan
      WHERE nama LIKE ? OR username LIKE ?
      ORDER BY nama LIMIT 15`, [term, term]
  );
  return rows.map((p) => ({
    id: p.id, nama: p.nama, username: p.username,
    status: p.status, billing: billingStatus(p),
  }));
}

// Honorifik/panggilan Indonesia yang sering nempel di Name ONU
const HONORIFICS = new Set([
  'kak', 'kk', 'pak', 'pk', 'bu', 'ibu', 'bg', 'bang', 'abg', 'abang',
  'mas', 'mbak', 'om', 'tante', 'cek', 'cik', 'ust', 'tgk', 'teungku',
  'pakcik', 'makcik', 'bapak', 'k', 'p',
]);

// Pecah Name jadi term pencarian (buang honorifik, juga yg nempel: kakyeni->yeni)
function nameSearchTerms(name) {
  if (!name) return [];
  const toks = name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const terms = new Set();
  for (const t of toks) {
    if (HONORIFICS.has(t)) continue;
    for (const h of HONORIFICS) {
      if (h.length >= 2 && t.length > h.length + 2 && t.startsWith(h)) terms.add(t.slice(h.length));
    }
    if (t.length >= 3) terms.add(t);
  }
  return [...terms].slice(0, 5);
}

// Saran kandidat pelanggan utk ONU yg belum ke-link (human tetap konfirmasi)
async function suggestCandidates(name) {
  if (!db || !name) return [];
  const terms = nameSearchTerms(name);
  if (!terms.length) return [];
  const seen = new Map();
  for (const t of terms) {
    const rows = await db.query(
      `SELECT id, nama, username, status, tgl_expired FROM pelanggan
        WHERE username LIKE ? OR nama LIKE ? LIMIT 5`, ['%' + t + '%', '%' + t + '%']
    );
    rows.forEach((p) => {
      if (!seen.has(p.id)) seen.set(p.id, {
        id: p.id, nama: p.nama, username: p.username,
        status: p.status, billing: billingStatus(p),
      });
    });
    if (seen.size >= 6) break;
  }
  return [...seen.values()].slice(0, 6);
}

// ===========================================================================
// FASE 2: REGISTER ONU (WRITE)  — engine berbasis template, dry-run dulu
// ===========================================================================

const TEMPLATES_PATH = path.join(__dirname, '..', 'config', 'olt-templates.json');
const REG_TYPE_DEFAULT = 'ALL-GPON';
const AUTO_VARS = new Set(['CARDPON', 'ONT', 'SN', 'NAME']); // diisi engine, bukan user

function loadTemplates() {
  const raw = fs.readFileSync(TEMPLATES_PATH, 'utf8');
  const obj = JSON.parse(raw);
  delete obj._catatan;
  return obj;
}

function placeholdersOf(lines) {
  const set = new Set();
  lines.forEach((l) => { (l.match(/\{([A-Z_]+)\}/g) || []).forEach((m) => set.add(m.slice(1, -1))); });
  return [...set];
}

// Daftar template (buat dropdown). Tiap item: id, label, hgu, vars (yg perlu diisi user)
function getTemplates() {
  const tpls = loadTemplates();
  return Object.entries(tpls).map(([id, t]) => ({
    id, label: t.label || id, hgu: !!t.hgu,
    vars: placeholdersOf(t.lines || []).filter((v) => !AUTO_VARS.has(v)),
  }));
}

// Nomor ONU bebas terkecil di sebuah PON (1..128)
function nextFreeOnu(occupied) {
  const set = new Set(occupied.map(Number));
  for (let n = 1; n <= 128; n++) if (!set.has(n)) return n;
  return null;
}

// Ambil kredensial PPPoE asli dari radcheck (BUKAN pelanggan.password yg di-hash!)
async function getPppoeCreds(pelangganId) {
  if (!db || !pelangganId) return null;
  const p = (await db.query('SELECT username FROM pelanggan WHERE id=?', [pelangganId]))[0];
  if (!p) return null;
  const rc = await db.query(
    "SELECT value FROM radcheck WHERE username=? AND attribute='Cleartext-Password' LIMIT 1", [p.username]
  );
  return { user: p.username, password: rc[0] ? rc[0].value : null };
}

// Substitusi {VAR} di satu baris
function applyVars(line, vars) {
  return line.replace(/\{([A-Z_]+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
}

/**
 * Bangun urutan command lengkap dari template (FUNGSI MURNI).
 * vars: { CARDPON, ONT, SN, NAME, PROFILE, USER_PPPOE, PASSWORD_PPPOE, ... }
 * skipOnuAdd: lewati 'onu N type ... sn ...' (buat re-apply ONU yg sudah ada)
 */
function buildFromTemplate(tpl, { pon, onuNumber, sn, type, vars, write, skipOnuAdd }) {
  const cmds = ['terminal length 0', 'configure terminal'];
  if (!skipOnuAdd) {
    cmds.push(`interface gpon-olt_${pon}`);
    cmds.push(`onu ${onuNumber} type ${type || REG_TYPE_DEFAULT} sn ${sn}`);
    cmds.push('exit');
  }
  for (const raw of tpl.lines) {
    const line = raw.trim() === '!' ? 'exit' : applyVars(raw, vars);
    cmds.push(line);
  }
  cmds.push('end');
  if (write) cmds.push('write');
  return cmds;
}

const SN_RE = /^[0-9A-Za-z]{8,20}$/;
const NAME_RE = /^[0-9A-Za-z._\- ]{1,32}$/;        // boleh spasi
const PROFILE_RE = /^[0-9A-Za-z._-]{1,32}$/;
const USER_RE = /^[0-9A-Za-z._@-]{1,64}$/;
const PASS_RE = /^[!-~]{1,64}$/;                    // printable ASCII, tanpa spasi

/**
 * Register/provision ONU pakai template.
 * params: { sn, pon, onuNumber, name, type, templateId, vars{PROFILE,USER_PPPOE,PASSWORD_PPPOE},
 *           write, pelanggan_id, dryRun(default true), skipOnuAdd, force }
 */
async function registerOnu(oltId, params = {}) {
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');

  const sn = (params.sn || '').trim();
  const name = (params.name || '').trim();
  const type = (params.type || REG_TYPE_DEFAULT).trim();
  const write = params.write !== false;
  const dryRun = params.dryRun !== false;          // DEFAULT dry-run
  const skipOnuAdd = !!params.skipOnuAdd;
  const pelangganId = params.pelanggan_id || null;
  const templateId = (params.templateId || '').trim();

  const tpls = loadTemplates();
  const tpl = tpls[templateId];
  if (!tpl) throw new Error('Template tidak dikenal: ' + templateId);

  // ── Validasi dasar ──
  if (!SN_RE.test(sn)) throw new Error('SN tidak valid');
  if (!NAME_RE.test(name)) throw new Error('Nama ONU tidak valid (huruf/angka . _ - spasi, maks 32)');
  if (type !== 'ALL-GPON' && !/^[0-9A-Za-z._-]{1,24}$/.test(type)) throw new Error('Tipe ONU tidak valid');

  return withLock(olt.id, async () => {
    const stOut = await runCommands(olt, ['terminal length 0', 'show gpon onu state', 'show gpon onu uncfg'], { timeout: 30000 });
    const state = parseOnuState(stOut['show gpon onu state']);
    const uncfg = parseUncfg(stOut['show gpon onu uncfg']);

    let pon = (params.pon || '').trim().split(':')[0];
    const uMatch = uncfg.find((u) => norm(u.sn) === norm(sn));
    if (!pon && uMatch) pon = String(uMatch.index).split(':')[0];
    if (!/^\d+\/\d+\/\d+$/.test(pon)) throw new Error('PON tidak valid / SN tidak ada di daftar uncfg');

    const occupied = state.onus.filter((o) => o.index.startsWith(pon + ':')).map((o) => o.index.split(':')[1]);
    let onuNumber;
    if (skipOnuAdd) {
      // re-apply service ke ONU yg SUDAH ada -> wajib pakai nomor yg diberi & sudah occupied
      onuNumber = params.onuNumber;
      if (!onuNumber) throw new Error('onuNumber wajib untuk re-apply');
      if (!occupied.map(Number).includes(Number(onuNumber))) {
        throw new Error(`ONU ${pon}:${onuNumber} belum terdaftar — tidak bisa re-apply`);
      }
    } else {
      // register baru -> SN harus uncfg, cari nomor bebas
      if (!uMatch && !params.force) {
        throw new Error('SN tidak ada di uncfg. ONU mungkin sudah keregister/offline.');
      }
      onuNumber = params.onuNumber || nextFreeOnu(occupied);
      if (!onuNumber) throw new Error('Tidak ada nomor ONU bebas di PON ini');
      if (occupied.map(Number).includes(Number(onuNumber))) throw new Error(`Nomor ONU ${onuNumber} sudah dipakai`);
    }

    // ── Susun vars ──
    const vars = {
      CARDPON: pon.replace(/^\d+\//, ''),   // 1/8/2 -> 8/2
      ONT: onuNumber, SN: sn, NAME: name,
    };
    const userVars = params.vars || {};
    // profile
    if (userVars.PROFILE !== undefined) {
      const pr = String(userVars.PROFILE).trim();
      if (pr && !PROFILE_RE.test(pr)) throw new Error('Profile tidak valid');
      vars.PROFILE = pr;
    }
    // kredensial PPPoE: ambil dari radcheck kalau template butuh & belum diisi & ada pelanggan
    const needs = placeholdersOf(tpl.lines);
    if (needs.includes('USER_PPPOE') || needs.includes('PASSWORD_PPPOE')) {
      let u = (userVars.USER_PPPOE || '').trim();
      let pw = (userVars.PASSWORD_PPPOE || '').trim();
      if ((!u || !pw) && pelangganId) {
        const cr = await getPppoeCreds(pelangganId);
        if (cr) { u = u || cr.user || ''; pw = pw || cr.password || ''; }
      }
      if (!u || !pw) throw new Error('USER_PPPOE/PASSWORD_PPPOE kosong (tautkan pelanggan atau isi manual)');
      if (!USER_RE.test(u)) throw new Error('USER_PPPOE tidak valid');
      if (!PASS_RE.test(pw)) throw new Error('PASSWORD_PPPOE tidak valid (tanpa spasi)');
      vars.USER_PPPOE = u; vars.PASSWORD_PPPOE = pw;
    }
    // var lain dari user (selain yg auto) — validasi anti-injection
    for (const [k, v] of Object.entries(userVars)) {
      if (AUTO_VARS.has(k) || k === 'PROFILE' || k === 'USER_PPPOE' || k === 'PASSWORD_PPPOE') continue;
      const val = String(v);
      if (/[\r\n;]/.test(val)) throw new Error(`Nilai ${k} mengandung karakter terlarang`);
      vars[k] = val;
    }

    const cmds = buildFromTemplate(tpl, { pon, onuNumber, sn, type, vars, write, skipOnuAdd });

    // pastikan tidak ada placeholder tersisa
    const leftover = cmds.join('\n').match(/\{([A-Z_]+)\}/);
    if (leftover) throw new Error('Placeholder belum terisi: ' + leftover[0]);

    if (dryRun) {
      return { dryRun: true, template: templateId, pon, onuNumber, index: `${pon}:${onuNumber}`, sn, name, write, skipOnuAdd, commands: cmds };
    }

    // ── COMMIT ──
    const out = await runCommands(olt, cmds, { timeout: 120000, autoConfirm: true });
    const transcript = cmds.map((c) => `${c}\n${out[c] || ''}`).join('\n');
    const errLine = (transcript.match(/%Error[^\n]*|%Code[^\n]*|fault[^\n]*9\d{3}[^\n]*/i) || [])[0];
    if (errLine) throw new Error('OLT menolak sebagian command: ' + errLine.trim());

    if (pelangganId && db) {
      try { await setLink(olt.id, `${pon}:${onuNumber}`, pelangganId, { sn, name }); } catch (e) {}
    }
    cache.delete(`dash:${olt.id}`); cache.delete(`state:${olt.id}`); cache.delete(`uncfg:${olt.id}`);

    // sembunyikan password di transcript yg dikembalikan
    const safe = transcript.replace(/(password )\S+/gi, '$1******');
    return { ok: true, template: templateId, pon, onuNumber, index: `${pon}:${onuNumber}`, written: write, transcript: safe };
  });
}

// Daftar profile tcont/DBA di OLT (best-effort; buat dropdown register)
async function getTcontProfiles(oltId) {
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  return cached(`profiles:${olt.id}`, 300000, () =>
    withLock(olt.id, async () => {
      const cmd = 'show gpon profile tcont';
      const out = await runCommands(olt, ['terminal length 0', cmd], { timeout: 30000 });
      const txt = out[cmd] || '';
      const names = new Set();
      txt.split(/\r?\n/).forEach((line) => {
        const m = line.match(/(?:Name|profile)\s*[:=]?\s*([0-9A-Za-z._-]+)/i) || line.match(/^\s*([0-9A-Za-z._-]+)\s+\d/);
        if (m && !/^(total|name|profile|index|gpon)$/i.test(m[1])) names.add(m[1]);
      });
      return [...names];
    })
  ).catch(() => []);
}



async function getDashboard(oltId) {
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  return cached(`dash:${olt.id}`, 30000, () =>
    withLock(olt.id, async () => {
      const cmds = ['terminal length 0', 'show card', 'show gpon onu state', 'show gpon onu uncfg'];
      const out = await runCommands(olt, cmds);
      const state = parseOnuState(out['show gpon onu state']);
      // enrich tiap ONU dgn pelanggan (dari olt_link, baca DB cepat)
      const linkMap = await getLinkMap(olt.id);
      // serial massal (baseinfo per PON, 1 sesi SSH) — best-effort
      let snMap = {};
      try {
        const pons = [...new Set(state.onus.map((o) => o.index.split(':')[0]))];
        if (pons.length) snMap = await getSnMap(olt, pons);
      } catch (e) { snMap = {}; }
      let matched = 0, voucher = 0;
      const onus = state.onus.map((o) => {
        const lk = linkMap[o.index];
        const bi = snMap[o.index];
        if (lk && lk.pelanggan) matched++;
        if (lk && lk.tag === 'voucher') voucher++;
        return {
          ...o,
          sn: (bi && bi.sn) || (lk && lk.sn) || null,
          type: (bi && bi.type) || null,
          pelanggan: lk ? lk.pelanggan : null,
          tag: lk ? lk.tag : null,
        };
      });
      return {
        olt: { id: olt.id, name: olt.name, model: olt.model },
        cards: parseCard(out['show card']),
        summary: { online: state.online, offline: state.offline, total: state.total, matched, voucher },
        onus,
        uncfg: parseUncfg(out['show gpon onu uncfg']),
        ts: Date.now(),
      };
    })
  );
}

// Detail + power + pelanggan utk 1 ONU (dipakai modal)
async function getOnuInfo(oltId, index) {
  if (!validIndex(index)) throw new Error('Index ONU tidak valid (format: 1/8/1:1)');
  const [detail, power, linkMap] = await Promise.all([
    getOnuDetail(oltId, index),
    getOnuPower(oltId, index),
    getLinkMap(oltId),
  ]);
  let pelanggan = linkMap[index] ? linkMap[index].pelanggan : null;
  const source = linkMap[index] ? linkMap[index].source : null;
  const tag = linkMap[index] ? linkMap[index].tag : null;
  // kalau belum ke-link & bukan voucher: tawarkan saran / kandidat
  let suggestion = null;
  let candidates = [];
  if (!pelanggan && tag !== 'voucher' && detail && (detail.name || detail.sn) && db) {
    try {
      const ctx = await buildContext();
      const r = resolveMatch({ sn: detail.sn, name: detail.name }, ctx);
      if (r.pelanggan_id) {
        const rows = await db.query(
          'SELECT id, nama, username, status, tgl_expired FROM pelanggan WHERE id=?', [r.pelanggan_id]
        );
        if (rows[0]) suggestion = { ...rows[0], tgl_expired: toYMD(rows[0].tgl_expired), billing: billingStatus(rows[0]), via: r.source };
      } else {
        candidates = await suggestCandidates(detail.name);
      }
    } catch (e) { /* abaikan */ }
  }
  return { detail, power, pelanggan, source, tag, suggestion, candidates };
}

async function getOnuState(oltId) {
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  return cached(`state:${olt.id}`, 20000, () =>
    withLock(olt.id, async () => {
      const out = await runCommands(olt, ['terminal length 0', 'show gpon onu state']);
      return parseOnuState(out['show gpon onu state']);
    })
  );
}

async function getUncfg(oltId) {
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  return cached(`uncfg:${olt.id}`, 15000, () =>
    withLock(olt.id, async () => {
      const out = await runCommands(olt, ['show gpon onu uncfg']);
      return parseUncfg(out['show gpon onu uncfg']);
    })
  );
}

function validIndex(idx) {
  return /^\d+\/\d+\/\d+:\d+$/.test(idx);
}

async function getOnuPower(oltId, index) {
  if (!validIndex(index)) throw new Error('Index ONU tidak valid (format: 1/8/1:1)');
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  return cached(`power:${olt.id}:${index}`, 15000, () =>
    withLock(olt.id, async () => {
      const cmd = `show pon power attenuation gpon-onu_${index}`;
      const out = await runCommands(olt, [cmd]);
      return parsePower(out[cmd]);
    })
  );
}

async function getOnuDetail(oltId, index) {
  if (!validIndex(index)) throw new Error('Index ONU tidak valid (format: 1/8/1:1)');
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  return cached(`detail:${olt.id}:${index}`, 15000, () =>
    withLock(olt.id, async () => {
      const cmd = `show gpon onu detail-info gpon-onu_${index}`;
      const out = await runCommands(olt, [cmd]);
      return parseDetail(out[cmd]);
    })
  );
}

// Statistik traffic 1 ONU (read-only)
async function getOnuTraffic(oltId, index) {
  if (!validIndex(index)) throw new Error('Index ONU tidak valid');
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  return cached(`traffic:${olt.id}:${index}`, 5000, () =>
    withLock(olt.id, async () => {
      const cmd = `show interface gpon-onu_${index}`;
      const out = await runCommands(olt, ['terminal length 0', cmd], { timeout: 25000 });
      return parseTraffic(out[cmd]);
    })
  );
}

// RX power + traffic dalam 1 sesi SSH (buat isi tabel progresif).
async function getOnuMetrics(oltId, index) {
  if (!validIndex(index)) throw new Error('Index ONU tidak valid');
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  return cached(`metrics:${olt.id}:${index}`, 5000, () =>
    withLock(olt.id, async () => {
      const pcmd = `show pon power attenuation gpon-onu_${index}`;
      const tcmd = `show interface gpon-onu_${index}`;
      const out = await runCommands(olt, ['terminal length 0', pcmd, tcmd], { timeout: 30000 });
      const p = parsePower(out[pcmd]);
      const t = parseTraffic(out[tcmd]);
      return {
        rx: p ? p.onuRx : null,
        att: p ? p.attenuationDown : null,
        downBps: (t && t.outRate != null) ? t.outRate * 8 : null,
        upBps: (t && t.inRate != null) ? t.inRate * 8 : null,
      };
    })
  );
}

// Running-config 1 ONU (read-only, teks mentah)
async function getOnuConfig(oltId, index) {
  if (!validIndex(index)) throw new Error('Index ONU tidak valid');
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  return cached(`config:${olt.id}:${index}`, 10000, () =>
    withLock(olt.id, async () => {
      const cmd = `show running-config interface gpon-onu_${index}`;
      const cmdMng = `show running-config interface pon-onu-mng_gpon-onu_${index}`;
      const out = await runCommands(olt, ['terminal length 0', cmd, cmdMng], { timeout: 30000 });
      const clean = (t) => (t || '').replace(/^Building configuration\.\.\.\s*/i, '').replace(/\n?end\s*$/i, '').trim();
      const main = clean(out[cmd]);
      let mng = clean(out[cmdMng]);
      if (/Invalid|%Error|%Code/i.test(mng)) mng = '';
      return { config: main, ponMng: mng };
    })
  );
}

// ===========================================================================
// FASE 3: WRITE ACTIONS (reboot / disable / enable / restore / delete)
// Command terkonfirmasi via ZTE "?" help. Whitelist ketat, dry-run default.
// ===========================================================================

// Tingkat bahaya tiap action (buat UI nentuin konfirmasi berlapis)
const ACTION_META = {
  reboot:       { label: 'Reboot ONU', danger: 'medium', write: false, desc: 'ONU restart, internet putus ~1-2 menit.' },
  disable:      { label: 'Disable (lct disable)', danger: 'high', write: false, desc: 'Kunci ONU, semua fungsi user diblokir.' },
  enable:       { label: 'Enable (lct enable)', danger: 'low', write: false, desc: 'Buka kunci ONU.' },
  restore:      { label: 'Factory Reset', danger: 'critical', write: false, desc: 'Reset ONU ke setelan pabrik (config WiFi/dll hilang).' },
  restore_wifi: { label: 'Reset WiFi', danger: 'high', write: false, desc: 'Reset setelan WiFi ONU ke default.' },
  delete:       { label: 'Hapus / Unregister', danger: 'critical', write: true, desc: 'Hapus ONU dari OLT permanen (write). Pelanggan offline total.' },
};

function buildActionCommands(action, pon, onu) {
  const idx = `${pon}:${onu}`;
  const mng = ['configure terminal', `pon-onu-mng gpon-onu_${idx}`];
  switch (action) {
    case 'reboot':       return [...mng, 'reboot', 'end'];
    case 'disable':      return [...mng, 'lct disable', 'end'];
    case 'enable':       return [...mng, 'lct enable', 'end'];
    case 'restore':      return [...mng, 'restore factory', 'end'];
    case 'restore_wifi': return [...mng, 'restore wifi', 'end'];
    case 'delete':       return ['configure terminal', `interface gpon-olt_${pon}`, `no onu ${onu}`, 'end', 'write'];
    default: throw new Error('Action tidak dikenal: ' + action);
  }
}

/**
 * Eksekusi write action ke 1 ONU. DEFAULT DRY-RUN.
 * params: { index:"1/8/2:15", action, commit:false }
 * commit:true baru kirim ke OLT.
 */
async function onuAction(oltId, params = {}) {
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  const action = (params.action || '').trim();
  const meta = ACTION_META[action];
  if (!meta) throw new Error('Action tidak diizinkan: ' + action);

  const index = (params.index || '').trim();
  if (!validIndex(index)) throw new Error('Index ONU tidak valid (format 1/8/2:15)');
  const [pon, onu] = index.split(':');
  if (!/^\d+\/\d+\/\d+$/.test(pon) || !/^\d+$/.test(onu)) throw new Error('Index ONU tidak valid');
  if (Number(onu) < 1 || Number(onu) > 128) throw new Error('Nomor ONU di luar range 1-128');

  const cmds = buildActionCommands(action, pon, onu);
  const dryRun = params.commit !== true;

  if (dryRun) {
    return { dryRun: true, action, label: meta.label, danger: meta.danger, index, commands: cmds };
  }

  return withLock(olt.id, async () => {
    const out = await runCommands(olt, ['terminal length 0', ...cmds], { timeout: 90000, autoConfirm: true });
    const transcript = cmds.map((c) => `${c}\n${out[c] || ''}`).join('\n');
    const errLine = (transcript.match(/%Error[^\n]*|%Code[^\n]*|fault[^\n]*9\d{3}[^\n]*/i) || [])[0];
    // catat log aksi
    try {
      if (db) {
        await db.query(
          'INSERT INTO olt_action_log (olt_id, onu_index, action, ok, dibuat) VALUES (?,?,?,?,NOW())',
          [olt.id, index, action, errLine ? 0 : 1]
        ).catch(() => {});
      }
    } catch (e) {}
    if (errLine) throw new Error('OLT menolak command: ' + errLine.trim());
    // invalidasi cache
    cache.delete(`dash:${olt.id}`); cache.delete(`state:${olt.id}`);
    cache.delete(`detail:${olt.id}:${index}`); cache.delete(`config:${olt.id}:${index}`);
    return { ok: true, action, label: meta.label, index, transcript };
  });
}

function listActions() {
  return Object.entries(ACTION_META).map(([id, m]) => ({ id, ...m }));
}

// ===========================================================================
// KONFIGURASI OLT (tambah/edit/hapus lewat panel) — tulis ke config/olt.json
// ===========================================================================
const OLT_ID_RE = /^[a-z0-9_-]{2,32}$/i;
const OLT_HOST_RE = /^[a-z0-9.\-]{3,100}$/i;

function loadOltsRaw() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) { return []; }
}
function writeOltsRaw(list) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(list, null, 2));
}

// List utk form edit — TANPA bocorin password (cuma flag hasPassword).
function listOltsForEdit() {
  return loadOltsRaw().map((o) => ({
    id: o.id, name: o.name || o.id, model: o.model || 'C300',
    host: o.host, port: o.port || 22, username: o.username,
    hasPassword: !!o.password,
    snmp: o.snmp ? {
      hasCommunity: !!o.snmp.community,
      port: o.snmp.port || 161, colDown: o.snmp.colDown || 8, colUp: o.snmp.colUp || 2,
    } : null,
  }));
}

// Tambah / update 1 OLT. Password kosong saat edit = pakai yang lama.
function upsertOlt(cfg = {}) {
  const id = String(cfg.id || '').trim().toLowerCase();
  if (!OLT_ID_RE.test(id)) throw new Error('ID OLT tidak valid (huruf/angka/_/-, 2-32)');
  const host = String(cfg.host || '').trim();
  if (!OLT_HOST_RE.test(host)) throw new Error('Host/IP tidak valid');
  const port = parseInt(cfg.port || 22, 10);
  if (!(port > 0 && port < 65536)) throw new Error('Port tidak valid (1-65535)');
  const username = String(cfg.username || '').trim();
  if (!username) throw new Error('Username kosong');
  const name = String(cfg.name || id).trim();
  const model = String(cfg.model || 'C300').trim();

  const list = loadOltsRaw();
  const idx = list.findIndex((o) => String(o.id).toLowerCase() === id);
  const existing = idx >= 0 ? list[idx] : null;

  let password = cfg.password;
  if ((password == null || password === '') && existing) password = existing.password;
  if (!password) throw new Error('Password kosong');

  // SNMP opsional
  let snmp = existing ? existing.snmp : null;
  if (cfg.snmp && typeof cfg.snmp === 'object') {
    const community = String(cfg.snmp.community || '').trim();
    if (community) {
      snmp = {
        community,
        port: parseInt(cfg.snmp.port || 161, 10) || 161,
        colDown: parseInt(cfg.snmp.colDown || 8, 10) || 8,
        colUp: parseInt(cfg.snmp.colUp || 2, 10) || 2,
      };
    } else if (cfg.snmp.clear) {
      snmp = null; // minta hapus snmp
    } // community kosong tanpa clear -> biarkan yg lama
  }

  const entry = { id, name, model, host, port, username, password };
  if (snmp) entry.snmp = snmp;

  if (idx >= 0) list[idx] = entry; else list.push(entry);
  writeOltsRaw(list);
  try { destroyShell(id); } catch (e) {}           // koneksi lama dibuang (host/pw mungkin ganti)
  cache.delete(`dash:${id}`); cache.delete(`state:${id}`);
  return { id, name, host, port, model, hasSnmp: !!snmp, updated: idx >= 0 };
}

function removeOlt(id) {
  id = String(id || '').trim().toLowerCase();
  if (!OLT_ID_RE.test(id)) throw new Error('ID OLT tidak valid');
  const list = loadOltsRaw();
  const next = list.filter((o) => String(o.id).toLowerCase() !== id);
  if (next.length === list.length) throw new Error('OLT tidak ditemukan');
  if (next.length === 0) throw new Error('Minimal harus ada 1 OLT (tidak boleh kosong)');
  writeOltsRaw(next);
  try { destroyShell(id); } catch (e) {}
  cache.delete(`dash:${id}`); cache.delete(`state:${id}`);
  return { ok: true, removed: id };
}

module.exports = {
  // config
  listOlts, getOlt, loadOlts,
  // high-level
  getDashboard, getOnuState, getUncfg, getOnuPower, getOnuDetail, getOnuInfo,
  getOnuTraffic, getOnuMetrics, getOnuConfig,
  // matching
  ensureSchema, syncMatch, getLinkMap, setLink, deleteLink, markVoucher, searchPelanggan,
  billingStatus,
  // fase 2: register (write)
  registerOnu, buildFromTemplate, nextFreeOnu, getTcontProfiles, getTemplates, getPppoeCreds,
  // fase 3: write actions
  onuAction, buildActionCommands, listActions, ACTION_META,
  // konfigurasi OLT (CRUD)
  listOltsForEdit, upsertOlt, removeOlt, loadOltsRaw,
  // low-level
  runCommands,
  // parsers (diekspor biar bisa di-tes)
  parseCard, parseOnuState, parseUncfg, parsePower, parseDetail, parseBaseinfo, resolveMatch, parseTraffic,
};
