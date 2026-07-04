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
const IDLE_CLOSE_MS = 180000; // 3 menit: pool tetap hangat antar-navigasi (kurangi handshake dingin)

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

// Versi publik utk endpoint lazy /sn-map — dipanggil frontend SETELAH daftar
// tampil, biar kolom Serial terisi tanpa memblok load awal. Cache 60 dtk.
async function getSnMapForPons(oltId, pons) {
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  const list = (Array.isArray(pons) ? pons : String(pons || '').split(','))
    .map((s) => String(s).trim()).filter((p) => /^\d+\/\d+\/\d+$/.test(p));
  const uniq = [...new Set(list)].sort();
  if (!uniq.length) return {};
  const key = `snmap:${olt.id}:${uniq.join(',')}`;
  return cached(key, 60000, () => withLock(olt.id, () => getSnMap(olt, uniq)));
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

// Daftar profile VLAN di OLT (buat dropdown wan-ip). Cache 5 menit.
// Perintah C300 (terverifikasi): `show gpon onu profile vlan`
// Output per profil:  "Profile name:  <NAMA>" (diikuti Tag mode / CVLAN / dst).
async function getVlanProfiles(oltId) {
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  return cached(`vlanprofiles:${olt.id}`, 300000, () =>
    withLock(olt.id, async () => {
      const cmd = 'show gpon onu profile vlan';
      const out = await runCommands(olt, ['terminal length 0', cmd], { timeout: 30000 });
      const txt = out[cmd] || '';
      const names = new Set();
      txt.split(/\r?\n/).forEach((line) => {
        const m = line.match(/Profile\s+name\s*[:=]\s*([0-9A-Za-z._\-]+)/i);
        if (m) names.add(m[1]);
      });
      // Nama ber-huruf (mis. PPPOE, ACS) didulukan, lalu profil numerik (300, 102).
      return [...names].sort((a, b) => {
        const an = /^\d+$/.test(a), bn = /^\d+$/.test(b);
        if (an !== bn) return an ? 1 : -1;
        return an ? Number(a) - Number(b) : a.localeCompare(b);
      });
    })
  ).catch(() => []);
}



// Build dashboard (1 round-trip: state+card+uncfg). SN/type TIDAK diambil di
// sini (dipindah ke /sn-map lazy) supaya daftar cepat tampil.
const _dashInflight = new Set();
function _buildDashboard(olt) {
  return withLock(olt.id, async () => {
    const cmds = ['terminal length 0', 'show card', 'show gpon onu state', 'show gpon onu uncfg'];
    const out = await runCommands(olt, cmds);
    const state = parseOnuState(out['show gpon onu state']);
    const linkMap = await getLinkMap(olt.id);
    let matched = 0, voucher = 0;
    const onus = state.onus.map((o) => {
      const lk = linkMap[o.index];
      if (lk && lk.pelanggan) matched++;
      if (lk && lk.tag === 'voucher') voucher++;
      return {
        ...o,
        sn: (lk && lk.sn) || null,   // SN awal dari link DB; sisanya diisi /sn-map
        type: null,
        pelanggan: lk ? lk.pelanggan : null,
        tag: lk ? lk.tag : null,
      };
    });
    const data = {
      olt: { id: olt.id, name: olt.name, model: olt.model },
      cards: parseCard(out['show card']),
      summary: { online: state.online, offline: state.offline, total: state.total, matched, voucher },
      onus,
      uncfg: parseUncfg(out['show gpon onu uncfg']),
      ts: Date.now(),
    };
    cache.set(`dash:${olt.id}`, { ts: Date.now(), val: data });
    return data;
  });
}

async function getDashboard(oltId) {
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  const key = `dash:${olt.id}`;
  const hit = cache.get(key);
  if (hit) {
    // Stale-while-revalidate: sajikan cache seketika; kalau sudah > 30 dtk,
    // refresh di belakang layar (sekali jalan per OLT) tanpa memblok user.
    if (Date.now() - hit.ts >= 30000 && !_dashInflight.has(olt.id)) {
      _dashInflight.add(olt.id);
      _buildDashboard(olt).catch(() => {}).finally(() => _dashInflight.delete(olt.id));
    }
    return hit.val;
  }
  return _buildDashboard(olt);
}

// Detail + power + pelanggan utk 1 ONU (dipakai modal)
// Detail + power 1 ONU dalam SATU sesi SSH (dulu 2 withLock terpisah yang
// saling antre di mutex OLT = 2 round-trip). Menghormati cache detail/power
// 15 dtk; kalau salah satu sudah cache, hanya yang perlu yang diambil.
async function getDetailPower(oltId, index) {
  if (!validIndex(index)) throw new Error('Index ONU tidak valid');
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  const dKey = `detail:${olt.id}:${index}`, pKey = `power:${olt.id}:${index}`;
  const dHit = cache.get(dKey), pHit = cache.get(pKey);
  const dOk = dHit && Date.now() - dHit.ts < 15000;
  const pOk = pHit && Date.now() - pHit.ts < 15000;
  if (dOk && pOk) return { detail: dHit.val, power: pHit.val };
  return withLock(olt.id, async () => {
    const dcmd = `show gpon onu detail-info gpon-onu_${index}`;
    const pcmd = `show pon power attenuation gpon-onu_${index}`;
    const cmds = ['terminal length 0'];
    if (!dOk) cmds.push(dcmd);
    if (!pOk) cmds.push(pcmd);
    const out = await runCommands(olt, cmds, { timeout: 30000 });
    const detail = dOk ? dHit.val : parseDetail(out[dcmd]);
    const power = pOk ? pHit.val : parsePower(out[pcmd]);
    if (!dOk) cache.set(dKey, { ts: Date.now(), val: detail });
    if (!pOk) cache.set(pKey, { ts: Date.now(), val: power });
    return { detail, power };
  });
}

async function getOnuInfo(oltId, index) {
  if (!validIndex(index)) throw new Error('Index ONU tidak valid (format: 1/8/1:1)');
  const [{ detail, power }, linkMap] = await Promise.all([
    getDetailPower(oltId, index),
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

// Metrik banyak ONU dalam 1 sesi SSH. `fields`='rx' -> hanya RX/signal
// (cepat, buat fase-1); default -> RX + traffic. Cache dipisah rx:/tr: (12 dtk)
// supaya fase-2 (traffic) tak mengulang ambil RX, dan pagination snappy.
async function getOnuMetricsBatch(oltId, indexes, fields) {
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  const want = String(fields || '') === 'rx' ? 'rx' : 'all';
  const list = (Array.isArray(indexes) ? indexes : String(indexes || '').split(','))
    .map((s) => String(s).trim()).filter((s) => validIndex(s));
  const uniq = [...new Set(list)].slice(0, 64);
  const TTL = 12000;
  const rxHit = {}, trHit = {}, needRx = [], needTr = [];
  for (const idx of uniq) {
    const r = cache.get(`rx:${olt.id}:${idx}`);
    if (r && Date.now() - r.ts < TTL) rxHit[idx] = r.val; else needRx.push(idx);
    if (want === 'all') {
      const t = cache.get(`tr:${olt.id}:${idx}`);
      if (t && Date.now() - t.ts < TTL) trHit[idx] = t.val; else needTr.push(idx);
    }
  }
  if (needRx.length || needTr.length) {
    await withLock(olt.id, async () => {
      const cmds = ['terminal length 0'];
      needRx.forEach((idx) => cmds.push(`show pon power attenuation gpon-onu_${idx}`));
      needTr.forEach((idx) => cmds.push(`show interface gpon-onu_${idx}`));
      const out = await runCommands(olt, cmds, { timeout: Math.max(30000, (needRx.length + needTr.length) * 3000) });
      needRx.forEach((idx) => {
        const p = parsePower(out[`show pon power attenuation gpon-onu_${idx}`]);
        const v = { rx: p ? p.onuRx : null, att: p ? p.attenuationDown : null };
        rxHit[idx] = v; cache.set(`rx:${olt.id}:${idx}`, { ts: Date.now(), val: v });
      });
      needTr.forEach((idx) => {
        const t = parseTraffic(out[`show interface gpon-onu_${idx}`]);
        const v = { downBps: (t && t.outRate != null) ? t.outRate * 8 : null, upBps: (t && t.inRate != null) ? t.inRate * 8 : null };
        trHit[idx] = v; cache.set(`tr:${olt.id}:${idx}`, { ts: Date.now(), val: v });
      });
    });
  }
  const result = {};
  uniq.forEach((idx) => {
    const rx = rxHit[idx] || { rx: null, att: null };
    if (want === 'rx') { result[idx] = { rx: rx.rx, att: rx.att }; }
    else { const tr = trHit[idx] || { downBps: null, upBps: null }; result[idx] = { rx: rx.rx, att: rx.att, downBps: tr.downBps, upBps: tr.upBps }; }
  });
  return result;
}

// Running-config 1 ONU (read-only, teks mentah)
async function getOnuConfig(oltId, index) {
  if (!validIndex(index)) throw new Error('Index ONU tidak valid');
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  return cached(`config:${olt.id}:${index}`, 10000, () =>
    withLock(olt.id, async () => {
      const cmd = `show running-config interface gpon-onu_${index}`;
      // Blok pon-onu-mng (service/vlan port/tr069/ssid) dibaca via 'show onu
      // running config' — terkonfirmasi pada C300 ini. Sintaks lama
      // 'show running-config interface pon-onu-mng_...' DITOLAK (ponMng kosong).
      const cmdMng = `show onu running config gpon-onu_${index}`;
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
// TR069 (ACS) — baca / set config TR069 per ONU. DRY-RUN default.
// Format C300 (terkonfirmasi dari running-config):
//   pon-onu-mng gpon-onu_<index>
//     tr069-mgmt 1 state unlock
//     tr069-mgmt 1 acs <URL> validate basic username <user> password <pass>
//     tr069-mgmt 1 tag pri <pri> vlan <vlan>
// ===========================================================================

// Parse output 'show gpon remote-onu tr069 gpon-onu_<index>' (format C300).
// Contoh:
//   VEIP ID:              1
//   Admin status:         unlock
//   ACS:                  http://dash.rfnet.id:7547
//      Validation scheme: basic
//      Username         : acs
//      Password         : acsadmin321
//   Tag:                  priority : 0, vlan : 102
function parseTr069(rawShow) {
  const text = String(rawShow || '');
  const out = { enabled: null, acsUrl: '', user: '', vlan: '', priority: '', mode: '', raw: text.trim() };
  if (/Invalid|%Error|%Code/i.test(text) || !text.trim()) return out;
  let m;
  if ((m = text.match(/Admin status\s*:\s*(\S+)/i))) out.enabled = /unlock/i.test(m[1]);
  if ((m = text.match(/ACS\s*:\s*(\S+)/i)) && !/^\.\.\.$/.test(m[1])) out.acsUrl = m[1];
  if ((m = text.match(/Username\s*:\s*(\S+)/i))) out.user = m[1];
  if ((m = text.match(/Tag\s*:\s*priority\s*:\s*(\d+)\s*,\s*vlan\s*:\s*(\d+)/i))) {
    out.priority = m[1]; out.vlan = m[2]; out.mode = 'tagged';
  } else if (/Tag\s*:/i.test(text)) {
    out.mode = 'untagged';
  }
  return out;
}

async function getTr069(oltId, index) {
  if (!validIndex(index)) throw new Error('Index ONU tidak valid');
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  return cached(`tr069:${olt.id}:${index}`, 10000, () =>
    withLock(olt.id, async () => {
      const cmd = `show gpon remote-onu tr069 gpon-onu_${index}`;
      const out = await runCommands(olt, ['terminal length 0', cmd], { timeout: 30000 });
      return parseTr069(out[cmd]);
    })
  );
}

// Validasi ketat input TR069 sebelum menyusun command (cegah injeksi CLI).
function validateTr069(p) {
  const acsUrl = String(p.acsUrl || '').trim();
  const user = String(p.user || '').trim();
  const pass = String(p.pass || '').trim();
  const vlan = String(p.vlan || '').trim();
  const pri = String(p.priority ?? '0').trim();
  if (!/^https?:\/\/[a-z0-9.\-]+:\d{2,5}(\/\S*)?$/i.test(acsUrl)) throw new Error('ACS URL tidak valid (contoh: http://dash.rfnet.id:7547)');
  if (!/^[a-z0-9_.\-]{1,32}$/i.test(user)) throw new Error('Username ACS tidak valid');
  if (!/^[a-z0-9_.\-!@#]{1,32}$/i.test(pass)) throw new Error('Password ACS tidak valid');
  if (vlan && !/^\d{1,4}$/.test(vlan)) throw new Error('VLAN tidak valid');
  if (vlan && (Number(vlan) < 1 || Number(vlan) > 4094)) throw new Error('VLAN di luar range 1-4094');
  if (!/^[0-7]$/.test(pri)) throw new Error('Priority harus 0-7');
  return { acsUrl, user, pass, vlan, pri, enable: p.enable !== false, tagged: !!vlan };
}

function buildTr069Commands(index, v) {
  const cmds = [`configure terminal`, `pon-onu-mng gpon-onu_${index}`];
  cmds.push(`tr069-mgmt 1 state ${v.enable ? 'unlock' : 'lock'}`);
  cmds.push(`tr069-mgmt 1 acs ${v.acsUrl} validate basic username ${v.user} password ${v.pass}`);
  if (v.tagged) cmds.push(`tr069-mgmt 1 tag pri ${v.pri} vlan ${v.vlan}`);
  cmds.push('end');
  return cmds;
}

// Sensor password untuk preview/log (jangan bocorkan plaintext).
function maskTr069(cmds) {
  return cmds.map((c) => c.replace(/(password\s+)(\S+)/i, '$1********'));
}

async function onuTr069(oltId, params = {}) {
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  const index = (params.index || '').trim();
  if (!validIndex(index)) throw new Error('Index ONU tidak valid (format 1/8/2:15)');
  const v = validateTr069(params);
  const cmds = buildTr069Commands(index, v);
  const dryRun = params.commit !== true;

  if (dryRun) {
    return { dryRun: true, index, commands: maskTr069(cmds), vlan: v.vlan || null, tagged: v.tagged, enable: v.enable };
  }

  return withLock(olt.id, async () => {
    const out = await runCommands(olt, ['terminal length 0', ...cmds], { timeout: 90000, autoConfirm: true });
    const transcript = cmds.map((c) => `${c}\n${out[c] || ''}`).join('\n');
    const errLine = (transcript.match(/%Error[^\n]*|%Code[^\n]*|fault[^\n]*9\d{3}[^\n]*/i) || [])[0];
    try {
      if (db) {
        await db.query(
          'INSERT INTO olt_action_log (olt_id, onu_index, action, ok, dibuat) VALUES (?,?,?,?,NOW())',
          [olt.id, index, 'tr069', errLine ? 0 : 1]
        ).catch(() => {});
      }
    } catch (e) {}
    if (errLine) throw new Error('OLT menolak command: ' + errLine.trim());
    cache.delete(`config:${olt.id}:${index}`); cache.delete(`detail:${olt.id}:${index}`);
    cache.delete(`tr069:${olt.id}:${index}`);
    return { ok: true, index, transcript: maskTr069(transcript.split('\n')).join('\n') };
  });
}

// ===========================================================================
// T-CONT — baca/tambah/hapus per ONU. DRY-RUN default.
// Format C300: (dalam interface gpon-onu_<index>)
//   tcont <id> name <nama> profile <profil>
//   no tcont <id>   (hapus)
// Baca: dari getOnuConfig().config (blok interface gpon-onu).
// ===========================================================================
function parseTcont(rawConfig) {
  const out = [];
  String(rawConfig || '').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*tcont\s+(\d+)\s+name\s+(\S+)\s+profile\s+(\S+)/i);
    if (m) out.push({ id: m[1], name: m[2], profile: m[3] });
  });
  return out;
}

async function getTcont(oltId, index) {
  const cfg = await getOnuConfig(oltId, index);
  return parseTcont(cfg.config);
}

function validateTcont(p) {
  const id = String(p.tcontId || '').trim();
  const name = String(p.name || '').trim();
  const profile = String(p.profile || '').trim();
  if (!/^[1-8]$/.test(id)) throw new Error('ID T-CONT harus 1-8');
  if (name && !/^[a-z0-9_.\-]{1,32}$/i.test(name)) throw new Error('Nama T-CONT tidak valid');
  if (profile && !/^[a-z0-9_.\-]{1,32}$/i.test(profile)) throw new Error('Nama profil tidak valid');
  return { id, name: name || `tcont${id}`, profile: profile || 'default', remove: !!p.remove };
}

function buildTcontCommands(index, v) {
  const cmds = ['configure terminal', `interface gpon-onu_${index}`];
  if (v.remove) cmds.push(`no tcont ${v.id}`);
  else cmds.push(`tcont ${v.id} name ${v.name} profile ${v.profile}`);
  cmds.push('end');
  return cmds;
}

async function onuTcont(oltId, params = {}) {
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  const index = (params.index || '').trim();
  if (!validIndex(index)) throw new Error('Index ONU tidak valid');
  const v = validateTcont(params);
  const cmds = buildTcontCommands(index, v);
  const dryRun = params.commit !== true;
  if (dryRun) return { dryRun: true, index, commands: cmds, remove: v.remove };

  return withLock(olt.id, async () => {
    const out = await runCommands(olt, ['terminal length 0', ...cmds], { timeout: 90000, autoConfirm: true });
    const transcript = cmds.map((c) => `${c}\n${out[c] || ''}`).join('\n');
    const errLine = (transcript.match(/%Error[^\n]*|%Code[^\n]*/i) || [])[0];
    try { if (db) await db.query('INSERT INTO olt_action_log (olt_id, onu_index, action, ok, dibuat) VALUES (?,?,?,?,NOW())', [olt.id, index, v.remove ? 'tcont-del' : 'tcont-add', errLine ? 0 : 1]).catch(() => {}); } catch (e) {}
    if (errLine) throw new Error('OLT menolak command: ' + errLine.trim());
    cache.delete(`config:${olt.id}:${index}`);
    return { ok: true, index, transcript };
  });
}

// ===========================================================================
// GEM PORT — baca/tambah/hapus per ONU. DRY-RUN default.
// Format C300: (dalam interface gpon-onu_<index>)
//   gemport <id> name <nama> tcont <tcont_id>
//   no gemport <id>
// ===========================================================================
function parseGemport(rawConfig) {
  const out = [];
  String(rawConfig || '').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*gemport\s+(\d+)\s+name\s+(\S+)\s+tcont\s+(\d+)/i);
    if (m) out.push({ id: m[1], name: m[2], tcont: m[3] });
  });
  return out;
}

async function getGemport(oltId, index) {
  const cfg = await getOnuConfig(oltId, index);
  return parseGemport(cfg.config);
}

function validateGemport(p) {
  const id = String(p.gemId || '').trim();
  const name = String(p.name || '').trim();
  const tcont = String(p.tcont || '').trim();
  if (!/^\d{1,2}$/.test(id) || Number(id) < 1 || Number(id) > 32) throw new Error('ID GEM Port harus 1-32');
  if (name && !/^[a-z0-9_.\-]{1,32}$/i.test(name)) throw new Error('Nama GEM Port tidak valid');
  if (!p.remove && !/^[1-8]$/.test(tcont)) throw new Error('T-CONT ID harus 1-8');
  return { id, name: name || `gemport${id}`, tcont, remove: !!p.remove };
}

function buildGemportCommands(index, v) {
  const cmds = ['configure terminal', `interface gpon-onu_${index}`];
  if (v.remove) cmds.push(`no gemport ${v.id}`);
  else cmds.push(`gemport ${v.id} name ${v.name} tcont ${v.tcont}`);
  cmds.push('end');
  return cmds;
}

async function onuGemport(oltId, params = {}) {
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  const index = (params.index || '').trim();
  if (!validIndex(index)) throw new Error('Index ONU tidak valid');
  const v = validateGemport(params);
  const cmds = buildGemportCommands(index, v);
  if (params.commit !== true) return { dryRun: true, index, commands: cmds, remove: v.remove };

  return withLock(olt.id, async () => {
    const out = await runCommands(olt, ['terminal length 0', ...cmds], { timeout: 90000, autoConfirm: true });
    const transcript = cmds.map((c) => `${c}\n${out[c] || ''}`).join('\n');
    const errLine = (transcript.match(/%Error[^\n]*|%Code[^\n]*/i) || [])[0];
    try { if (db) await db.query('INSERT INTO olt_action_log (olt_id, onu_index, action, ok, dibuat) VALUES (?,?,?,?,NOW())', [olt.id, index, v.remove ? 'gem-del' : 'gem-add', errLine ? 0 : 1]).catch(() => {}); } catch (e) {}
    if (errLine) throw new Error('OLT menolak command: ' + errLine.trim());
    cache.delete(`config:${olt.id}:${index}`);
    return { ok: true, index, transcript };
  });
}

// ===========================================================================
// SERVICE (service-port) — baca/tambah/hapus per ONU. DRY-RUN default.
// Format C300: (dalam interface gpon-onu_<index>)
//   service-port <id> vport <n> user-vlan <vlan> vlan <vlan>
//   service-port <id> description <desc>
//   no service-port <id>
// ===========================================================================
function parseService(rawConfig) {
  const map = {};
  String(rawConfig || '').split(/\r?\n/).forEach((line) => {
    let m = line.match(/^\s*service-port\s+(\d+)\s+vport\s+(\d+)\s+user-vlan\s+(\d+)\s+vlan\s+(\d+)/i);
    if (m) { map[m[1]] = map[m[1]] || { id: m[1] }; map[m[1]].vport = m[2]; map[m[1]].userVlan = m[3]; map[m[1]].vlan = m[4]; return; }
    m = line.match(/^\s*service-port\s+(\d+)\s+description\s+(.+?)\s*$/i);
    if (m) { map[m[1]] = map[m[1]] || { id: m[1] }; map[m[1]].description = m[2]; }
  });
  return Object.values(map).sort((a, b) => Number(a.id) - Number(b.id));
}

async function getService(oltId, index) {
  const cfg = await getOnuConfig(oltId, index);
  return parseService(cfg.config);
}

function validateService(p) {
  const id = String(p.svcId || '').trim();
  const vport = String(p.vport || p.svcId || '').trim();
  const vlan = String(p.vlan || '').trim();
  const desc = String(p.description || '').trim();
  if (!/^\d{1,2}$/.test(id) || Number(id) < 1 || Number(id) > 32) throw new Error('ID Service harus 1-32');
  if (!p.remove) {
    if (!/^\d{1,2}$/.test(vport)) throw new Error('vport tidak valid');
    if (!/^\d{1,4}$/.test(vlan) || Number(vlan) < 1 || Number(vlan) > 4094) throw new Error('VLAN harus 1-4094');
    if (desc && !/^[a-z0-9_.\- ]{1,32}$/i.test(desc)) throw new Error('Deskripsi tidak valid');
  }
  return { id, vport, vlan, desc, remove: !!p.remove };
}

function buildServiceCommands(index, v) {
  const cmds = ['configure terminal', `interface gpon-onu_${index}`];
  if (v.remove) {
    cmds.push(`no service-port ${v.id}`);
  } else {
    cmds.push(`service-port ${v.id} vport ${v.vport} user-vlan ${v.vlan} vlan ${v.vlan}`);
    if (v.desc) cmds.push(`service-port ${v.id} description ${v.desc}`);
  }
  cmds.push('end');
  return cmds;
}

async function onuService(oltId, params = {}) {
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  const index = (params.index || '').trim();
  if (!validIndex(index)) throw new Error('Index ONU tidak valid');
  const v = validateService(params);
  const cmds = buildServiceCommands(index, v);
  if (params.commit !== true) return { dryRun: true, index, commands: cmds, remove: v.remove };

  return withLock(olt.id, async () => {
    const out = await runCommands(olt, ['terminal length 0', ...cmds], { timeout: 90000, autoConfirm: true });
    const transcript = cmds.map((c) => `${c}\n${out[c] || ''}`).join('\n');
    const errLine = (transcript.match(/%Error[^\n]*|%Code[^\n]*/i) || [])[0];
    try { if (db) await db.query('INSERT INTO olt_action_log (olt_id, onu_index, action, ok, dibuat) VALUES (?,?,?,?,NOW())', [olt.id, index, v.remove ? 'svc-del' : 'svc-add', errLine ? 0 : 1]).catch(() => {}); } catch (e) {}
    if (errLine) throw new Error('OLT menolak command: ' + errLine.trim());
    cache.delete(`config:${olt.id}:${index}`);
    return { ok: true, index, transcript };
  });
}

// ===========================================================================
// PORTS (vlan port) — baca/set VLAN per port. DRY-RUN default.
// Format C300 (terkonfirmasi): (dalam pon-onu-mng gpon-onu_<index>)
//   vlan port <port> mode <tag|transparent|trunk|hybrid> vlan <vlan>
//   no vlan port <port>
//   port: eth_0/1..4, wifi_0/1..4, veip_0/1
// Baca: dari ponMng ('show onu running config') baris 'vlan port ...'
// ===========================================================================
function parsePorts(rawMng) {
  const out = [];
  String(rawMng || '').split(/\r?\n/).forEach((line) => {
    // Format C300: vlan port <port> mode <mode> [pri <n>] [vlan <id>]
    const m = line.match(/^\s*vlan\s+port\s+(\S+)\s+mode\s+(\S+)(?:\s+pri\s+(\d+))?(?:\s+vlan\s+(\d+))?/i);
    if (m) out.push({ port: m[1], mode: m[2], priority: m[3] || '', vlan: m[4] || '' });
  });
  return out;
}

async function getPorts(oltId, index) {
  const cfg = await getOnuConfig(oltId, index);
  return parsePorts(cfg.ponMng);
}

const PORT_MODES = ['tag', 'transparent', 'trunk', 'hybrid'];
function validatePorts(p) {
  const port = String(p.port || '').trim();
  const mode = String(p.mode || '').trim().toLowerCase();
  const vlan = String(p.vlan || '').trim();
  const pri = String(p.priority || '').trim();
  if (!/^(eth|wifi|veip|xdsl)_\d+\/\d+$/i.test(port)) throw new Error('Port tidak valid (contoh: eth_0/1, wifi_0/2)');
  if (p.remove) return { port, remove: true };
  if (!PORT_MODES.includes(mode)) throw new Error('Mode harus: ' + PORT_MODES.join('/'));
  if ((mode === 'tag' || mode === 'hybrid') && (!/^\d{1,4}$/.test(vlan) || Number(vlan) < 1 || Number(vlan) > 4094)) throw new Error('VLAN 1-4094 wajib untuk mode tag/hybrid');
  if (pri && !/^[0-7]$/.test(pri)) throw new Error('Priority 0-7');
  return { port, mode, vlan, pri, remove: false };
}

function buildPortsCommands(index, v) {
  const cmds = ['configure terminal', `pon-onu-mng gpon-onu_${index}`];
  if (v.remove) {
    cmds.push(`no vlan port ${v.port}`);
  } else {
    // Urutan terkonfirmasi C300: mode <m> [pri <n>] [vlan <id>]
    let line = `vlan port ${v.port} mode ${v.mode}`;
    if (v.pri) line += ` pri ${v.pri}`;
    if (v.mode === 'tag' || v.mode === 'hybrid') line += ` vlan ${v.vlan}`;
    cmds.push(line);
  }
  cmds.push('end');
  return cmds;
}

async function onuPorts(oltId, params = {}) {
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  const index = (params.index || '').trim();
  if (!validIndex(index)) throw new Error('Index ONU tidak valid');
  const v = validatePorts(params);
  const cmds = buildPortsCommands(index, v);
  if (params.commit !== true) return { dryRun: true, index, commands: cmds, remove: v.remove };

  return withLock(olt.id, async () => {
    const out = await runCommands(olt, ['terminal length 0', ...cmds], { timeout: 90000, autoConfirm: true });
    const transcript = cmds.map((c) => `${c}\n${out[c] || ''}`).join('\n');
    const errLine = (transcript.match(/%Error[^\n]*|%Code[^\n]*/i) || [])[0];
    try { if (db) await db.query('INSERT INTO olt_action_log (olt_id, onu_index, action, ok, dibuat) VALUES (?,?,?,?,NOW())', [olt.id, index, v.remove ? 'port-del' : 'port-set', errLine ? 0 : 1]).catch(() => {}); } catch (e) {}
    if (errLine) throw new Error('OLT menolak command: ' + errLine.trim());
    cache.delete(`config:${olt.id}:${index}`);
    return { ok: true, index, transcript };
  });
}

// ===========================================================================
// ONU SERVICE — baca/tambah/hapus per ONU. DRY-RUN default.
// Format C300 (terkonfirmasi dari 'show onu running config'):
//   (dalam pon-onu-mng gpon-onu_<index>)
//   service <nama> gemport <n> vlan <vlan>
//   no service <nama>
// ===========================================================================
function parseOnuService(rawMng) {
  const out = [];
  String(rawMng || '').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*service\s+(\S+)\s+gemport\s+(\d+)\s+vlan\s+(\d+)/i);
    if (m) out.push({ name: m[1], gemport: m[2], vlan: m[3] });
  });
  return out;
}

async function getOnuService(oltId, index) {
  const cfg = await getOnuConfig(oltId, index);
  return parseOnuService(cfg.ponMng);
}

function validateOnuService(p) {
  const name = String(p.name || '').trim();
  const gemport = String(p.gemport || '').trim();
  const vlan = String(p.vlan || '').trim();
  if (!/^[a-z0-9_.\-]{1,32}$/i.test(name)) throw new Error('Nama service tidak valid');
  if (p.remove) return { name, remove: true };
  if (!/^\d{1,2}$/.test(gemport)) throw new Error('GEM port tidak valid');
  if (!/^\d{1,4}$/.test(vlan) || Number(vlan) < 1 || Number(vlan) > 4094) throw new Error('VLAN 1-4094');
  return { name, gemport, vlan, remove: false };
}

function buildOnuServiceCommands(index, v) {
  const cmds = ['configure terminal', `pon-onu-mng gpon-onu_${index}`];
  if (v.remove) cmds.push(`no service ${v.name}`);
  else cmds.push(`service ${v.name} gemport ${v.gemport} vlan ${v.vlan}`);
  cmds.push('end');
  return cmds;
}

async function onuServiceMng(oltId, params = {}) {
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  const index = (params.index || '').trim();
  if (!validIndex(index)) throw new Error('Index ONU tidak valid');
  const v = validateOnuService(params);
  const cmds = buildOnuServiceCommands(index, v);
  if (params.commit !== true) return { dryRun: true, index, commands: cmds, remove: v.remove };

  return withLock(olt.id, async () => {
    const out = await runCommands(olt, ['terminal length 0', ...cmds], { timeout: 90000, autoConfirm: true });
    const transcript = cmds.map((c) => `${c}\n${out[c] || ''}`).join('\n');
    const errLine = (transcript.match(/%Error[^\n]*|%Code[^\n]*/i) || [])[0];
    try { if (db) await db.query('INSERT INTO olt_action_log (olt_id, onu_index, action, ok, dibuat) VALUES (?,?,?,?,NOW())', [olt.id, index, v.remove ? 'onusvc-del' : 'onusvc-add', errLine ? 0 : 1]).catch(() => {}); } catch (e) {}
    if (errLine) throw new Error('OLT menolak command: ' + errLine.trim());
    cache.delete(`config:${olt.id}:${index}`);
    return { ok: true, index, transcript };
  });
}

// ===========================================================================
// WAN IP (wan-ip) — baca/set per ONU. 3 mode: pppoe/static/dhcp. DRY-RUN default.
// Format C300 (terkonfirmasi dari running-config produksi):
//   wan-ip <id> mode pppoe username <u> password <p> [service-name <s>] vlan-profile <vp> [host <h>]
//   wan-ip <id> mode static ip-profile <ip-prof> vlan-profile <vp> [host <h>]
//   wan-ip <id> mode dhcp vlan-profile <vp> [host <h>]
//   no wan-ip <id>
// ===========================================================================
function parseWanIp(rawMng) {
  const out = [];
  String(rawMng || '').split(/\r?\n/).forEach((line) => {
    let m = line.match(/^\s*wan-ip\s+(\d+)\s+mode\s+pppoe\s+username\s+(\S+)\s+password\s+(\S+)(?:\s+service-name\s+(\S+))?(?:\s+vlan-profile\s+(\S+))?(?:\s+host\s+(\d+))?/i);
    if (m) { out.push({ id: m[1], mode: 'pppoe', username: m[2], password: m[3], serviceName: m[4] || '', vlanProfile: m[5] || '', host: m[6] || '' }); return; }
    m = line.match(/^\s*wan-ip\s+(\d+)\s+mode\s+static\s+ip-profile\s+(\S+)(?:\s+vlan-profile\s+(\S+))?(?:\s+host\s+(\d+))?/i);
    if (m) { out.push({ id: m[1], mode: 'static', ipProfile: m[2], vlanProfile: m[3] || '', host: m[4] || '' }); return; }
    m = line.match(/^\s*wan-ip\s+(\d+)\s+mode\s+dhcp(?:\s+vlan-profile\s+(\S+))?(?:\s+host\s+(\d+))?/i);
    if (m) { out.push({ id: m[1], mode: 'dhcp', vlanProfile: m[2] || '', host: m[3] || '' }); return; }
  });
  return out;
}

async function getWanIp(oltId, index) {
  const cfg = await getOnuConfig(oltId, index);
  return parseWanIp(cfg.ponMng);
}

function validateWanIp(p) {
  const id = String(p.wanId || '1').trim();
  const mode = String(p.mode || '').trim().toLowerCase();
  const vlanProfile = String(p.vlanProfile || '').trim();
  const host = String(p.host || '1').trim();
  if (!/^\d{1,3}$/.test(id) || Number(id) < 1 || Number(id) > 255) throw new Error('WAN ID harus 1-255');
  if (p.remove) return { id, remove: true };
  if (!['pppoe', 'static', 'dhcp'].includes(mode)) throw new Error('Mode harus pppoe/static/dhcp');
  if (host && !/^\d{1,3}$/.test(host)) throw new Error('Host tidak valid');
  const vpOk = (s) => !s || /^[a-z0-9_.\-]{1,64}$/i.test(s);
  if (!vpOk(vlanProfile)) throw new Error('VLAN profile tidak valid');
  const r = { id, mode, vlanProfile, host, remove: false };
  if (mode === 'pppoe') {
    r.username = String(p.username || '').trim();
    r.password = String(p.password || '').trim();
    r.serviceName = String(p.serviceName || '').trim();
    if (!/^[a-z0-9_.\-@]{1,128}$/i.test(r.username)) throw new Error('Username PPPoE tidak valid');
    if (!/^[a-z0-9_.\-@!#]{1,128}$/i.test(r.password)) throw new Error('Password PPPoE tidak valid');
    if (r.serviceName && !/^[a-z0-9_.\-]{1,64}$/i.test(r.serviceName)) throw new Error('Service-name tidak valid');
    if (!vlanProfile) throw new Error('VLAN profile wajib untuk PPPoE');
  } else if (mode === 'static') {
    r.ipProfile = String(p.ipProfile || '').trim();
    if (!/^[a-z0-9_.\-]{1,64}$/i.test(r.ipProfile)) throw new Error('IP profile wajib untuk Static');
  } else if (mode === 'dhcp') {
    if (!vlanProfile) throw new Error('VLAN profile wajib untuk DHCP');
  }
  return r;
}

function buildWanIpCommands(index, v) {
  const cmds = ['configure terminal', `pon-onu-mng gpon-onu_${index}`];
  if (v.remove) {
    cmds.push(`no wan-ip ${v.id}`);
  } else if (v.mode === 'pppoe') {
    let l = `wan-ip ${v.id} mode pppoe username ${v.username} password ${v.password}`;
    if (v.serviceName) l += ` service-name ${v.serviceName}`;
    l += ` vlan-profile ${v.vlanProfile}`;
    if (v.host) l += ` host ${v.host}`;
    cmds.push(l);
  } else if (v.mode === 'static') {
    let l = `wan-ip ${v.id} mode static ip-profile ${v.ipProfile}`;
    if (v.vlanProfile) l += ` vlan-profile ${v.vlanProfile}`;
    if (v.host) l += ` host ${v.host}`;
    cmds.push(l);
  } else if (v.mode === 'dhcp') {
    let l = `wan-ip ${v.id} mode dhcp vlan-profile ${v.vlanProfile}`;
    if (v.host) l += ` host ${v.host}`;
    cmds.push(l);
  }
  cmds.push('end');
  return cmds;
}

function maskWanIp(cmds) {
  return cmds.map((c) => c.replace(/(password\s+)(\S+)/i, '$1********'));
}

async function onuWanIp(oltId, params = {}) {
  const olt = getOlt(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  const index = (params.index || '').trim();
  if (!validIndex(index)) throw new Error('Index ONU tidak valid');
  const v = validateWanIp(params);
  const cmds = buildWanIpCommands(index, v);
  if (params.commit !== true) return { dryRun: true, index, commands: maskWanIp(cmds), remove: v.remove, mode: v.mode };

  return withLock(olt.id, async () => {
    const out = await runCommands(olt, ['terminal length 0', ...cmds], { timeout: 90000, autoConfirm: true });
    const transcript = cmds.map((c) => `${c}\n${out[c] || ''}`).join('\n');
    const errLine = (transcript.match(/%Error[^\n]*|%Code[^\n]*/i) || [])[0];
    try { if (db) await db.query('INSERT INTO olt_action_log (olt_id, onu_index, action, ok, dibuat) VALUES (?,?,?,?,NOW())', [olt.id, index, v.remove ? 'wanip-del' : 'wanip-set', errLine ? 0 : 1]).catch(() => {}); } catch (e) {}
    if (errLine) throw new Error('OLT menolak command: ' + errLine.trim());
    cache.delete(`config:${olt.id}:${index}`);
    return { ok: true, index, transcript: maskWanIp(transcript.split('\n')).join('\n') };
  });
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
  // (boleh kosong: sebagian server/pelanggan tidak memakai OLT sama sekali)
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
  getOnuTraffic, getOnuMetrics, getOnuMetricsBatch, getOnuConfig,
  // matching
  ensureSchema, syncMatch, getLinkMap, setLink, deleteLink, markVoucher, searchPelanggan,
  billingStatus,
  // fase 2: register (write)
  registerOnu, buildFromTemplate, nextFreeOnu, getTcontProfiles, getVlanProfiles, getSnMapForPons, getTemplates, getPppoeCreds,
  // fase 3: write actions
  onuAction, buildActionCommands, listActions, ACTION_META,
  // TR069 (ACS)
  getTr069, parseTr069, buildTr069Commands, onuTr069,
  // T-CONT
  getTcont, parseTcont, buildTcontCommands, onuTcont,
  // GEM Port
  getGemport, parseGemport, buildGemportCommands, onuGemport,
  // Service (service-port)
  getService, parseService, buildServiceCommands, onuService,
  // Ports (vlan port)
  getPorts, parsePorts, buildPortsCommands, onuPorts,
  // ONU Service (service ... gemport ... vlan)
  getOnuService, parseOnuService, buildOnuServiceCommands, onuServiceMng,
  // WAN IP (wan-ip: pppoe/static/dhcp)
  getWanIp, parseWanIp, buildWanIpCommands, onuWanIp,
  // konfigurasi OLT (CRUD)
  listOltsForEdit, upsertOlt, removeOlt, loadOltsRaw,
  // low-level
  runCommands,
  // parsers (diekspor biar bisa di-tes)
  parseCard, parseOnuState, parseUncfg, parsePower, parseDetail, parseBaseinfo, resolveMatch, parseTraffic,
};
