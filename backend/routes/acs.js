// routes/acs.js — ACS Admin API Routes
'use strict';

const router = require('express').Router();
const { query, queryOne } = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
const { getWifiParams, getStatusParams } = require('../services/acs');

router.use(authMiddleware);

// ── GET /api/acs/devices ──────────────────────────────────────
router.get('/devices', async (req, res, next) => {
    try {
        const rows = await query(`
            SELECT d.*,
                p.nama AS pelanggan_nama, p.username AS pelanggan_username,
                CASE WHEN d.last_inform > DATE_SUB(NOW(), INTERVAL 15 MINUTE)
                     THEN 'online' ELSE 'offline' END AS status_live
            FROM acs_device d
            LEFT JOIN pelanggan p ON d.pelanggan_id = p.id
            ORDER BY d.last_inform DESC
        `);
        res.json(rows.map(r => ({
            ...r,
            status: r.status_live,
            param_cache: (() => { try { return JSON.parse(r.param_cache || '{}'); } catch(e) { return {}; } })()
        })));
    } catch(e) { next(e); }
});

// ── GET /api/acs/devices/:id ──────────────────────────────────
router.get('/devices/:id', async (req, res, next) => {
    try {
        const d = await queryOne(`
            SELECT d.*,
                p.nama AS pelanggan_nama, p.username AS pelanggan_username,
                CASE WHEN d.last_inform > DATE_SUB(NOW(), INTERVAL 15 MINUTE)
                     THEN 'online' ELSE 'offline' END AS status_live
            FROM acs_device d
            LEFT JOIN pelanggan p ON d.pelanggan_id = p.id
            WHERE d.id = ?
        `, [req.params.id]);
        if (!d) return res.status(404).json({ error: 'Device tidak ditemukan' });
        d.status = d.status_live;   // selalu pakai status_live
        d.param_cache = (() => { try { return JSON.parse(d.param_cache || '{}'); } catch(e) { return {}; } })();

        // Ambil task terakhir
        const tasks = await query('SELECT * FROM acs_task WHERE device_id=? ORDER BY id DESC LIMIT 10', [d.id]);
        res.json({ ...d, tasks });
    } catch(e) { next(e); }
});

// ── PUT /api/acs/devices/:id — link ke pelanggan ──────────────
router.put('/devices/:id', async (req, res, next) => {
    try {
        const { pelanggan_id } = req.body;
        await query('UPDATE acs_device SET pelanggan_id=? WHERE id=?',
            [pelanggan_id || null, req.params.id]);
        res.json({ pesan: 'Device diperbarui' });
    } catch(e) { next(e); }
});

// ── DELETE /api/acs/devices/:id ───────────────────────────────
router.delete('/devices/:id', async (req, res, next) => {
    try {
        await query('DELETE FROM acs_task WHERE device_id=?', [req.params.id]);
        await query('DELETE FROM acs_device WHERE id=?', [req.params.id]);
        res.json({ pesan: 'Device dihapus' });
    } catch(e) { next(e); }
});

// ── POST /api/acs/devices/:id/refresh — ambil status terbaru ──
router.post('/devices/:id/refresh', async (req, res, next) => {
    try {
        const device = await queryOne('SELECT * FROM acs_device WHERE id=?', [req.params.id]);
        if (!device) return res.status(404).json({ error: 'Device tidak ditemukan' });
        await query('INSERT INTO acs_task (device_id, type, status, created_by) VALUES (?,?,?,?)',
            [device.id, 'GetParameterValues', 'pending', 'admin']);
        res.json({ pesan: 'Task refresh dikirim, tunggu device polling (maks ' + (device.inform_interval||300) + 'dtk)' });
    } catch(e) { next(e); }
});

// ── POST /api/acs/devices/:id/reboot ─────────────────────────
router.post('/devices/:id/reboot', async (req, res, next) => {
    try {
        const device = await queryOne('SELECT * FROM acs_device WHERE id=?', [req.params.id]);
        if (!device) return res.status(404).json({ error: 'Device tidak ditemukan' });
        await query('INSERT INTO acs_task (device_id, type, status, created_by) VALUES (?,?,?,?)',
            [device.id, 'Reboot', 'pending', 'admin']);
        res.json({ pesan: 'Perintah reboot dikirim ke device' });
    } catch(e) { next(e); }
});

// ── POST /api/acs/devices/:id/wifi — ganti password WiFi ──────
router.post('/devices/:id/wifi', async (req, res, next) => {
    try {
        const { ssid, password } = req.body;
        if (!password || password.length < 8)
            return res.status(400).json({ error: 'Password minimal 8 karakter' });

        const device = await queryOne('SELECT * FROM acs_device WHERE id=?', [req.params.id]);
        if (!device) return res.status(404).json({ error: 'Device tidak ditemukan' });

        const wifiParams = getWifiParams(device.manufacturer);
        const pairs = [];
        if (ssid) pairs.push({ name: wifiParams.ssid, value: ssid });
        pairs.push({ name: wifiParams.password, value: password });

        await query('INSERT INTO acs_task (device_id, type, params, status, created_by) VALUES (?,?,?,?,?)',
            [device.id, 'SetParameterValues', JSON.stringify(pairs), 'pending', 'admin']);

        res.json({ pesan: 'Task ganti WiFi dikirim, aktif saat device polling berikutnya' });
    } catch(e) { next(e); }
});

// ── GET /api/acs/tasks ────────────────────────────────────────
router.get('/tasks', async (req, res, next) => {
    try {
        const rows = await query(`
            SELECT t.*, d.serial_number, d.manufacturer, d.product_class
            FROM acs_task t
            JOIN acs_device d ON t.device_id = d.id
            ORDER BY t.id DESC LIMIT 50
        `);
        res.json(rows);
    } catch(e) { next(e); }
});

// ── GET /api/acs/stats ────────────────────────────────────────
router.get('/stats', async (req, res, next) => {
    try {
        const [total]   = await query('SELECT COUNT(*) AS n FROM acs_device');
        const [online]  = await query("SELECT COUNT(*) AS n FROM acs_device WHERE last_inform > DATE_SUB(NOW(), INTERVAL 15 MINUTE)");
        const [pending] = await query("SELECT COUNT(*) AS n FROM acs_task WHERE status='pending'");
        res.json({ total: total.n, online: online.n, offline: total.n - online.n, pending_tasks: pending.n });
    } catch(e) { next(e); }
});

module.exports = router;
