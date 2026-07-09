'use strict';
// ===========================================================================
// services/olt-epon-snmp.js — Driver SNMP untuk OLT EPON (monitoring, read-only)
//
// Profil OID per-vendor. Terverifikasi dari OLT asli:
//   VSOL  (enterprise 37950) — tabel ONU: 37950.1.1.5.12.1.9.1.<col>.<idx>
//         col2=PON port, col3=ONU id, col4=status(STRING), col5=MAC(STRING)
//   HSGQ / HIOSO — profil menyusul (butuh snmpwalk OLT masing-masing).
//
// Output getOnuState() dibuat SAMA dengan driver ZTE (services/olt.js):
//   [{ index, sn, state, port, onuId, raw }]
//   index = "<port>:<onuId>"  (mis "5:28"), state = 'online'|'offline'
// ===========================================================================

let snmp;
try { snmp = require('net-snmp'); } catch (e) { snmp = null; }

// ── Profil OID per vendor EPON ──────────────────────────────
const PROFILES = {
  vsol: {
    enterprise: 37950,
    // Tabel ONU: base.<col>.<idx>
    onuBase: '1.3.6.1.4.1.37950.1.1.5.12.1.9.1',
    col: { port: 2, onuId: 3, status: 4, mac: 5 },
    // Status yang dianggap ONLINE (cocokkan substring, lowercase)
    onlineMatch: ['auth success', 'online', 'working', 'up'],
  },
  // hsgq: { ... }  ← isi setelah snmpwalk HSGQ
  hioso: {
    enterprise: 25355,
    structure: 'hioso',
    // Tabel MAC ONU: base.<PONport>.<onuId>.1.1.<sub> = MAC (value). MAC muncul 2x → dedup.
    onuMacBase: '1.3.6.1.4.1.25355.3.2.6.2.1.1.18.1',
    onlineMatch: [],   // SNMP HIOSO tak memisahkan online/offline → presence = online
    slowAgent: true,   // agent HIOSO sangat lambat (~0.35 dtk/OID) → timeout besar + cache panjang
  },
};

function profileFor(olt) {
  const v = String(olt.vendor || '').toLowerCase();
  return PROFILES[v] || null;
}

function toStr(v) {
  if (v == null) return '';
  if (Buffer.isBuffer(v)) return v.toString('utf8').replace(/\u0000+$/, '').trim();
  return String(v).trim();
}

function cfgOf(olt, profile) {
  const c = (olt && olt.snmp) || {};
  const slow = profile && profile.slowAgent;
  return {
    host: olt.host,
    community: c.community || 'public',
    port: c.port || 161,
    timeout: c.timeout || (slow ? 20000 : 8000),
    retries: c.retries != null ? c.retries : (slow ? 1 : 2),
  };
}

// Cache in-memory untuk hasil ONU state (khusus agent lambat spt HIOSO,
// biar panel tak walk 40-60 dtk tiap request). key = olt.id.
const _stateCache = new Map();  // id -> { ts, val }

function withSession(olt, fn) {
  if (!snmp) return Promise.reject(new Error('Library net-snmp belum terpasang (npm i net-snmp)'));
  const cfg = cfgOf(olt, profileFor(olt));
  return new Promise((resolve, reject) => {
    const session = snmp.createSession(cfg.host, cfg.community, {
      port: cfg.port, version: snmp.Version2c, timeout: cfg.timeout, retries: cfg.retries,
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

// Walk satu kolom tabel → { idx: value }  (idx = angka terakhir OID)
function walkColumn(session, baseOid) {
  return new Promise((resolve, reject) => {
    const out = {};
    const feed = (varbinds) => {
      for (const vb of varbinds) {
        if (snmp.isVarbindError(vb)) continue;
        const oid = vb.oid;
        const idx = oid.slice(baseOid.length + 1); // sisa setelah "base."
        out[idx] = vb.value;
      }
    };
    session.subtree(baseOid, 10, feed, (err) => err ? reject(err) : resolve(out));
  });
}

// Walk via GETNEXT satu-per-satu (kompatibel agent lawas yang tak dukung GETBULK,
// mis. HIOSO). Lebih lambat tapi andal. Berhenti saat OID keluar dari subtree.
function walkGetNext(session, baseOid) {
  return new Promise((resolve, reject) => {
    const out = {};
    const prefix = baseOid + '.';
    let cur = baseOid;
    const step = () => {
      session.getNext([cur], (err, varbinds) => {
        if (err) return reject(err);
        const vb = varbinds[0];
        if (!vb || snmp.isVarbindError(vb)) return resolve(out);
        const oid = vb.oid;
        if (oid === baseOid || oid.indexOf(prefix) === 0) {
          out[oid.slice(baseOid.length + 1)] = vb.value;
          cur = oid;
          setImmediate(step);
        } else {
          resolve(out); // sudah keluar dari subtree
        }
      });
    };
    step();
  });
}

// ── Ambil daftar ONU (state) ────────────────────────────────
async function getOnuState(olt) {
  const p = profileFor(olt);
  if (!p) throw new Error(`Profil EPON untuk vendor "${olt.vendor}" belum ada`);
  if (p.structure === 'hioso') return getOnuStateHioso(olt, p);
  return withSession(olt, async (session, finish) => {
    try {
      const [ports, ids, status, macs] = await Promise.all([
        walkColumn(session, `${p.onuBase}.${p.col.port}`),
        walkColumn(session, `${p.onuBase}.${p.col.onuId}`),
        walkColumn(session, `${p.onuBase}.${p.col.status}`),
        walkColumn(session, `${p.onuBase}.${p.col.mac}`),
      ]);
      const out = [];
      for (const idx of Object.keys(macs)) {
        const port  = Number(toStr(ports[idx])) || null;
        const onuId = Number(toStr(ids[idx])) || null;
        const st    = toStr(status[idx]).toLowerCase();
        const mac   = toStr(macs[idx]);
        if (port == null || onuId == null) continue;
        const online = p.onlineMatch.some((m) => st.includes(m));
        out.push({
          index: `${port}:${onuId}`,
          sn: mac,
          online,
          state: online ? 'online' : 'offline',
          phaseState: online ? 'working' : 'offline',
          port, onuId,
          channel: `PON${port}`,
          raw: { status: toStr(status[idx]) },
        });
      }
      // urutkan port lalu onuId
      out.sort((a, b) => (a.port - b.port) || (a.onuId - b.onuId));
      const online = out.filter((o) => o.online).length;
      finish(null, { onus: out, online, offline: out.length - online, total: out.length });
    } catch (e) { finish(e); }
  });
}

// Versi array datar (untuk pemakaian internal/driver lain)
async function getOnuList(olt) {
  const r = await getOnuState(olt);
  return r.onus;
}

// Format Buffer 6-byte → "aa:bb:cc:dd:ee:ff"
function macFromVal(v) {
  if (Buffer.isBuffer(v)) return Array.from(v.slice(0, 6)).map(b => b.toString(16).padStart(2, '0')).join(':');
  const s = toStr(v).replace(/[^0-9a-fA-F]/g, '');
  if (s.length >= 12) return s.slice(0, 12).match(/.{2}/g).join(':').toLowerCase();
  return toStr(v);
}

// HIOSO: walk tabel MAC (base.<port>.<onuId>.1.1.<sub>), dedup per port:onuId.
// Agent HIOSO sangat lambat (walk penuh ~40-60 dtk) → hasil di-cache 5 menit.
async function getOnuStateHioso(olt, p) {
  const key = olt.id || olt.host;
  const TTL = 5 * 60 * 1000;                 // 5 menit
  const hit = _stateCache.get(key);
  if (hit && (Date.now() - hit.ts) < TTL) {
    // Sajikan cache; refresh di belakang layar bila sudah > 60 dtk.
    if ((Date.now() - hit.ts) > 60000 && !hit.inflight) {
      hit.inflight = true;
      _hiosoWalk(olt, p).then(v => _stateCache.set(key, { ts: Date.now(), val: v }))
        .catch(() => {}).finally(() => { const h = _stateCache.get(key); if (h) h.inflight = false; });
    }
    return hit.val;
  }
  const val = await _hiosoWalk(olt, p);
  _stateCache.set(key, { ts: Date.now(), val });
  return val;
}

function _hiosoWalk(olt, p) {
  return withSession(olt, async (session, finish) => {
    try {
      const base = p.onuMacBase;
      const raw = await walkGetNext(session, base);   // GETNEXT (agent HIOSO lawas)
      const seen = new Map();
      for (const idx of Object.keys(raw)) {
        const parts = idx.split('.');
        if (parts.length < 2) continue;
        const port  = Number(parts[0]);
        const onuId = Number(parts[1]);
        if (!port || !onuId) continue;
        const key = `${port}:${onuId}`;
        if (seen.has(key)) continue;                 // dedup (MAC muncul 2x)
        seen.set(key, { port, onuId, mac: macFromVal(raw[idx]) });
      }
      const out = Array.from(seen.values())
        .sort((a, b) => (a.port - b.port) || (a.onuId - b.onuId))
        .map(o => ({
          index: `${o.port}:${o.onuId}`,
          sn: o.mac,
          online: true,                              // presence di tabel = ter-register
          state: 'online',
          phaseState: 'working',
          port: o.port, onuId: o.onuId,
          channel: `PON${o.port}`,
          raw: {},
        }));
      finish(null, { onus: out, online: out.length, offline: 0, total: out.length });
    } catch (e) { finish(e); }
  });
}

// ── Ringkasan dashboard (total/online/offline) ──────────────
async function getDashboard(olt) {
  const list = await getOnuList(olt);
  const online = list.filter((o) => o.online).length;
  return {
    total: list.length,
    online,
    offline: list.length - online,
    dying: 0, los: 0,     // EPON VSOL via SNMP tak memisahkan ini
    vendor: olt.vendor, type: 'epon',
  };
}

// ── Tes koneksi SNMP (sysDescr) ─────────────────────────────
function ping(olt) {
  return withSession(olt, (session, finish) => {
    session.get(['1.3.6.1.2.1.1.1.0'], (err, vb) => {
      if (err) return finish(err);
      finish(null, { ok: true, sysDescr: toStr(vb[0] && vb[0].value) });
    });
  });
}

// ── Prewarm cache (polling background) untuk agent lambat (HIOSO) ──
// Dipanggil dari services/olt.js saat startup: walk sekali di belakang layar
// lalu ulang tiap `intervalMs`, biar panel selalu dapat cache instan.
function prewarm(olt, intervalMs = 5 * 60 * 1000) {
  const p = profileFor(olt);
  if (!p || !p.slowAgent) return null;     // hanya untuk agent lambat
  const run = () => {
    getOnuState(olt)
      .then(r => console.log(`[epon-snmp] prewarm ${olt.id}: ${r.total} ONU`))
      .catch(e => console.warn(`[epon-snmp] prewarm ${olt.id} gagal: ${e.message}`));
  };
  setTimeout(run, 3000);                    // walk awal 3 dtk setelah start
  return setInterval(run, intervalMs);      // ulang periodik
}

module.exports = {
  available: () => !!snmp,
  PROFILES, profileFor,
  getOnuState, getOnuList, getDashboard, ping, prewarm,
};
