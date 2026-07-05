// routes/whatsapp.js
const router = require('express').Router();
const axios = require('axios');
const { query } = require('../config/db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const waService = require('../services/whatsapp');

router.use(authMiddleware);

// GET /api/whatsapp/status — cek apakah WA gateway sudah dikonfigurasi
router.get('/status', async (req, res, next) => {
    try {
        const cfg = await waService.getConfig();
        const aktif = !!(cfg.token);
        res.json({ aktif, provider: cfg.provider });
    } catch (e) { next(e); }
});

// GET /api/whatsapp/log  → { items, total, halaman, limit }
router.get('/log', async (req, res, next) => {
    try {
        const { tipe, status } = req.query;
        const halaman = Math.max(1, parseInt(req.query.halaman) || 1);
        const limit   = Math.min(200, Math.max(1, parseInt(req.query.limit) || 30));
        const offset  = (halaman - 1) * limit;
        let where = ['1=1'], params = [];
        if (tipe)   { where.push('wl.tipe = ?');   params.push(tipe); }
        if (status) { where.push('wl.status = ?'); params.push(status); }
        const whereSql = where.join(' AND ');

        const items = await query(`
            SELECT wl.*, p.nama AS nama_pelanggan
            FROM wa_log wl
            LEFT JOIN pelanggan p ON wl.pelanggan_id = p.id
            WHERE ${whereSql}
            ORDER BY wl.created_at DESC LIMIT ? OFFSET ?
        `, [...params, limit, offset]);

        const totalRow = await query(`SELECT COUNT(*) AS total FROM wa_log wl WHERE ${whereSql}`, params);
        res.json({ items, total: totalRow[0]?.total || 0, halaman, limit });
    } catch (e) { next(e); }
});

// GET /api/whatsapp/statistik
router.get('/statistik', async (req, res, next) => {
    try {
        const stats = await query(`
            SELECT tipe, status, COUNT(*) AS total
            FROM wa_log
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
            GROUP BY tipe, status
        `);
        res.json(stats);
    } catch (e) { next(e); }
});

// POST /api/whatsapp/invalidate-cache — reset cache config WA
router.post('/invalidate-cache', requireAdmin, (req, res) => {
    waService.invalidateCache();
    res.json({ ok: true });
});

// POST /api/whatsapp/kirim — kirim pesan manual
router.post('/kirim', async (req, res, next) => {
    try {
        const { no_hp, pesan, pelanggan_id } = req.body;
        if (!no_hp || !pesan) return res.status(400).json({ error: 'no_hp dan pesan wajib' });
        const hasil = await waService.kirimPesan(no_hp, pesan, pelanggan_id || null, 'manual');
        res.json(hasil);
    } catch (e) { next(e); }
});

// POST /api/whatsapp/broadcast
router.post('/broadcast', requireAdmin, async (req, res, next) => {
    try {
        const { target, pesan_template } = req.body;
        // Delay antar pesan (detik) — acak antara min & max agar natural.
        // Backward-compat: kalau ada 'delay' lama, pakai itu sbg min & max.
        let dMin = parseInt(req.body.delay_min);
        let dMax = parseInt(req.body.delay_max);
        if (isNaN(dMin) && isNaN(dMax)) {
            const legacy = parseInt(req.body.delay) || 3;
            dMin = legacy; dMax = legacy;
        }
        if (isNaN(dMin)) dMin = 30;
        if (isNaN(dMax)) dMax = 60;
        // Batasi 1..600 detik, pastikan min <= max
        dMin = Math.min(Math.max(dMin, 1), 600);
        dMax = Math.min(Math.max(dMax, 1), 600);
        if (dMin > dMax) { const t = dMin; dMin = dMax; dMax = t; }
        const delayMinMs = dMin * 1000;
        const delayMaxMs = dMax * 1000;
        let daftar = [];

        if (target === 'unpaid' || target === 'overdue') {
            daftar = await query(`
                SELECT p.nama, p.no_hp, p.id,
                    i.no_invoice, i.jumlah, i.tgl_jatuh_tempo, i.payment_url, i.id AS invoice_id
                FROM pelanggan p
                JOIN invoice i ON i.pelanggan_id = p.id
                WHERE i.status = ? AND p.status != 'nonaktif'
                  AND (p.tgl_expired IS NULL OR DATE(p.tgl_expired) <= i.tgl_jatuh_tempo)
            `, [target]);
        } else if (target === 'semua') {
            daftar = await query(
                `SELECT nama, no_hp, id FROM pelanggan WHERE status != 'nonaktif'`
            );
        }

        const hasil = await waService.broadcast(daftar, pesan_template, 'broadcast', delayMinMs, delayMaxMs);
        res.json({ total: daftar.length, hasil });
    } catch (e) { next(e); }
});

// ── WA Gateway Mandiri (self-hosted/Baileys) — proxy status & QR ──────────────
// Token gateway dipegang backend (dari setting wa_token), tidak dibocorkan ke browser.
function _mandiriBase(cfg) {
    return (cfg.mandiriUrl || 'http://127.0.0.1:3200').replace(/\/+$/, '');
}

// GET /api/whatsapp/mandiri/status
router.get('/mandiri/status', requireAdmin, async (req, res) => {
    try {
        const cfg = await waService.getConfig();
        const r = await axios.get(`${_mandiriBase(cfg)}/status`, {
            params: { token: waService.getMandiriToken(cfg) }, timeout: 8000
        });
        res.json({ ok: true, ...r.data });
    } catch (e) {
        res.json({ ok: false, connected: false, error: e.response?.data?.error || e.message });
    }
});

// GET /api/whatsapp/mandiri/qr  → { ok, connected, hasQR, qr }
router.get('/mandiri/qr', requireAdmin, async (req, res) => {
    try {
        const cfg = await waService.getConfig();
        const r = await axios.get(`${_mandiriBase(cfg)}/qr.json`, {
            params: { token: waService.getMandiriToken(cfg) }, timeout: 8000
        });
        res.json({ ok: true, ...r.data });
    } catch (e) {
        res.json({ ok: false, connected: false, hasQR: false, qr: null, error: e.response?.data?.error || e.message });
    }
});

// POST /api/whatsapp/resend/:id — kirim ulang pesan dari riwayat wa_log
router.post('/resend/:id', async (req, res, next) => {
    try {
        const id = parseInt(req.params.id);
        if (!id) return res.status(400).json({ error: 'ID pesan tidak valid' });
        const rows = await query(
            'SELECT no_tujuan, pesan, pelanggan_id, tipe, invoice_id FROM wa_log WHERE id=? LIMIT 1',
            [id]
        );
        const log = rows && rows[0];
        if (!log) return res.status(404).json({ error: 'Pesan tidak ditemukan di riwayat' });
        if (!log.no_tujuan || !log.pesan) return res.status(400).json({ error: 'Data pesan tidak lengkap untuk dikirim ulang' });
        const hasil = await waService.kirimPesan(
            log.no_tujuan, log.pesan, log.pelanggan_id || null, log.tipe || 'manual', log.invoice_id || null
        );
        res.json({ ok: true, hasil });
    } catch (e) { next(e); }
});

module.exports = router;
