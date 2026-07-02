// routes/acs.js — ACS Routes via GenieACS NBI API
// SimBill membaca device & mengirim task LANGSUNG ke GenieACS (port 7557).
// Tidak ada lagi ACS-sendiri (acs.js CWMP server). GenieACS menangani semua
// urusan TR-069 (inform, poll, NAT, connection request, task queue).
'use strict';

const router = require('express').Router();
const { query, queryOne } = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
const genie = require('../services/genieacs');

router.use(authMiddleware);

// ── GET /api/acs/test — uji koneksi GenieACS (tombol "Uji Koneksi") ──
router.get('/test', async (req, res) => {
    try {
        const r = await genie.testConnection(req.query.url);
        res.json({ ok: true, ...r });
    } catch (e) {
        res.status(502).json({ ok: false, error: 'Gagal konek GenieACS: ' + e.message });
    }
});

// ── GET /api/acs/devices — daftar device real-time dari GenieACS ──
router.get('/devices', async (req, res, next) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 2000, 5000);
        const devices = await genie.listDevices({ limit });

        // AUTO-MATCH ke pelanggan by username PPPoE (tanpa link manual).
        // Ambil semua pelanggan sekali, buat map username→{id,nama}.
        let pelMap = {};
        try {
            const pels = await query('SELECT id, username, nama FROM pelanggan');
            pels.forEach(p => {
                if (p.username) pelMap[p.username.toLowerCase()] = { id: p.id, nama: p.nama };
            });
        } catch (e) {}

        // Link manual (acs_link) sebagai override/tambahan kalau ada.
        let linkMap = {};
        try {
            const links = await query(
                `SELECT l.serial_number, l.pelanggan_id, p.nama
                 FROM acs_link l LEFT JOIN pelanggan p ON p.id=l.pelanggan_id`
            );
            links.forEach(l => { linkMap[l.serial_number] = { id: l.pelanggan_id, nama: l.nama }; });
        } catch (e) {}

        const out = devices.map(d => {
            // prioritas: link manual > auto-match username PPPoE
            let pel = linkMap[d.serial_number];
            if ((!pel || !pel.id) && d.pppoe_username) {
                pel = pelMap[d.pppoe_username.toLowerCase()];
            }
            return {
                ...d,
                pelanggan_id: pel ? pel.id : null,
                pelanggan_nama: pel ? pel.nama : null,
                // tampilkan username PPPoE sebagai fallback kalau tak ada nama pelanggan
                username: d.pppoe_username || '',
            };
        });
        res.json(out);
    } catch (e) {
        res.status(502).json({ error: 'Gagal ambil device dari GenieACS: ' + e.message });
    }
});

// ── GET /api/acs/devices/:genieId — detail device ──
router.get('/devices/:genieId', async (req, res, next) => {
    try {
        const raw = await genie.getDevice(req.params.genieId);
        if (!raw) return res.status(404).json({ error: 'Device tidak ditemukan di GenieACS' });
        const norm = genie.normalizeDevice(raw);

        // Flatten parameter penting dari GenieACS untuk panel "Parameter Cache".
        // Frontend harapkan objek {namaParam: nilai}.
        const param_cache = genie.flattenParams(raw);

        // pelanggan link: manual (acs_link) > auto-match username PPPoE
        let pelanggan_id = null, pelanggan_nama = null;
        try {
            const link = await queryOne(
                `SELECT l.pelanggan_id, p.nama FROM acs_link l
                 LEFT JOIN pelanggan p ON p.id=l.pelanggan_id
                 WHERE l.serial_number=?`, [norm.serial_number]);
            if (link && link.pelanggan_id) { pelanggan_id = link.pelanggan_id; pelanggan_nama = link.nama; }
        } catch (e) {}
        if (!pelanggan_id && norm.pppoe_username) {
            try {
                const p = await queryOne('SELECT id, nama FROM pelanggan WHERE LOWER(username)=LOWER(?)', [norm.pppoe_username]);
                if (p) { pelanggan_id = p.id; pelanggan_nama = p.nama; }
            } catch (e) {}
        }

        res.json({
            ...norm,
            param_cache,
            pelanggan_id,
            pelanggan_nama,
            tasks: [],   // GenieACS kelola task sendiri; panel task-mini dikosongkan
        });
    } catch (e) {
        res.status(502).json({ error: 'Gagal ambil detail: ' + e.message });
    }
});

// ── POST /api/acs/devices/:genieId/refresh — Ambil Status ──
router.post('/devices/:genieId/refresh', async (req, res) => {
    try {
        const r = await genie.refreshDevice(req.params.genieId);
        res.json({ pesan: (r && r._timeout)
            ? 'Perintah dikirim — menunggu ONU merespons. Data diperbarui beberapa detik lagi.'
            : 'Status berhasil diambil dari perangkat.' });
    } catch (e) {
        res.status(502).json({ error: 'Gagal kirim refresh: ' + e.message });
    }
});

// ── POST /api/acs/devices/:genieId/reboot — Reboot ──
router.post('/devices/:genieId/reboot', async (req, res) => {
    try {
        await genie.rebootDevice(req.params.genieId);
        res.json({ pesan: 'Perintah reboot dikirim ke device (via GenieACS)' });
    } catch (e) {
        res.status(502).json({ error: 'Gagal kirim reboot: ' + e.message });
    }
});

// ── POST /api/acs/devices/:genieId/wifi — Ganti WiFi ──
router.post('/devices/:genieId/wifi', async (req, res) => {
    try {
        const { ssid, password, manufacturer } = req.body;
        if (password && password.length < 8)
            return res.status(400).json({ error: 'Password WiFi minimal 8 karakter' });
        if (!ssid && !password)
            return res.status(400).json({ error: 'Isi SSID dan/atau password' });

        await genie.setWifi(req.params.genieId, { ssid, password, manufacturer });
        res.json({ pesan: 'Perintah ganti WiFi dikirim ke device (via GenieACS)' });
    } catch (e) {
        res.status(502).json({ error: 'Gagal kirim ganti WiFi: ' + e.message });
    }
});

// ── PUT /api/acs/devices/:serial/link — kaitkan device ke pelanggan ──
// Mapping disimpan by serial_number (karena GenieACS _id bisa berubah format).
router.put('/devices/:serial/link', async (req, res) => {
    try {
        const { pelanggan_id } = req.body;
        const serial = req.params.serial;
        // tabel acs_link: serial_number (PK), pelanggan_id
        await query(
            `INSERT INTO acs_link (serial_number, pelanggan_id) VALUES (?,?)
             ON DUPLICATE KEY UPDATE pelanggan_id=VALUES(pelanggan_id)`,
            [serial, pelanggan_id || null]
        );
        res.json({ pesan: 'Device dikaitkan ke pelanggan' });
    } catch (e) {
        res.status(500).json({ error: 'Gagal link: ' + e.message });
    }
});

// ── GET /api/acs/stats — ringkasan (total/online/offline) ──
router.get('/stats', async (req, res) => {
    try {
        const devices = await genie.listDevices({ limit: 5000 });
        const total = devices.length;
        const online = devices.filter(d => d.status === 'online').length;
        res.json({ total, online, offline: total - online });
    } catch (e) {
        res.status(502).json({ error: 'Gagal ambil stats: ' + e.message });
    }
});

module.exports = router;
