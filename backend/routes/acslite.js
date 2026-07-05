// routes/acslite.js — Integrasi ACS Lite (GoACS) — MODUL TERPISAH dari GenieACS.
// GenieACS (/api/acs) TIDAK disentuh. Semua di sini nembak API ACS Lite
// (single binary Go) via header X-API-Key. Setting disimpan di tabel `setting`:
//   acslite_url      (default http://127.0.0.1:7547)
//   acslite_api_key
const router = require('express').Router();
const axios = require('axios');
const fs = require('fs');
const { exec } = require('child_process');
const { query, queryOne } = require('../config/db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

router.use(authMiddleware);

// Baca API_KEY langsung dari .env ACS Lite (/opt/acs/.env) supaya operator tidak
// perlu mengetik/melihat token. Path hardcoded (tidak menerima input user).
function readAcsEnvKey() {
    try {
        const txt = fs.readFileSync('/opt/acs/.env', 'utf8');
        const m = txt.match(/^\s*API_KEY\s*=\s*(.+?)\s*$/m);
        if (m && m[1]) return m[1].replace(/^["']|["']$/g, '');
    } catch (e) { /* .env tidak ada / tak terbaca → fallback ke setting */ }
    return '';
}

async function getCfg() {
    const rows = await query(
        "SELECT kunci, nilai FROM setting WHERE kunci IN ('acslite_url','acslite_api_key')"
    ).catch(() => []);
    const m = {}; rows.forEach(r => { m[r.kunci] = r.nilai; });
    return {
        url:    (m.acslite_url || 'http://127.0.0.1:7547').replace(/\/+$/, ''),
        // Prioritas: API_KEY dari .env gateway lokal; fallback ke setting (mis. ACS di server lain).
        apiKey: readAcsEnvKey() || (m.acslite_api_key || '').trim(),
    };
}
function hdr(cfg) { return cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {}; }

// Ekstrak PPPoE username & SSID dari struktur device ACS Lite.
function extractPPPoE(d) {
    if (d && d.wan_services) for (const k in d.wan_services) {
        const w = d.wan_services[k];
        if (w && w.username_path && d.parameters && d.parameters[w.username_path]) return d.parameters[w.username_path];
    }
    return null;
}
function extractSSID(d) {
    if (d && d.wifi_services) for (const k in d.wifi_services) {
        const w = d.wifi_services[k];
        if (w && w.ssid_path && d.parameters && d.parameters[w.ssid_path]) return d.parameters[w.ssid_path];
    }
    return null;
}
function firstWifiPaths(d) {
    if (d && d.wifi_services) for (const k in d.wifi_services) {
        const w = d.wifi_services[k];
        if (w && w.ssid_path) return { ssid_path: w.ssid_path, pass_path: w.password_path || null };
    }
    return { ssid_path: null, pass_path: null };
}

// GET /api/acslite/status → { ok, online_devices, url }
router.get('/status', async (req, res) => {
    try {
        const cfg = await getCfg();
        const r = await axios.get(`${cfg.url}/api/stats`, { headers: hdr(cfg), timeout: 8000 });
        res.json({ ok: true, url: cfg.url, ...(r.data || {}) });
    } catch (e) {
        res.json({ ok: false, url: (await getCfg()).url, error: e.response?.data?.error || e.message });
    }
});

// GET /api/acslite/devices?page=&per_page= → device + match pelanggan (PPPoE)
router.get('/devices', async (req, res) => {
    try {
        const cfg = await getCfg();
        const page = parseInt(req.query.page) || 1;
        const per  = Math.min(100, Math.max(1, parseInt(req.query.per_page) || 25));
        const r = await axios.get(`${cfg.url}/api/devices`, {
            headers: hdr(cfg), params: { page, per_page: per }, timeout: 15000
        });
        const raw = r.data;
        const list = Array.isArray(raw) ? raw : (raw.data || []);
        const total = (raw && raw.meta && raw.meta.total) || list.length;

        const out = [];
        for (const d of list) {
            const pppoe = extractPPPoE(d);
            let pelanggan = null;
            if (pppoe) {
                const p = await queryOne(
                    "SELECT id, nama FROM pelanggan WHERE username = ? LIMIT 1", [pppoe]
                ).catch(() => null);
                if (p) pelanggan = { id: p.id, nama: p.nama };
            }
            const wp = firstWifiPaths(d);
            out.push({
                serial_number: d.serial_number, manufacturer: d.manufacturer,
                product_class: d.product_class, ip_address: d.ip_address,
                last_inform_time: d.last_inform_time, status: d.status,
                rx_power: d.rx_power, temperature: d.temperature,
                ssid: extractSSID(d), ssid_path: wp.ssid_path, pass_path: wp.pass_path,
                pppoe, pelanggan,
            });
        }
        res.json({ ok: true, devices: out, total, page, per_page: per });
    } catch (e) {
        res.json({ ok: false, error: e.response?.data?.error || e.message, devices: [], total: 0 });
    }
});

// POST /api/acslite/refresh?sn= → connection request (tarik param terbaru)
router.post('/refresh', requireAdmin, async (req, res) => {
    try {
        const cfg = await getCfg();
        const sn = req.query.sn;
        if (!sn) return res.status(400).json({ error: 'sn wajib' });
        const r = await axios.post(`${cfg.url}/api/refresh`, null, {
            headers: hdr(cfg), params: { sn }, timeout: 15000
        });
        res.json({ ok: true, ...(r.data || {}) });
    } catch (e) {
        res.json({ ok: false, error: e.response?.data?.error || e.message });
    }
});

// POST /api/acslite/reboot?sn= → task Reboot
router.post('/reboot', requireAdmin, async (req, res) => {
    try {
        const cfg = await getCfg();
        const sn = req.query.sn;
        if (!sn) return res.status(400).json({ error: 'sn wajib' });
        const r = await axios.post(`${cfg.url}/api/tasks`, { name: 'Reboot', payload: {} }, {
            headers: { ...hdr(cfg), 'Content-Type': 'application/json' }, params: { sn }, timeout: 15000
        });
        res.json({ ok: true, ...(r.data || {}) });
    } catch (e) {
        res.json({ ok: false, error: e.response?.data?.error || e.message });
    }
});

// POST /api/acslite/wifi?sn= body {ssid_path, ssid, pass_path, pass}
router.post('/wifi', requireAdmin, async (req, res) => {
    try {
        const cfg = await getCfg();
        const sn = req.query.sn;
        const { ssid_path, ssid, pass_path, pass } = req.body || {};
        if (!sn) return res.status(400).json({ error: 'sn wajib' });
        const parameters = {};
        if (ssid_path && ssid) parameters[ssid_path] = ssid;
        if (pass_path && pass) parameters[pass_path] = pass;
        if (!Object.keys(parameters).length) return res.status(400).json({ error: 'Tidak ada parameter untuk diubah' });
        const r = await axios.post(`${cfg.url}/api/tasks`, { name: 'SetParameterValues', payload: { parameters } }, {
            headers: { ...hdr(cfg), 'Content-Type': 'application/json' }, params: { sn }, timeout: 15000
        });
        res.json({ ok: true, ...(r.data || {}) });
    } catch (e) {
        res.json({ ok: false, error: e.response?.data?.error || e.message });
    }
});

// POST /api/acslite/setting body {acslite_url, acslite_api_key} → simpan
router.post('/setting', requireAdmin, async (req, res) => {
    try {
        const { acslite_url, acslite_api_key } = req.body || {};
        async function up(k, v) {
            await query(
                "INSERT INTO setting (kunci, nilai) VALUES (?, ?) ON DUPLICATE KEY UPDATE nilai = VALUES(nilai)",
                [k, v == null ? '' : String(v)]
            );
        }
        if (acslite_url !== undefined)     await up('acslite_url', String(acslite_url).replace(/\/+$/, ''));
        if (acslite_api_key !== undefined) await up('acslite_api_key', acslite_api_key);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/acslite/setting → { url, has_key } (jangan bocorkan key mentah)
router.get('/setting', async (req, res) => {
    try {
        const cfg = await getCfg();
        res.json({ url: cfg.url, has_key: !!cfg.apiKey });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/acslite/restart → restart service ACS Lite (systemctl). Perintah hardcoded.
router.post('/restart', requireAdmin, (req, res) => {
    exec('systemctl restart acslite', { timeout: 20000 }, (err, stdout, stderr) => {
        if (err) return res.json({ ok: false, error: (stderr || err.message || 'gagal restart').toString().trim() });
        res.json({ ok: true });
    });
});

module.exports = router;
