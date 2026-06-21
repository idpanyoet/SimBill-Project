// services/license.js — Client lisensi SimBill
// =============================================================================
// Billing ini memvalidasi dirinya ke license server (VPS terpisah) agar tidak
// bisa dipakai sembarang orang. Mekanisme: license_key + Hardware ID (HWID).
//
// Konfigurasi (tabel setting): 'license_key', 'license_server_url',
// 'license_enforce' ('1' = kunci app bila lisensi invalid; default '0' = pantau saja).
//
// HWID = fingerprint mesin yang stabil (machine-id + MAC), diformat UUID.
// =============================================================================
const fs    = require('fs');
const os    = require('os');
const crypto = require('crypto');
const axios = require('axios');
const { query } = require('../config/db');

let _hwid = null;
let _cache = null;        // hasil validasi terakhir { ok, data, ts }
const GRACE_MS = 3 * 24 * 60 * 60 * 1000; // toleransi offline 3 hari

// ── Hardware ID stabil ──────────────────────────────────────────────────────
function hwid() {
    if (_hwid) return _hwid;
    let mid = '';
    try { mid = fs.readFileSync('/etc/machine-id', 'utf8').trim(); } catch (e) {}
    if (!mid) { try { mid = fs.readFileSync('/var/lib/dbus/machine-id', 'utf8').trim(); } catch (e) {} }
    // MAC pertama yang bukan internal
    let mac = '';
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const ni of ifaces[name] || []) {
            if (!ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') { mac = ni.mac; break; }
        }
        if (mac) break;
    }
    const raw = `${mid}|${mac}|${os.hostname()}`;
    const h = crypto.createHash('sha256').update(raw).digest('hex');
    // Format mirip UUID 8-4-4-4-12
    _hwid = `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
    return _hwid;
}

// Default server lisensi (dipakai bila setting kosong) — admin cukup isi kunci.
const DEFAULT_SERVER = 'https://license.cmi.my.id';

async function getConfig() {
    const rows = await query(
        "SELECT kunci, nilai FROM setting WHERE kunci IN ('license_key','license_server_url','license_enforce')"
    ).catch(() => []);
    const m = {}; rows.forEach(r => m[r.kunci] = r.nilai);
    return {
        key:     (m.license_key || '').trim(),
        server:  (m.license_server_url || '').trim().replace(/\/+$/, '') || DEFAULT_SERVER,
        enforce: m.license_enforce === '1',
    };
}

// ── Cache lisensi persisten (di tabel setting) — bertahan walau app restart ──
async function saveCache(c) {
    try {
        await query("INSERT INTO setting (kunci,nilai) VALUES ('license_cache',?) ON DUPLICATE KEY UPDATE nilai=VALUES(nilai)",
            [JSON.stringify({ ok: c.ok, data: c.data, ts: c.ts })]);
    } catch (e) {}
}
async function loadCache() {
    try {
        const rows = await query("SELECT nilai FROM setting WHERE kunci='license_cache'");
        if (rows[0] && rows[0].nilai) return JSON.parse(rows[0].nilai);
    } catch (e) {}
    return null;
}
function masihBerlaku(c) {
    return c && c.ok && c.data && c.data.expired && new Date(c.data.expired) > new Date();
}

// ── Validasi ke license server ──────────────────────────────────────────────
async function validasi(force = false) {
    const cfg = await getConfig();
    if (!cfg.key) {
        _cache = { ok: false, data: { status: 'unconfigured', pesan: 'License key belum diisi.' }, ts: Date.now() };
        return _cache;
    }
    // Hangatkan cache dari DB bila kosong (mis. setelah restart)
    if (!_cache) { const c = await loadCache(); if (c) _cache = c; }
    // Pakai cache singkat (5 menit) kecuali dipaksa
    if (!force && _cache && _cache.ok && Date.now() - _cache.ts < 5 * 60 * 1000) return _cache;
    try {
        const r = await axios.post(`${cfg.server}/api/validate`,
            { key: cfg.key, hwid: hwid(), app: 'simbill', version: process.env.APP_VERSION || '' },
            { timeout: 12000, validateStatus: () => true });
        if (r.status === 200 && r.data) {
            // Server menjawab — ini OTORITATIF (termasuk bila invalid/dicabut/HWID beda)
            _cache = { ok: !!r.data.valid, data: r.data, ts: Date.now() };
            if (_cache.ok) await saveCache(_cache);   // simpan hanya yg valid (utk offline nanti)
            return _cache;
        }
        // Server merespons tapi bukan 200 → anggap gangguan server, pakai cache bila lisensi masih berlaku
        const c1 = masihBerlaku(_cache) ? _cache : await loadCache();
        if (masihBerlaku(c1)) return { ...c1, offline: true };
        return { ok: false, data: { status: 'error', pesan: `Server lisensi status ${r.status}` }, ts: Date.now() };
    } catch (e) {
        // SERVER TAK BISA DIHUBUNGI: tetap VALID selama lisensi BELUM jatuh tempo
        // (walau server down berhari-hari/berminggu — tidak minta aktivasi ulang).
        const c = masihBerlaku(_cache) ? _cache : await loadCache();
        if (masihBerlaku(c)) { _cache = c; return { ...c, offline: true }; }
        return { ok: false, data: { status: 'offline', pesan: 'Tidak bisa hubungi server lisensi: ' + e.message }, ts: Date.now() };
    }
}

// Status untuk halaman admin (sertakan hwid lokal)
async function status(force = false) {
    const v = await validasi(force);
    const cfg = await getConfig();
    return {
        valid:   v.ok,
        offline: !!v.offline,
        enforce: cfg.enforce,
        license_server_url: cfg.server,
        hwid:    hwid(),
        ...(v.data || {}),
    };
}

// Perpanjang lisensi (diteruskan ke license server)
async function perpanjang() {
    const cfg = await getConfig();
    if (!cfg.key || !cfg.server) throw new Error('License key / server belum diisi.');
    const r = await axios.post(`${cfg.server}/api/extend`,
        { key: cfg.key, hwid: hwid() }, { timeout: 15000, validateStatus: () => true });
    if (r.status !== 200 || !r.data || r.data.error) {
        throw new Error((r.data && (r.data.error || r.data.pesan)) || `Gagal perpanjang (status ${r.status})`);
    }
    _cache = null; // paksa refresh
    return r.data;
}

// ── Heartbeat: kontak server lisensi berkala (default 5 mnt) agar status
// "online" akurat di license server, tanpa tergantung aktivitas admin.
let _hbTimer = null;
function mulaiHeartbeat(intervalMs = 5 * 60 * 1000) {
    if (_hbTimer) return;
    const ping = async () => {
        try { const cfg = await getConfig(); if (cfg.key) await validasi(true); } catch (e) {}
    };
    setTimeout(ping, 15000);               // ping pertama setelah app settle
    _hbTimer = setInterval(ping, intervalMs);
    if (_hbTimer.unref) _hbTimer.unref();  // jangan menahan proses tetap hidup
}

module.exports = { hwid, getConfig, validasi, status, perpanjang, mulaiHeartbeat, GRACE_MS };
