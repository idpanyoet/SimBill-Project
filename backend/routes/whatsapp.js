// routes/whatsapp.js
const router = require('express').Router();
const { query } = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
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

// GET /api/whatsapp/log
router.get('/log', async (req, res, next) => {
    try {
        const { tipe, status, halaman = 1, limit = 30 } = req.query;
        const offset = (parseInt(halaman) - 1) * parseInt(limit);
        let where = ['1=1'], params = [];
        if (tipe)   { where.push('tipe = ?');   params.push(tipe); }
        if (status) { where.push('status = ?'); params.push(status); }

        const rows = await query(`
            SELECT wl.*, p.nama AS nama_pelanggan
            FROM wa_log wl
            LEFT JOIN pelanggan p ON wl.pelanggan_id = p.id
            WHERE ${where.join(' AND ')}
            ORDER BY wl.created_at DESC LIMIT ? OFFSET ?
        `, [...params, parseInt(limit), offset]);
        res.json(rows);
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
router.post('/invalidate-cache', (req, res) => {
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
router.post('/broadcast', async (req, res, next) => {
    try {
        const { target, pesan_template } = req.body;
        // Delay antar pesan dalam milidetik — default 3 detik, min 1, max 60
        const delayMs = Math.min(Math.max(parseInt(req.body.delay) || 3, 1), 60) * 1000;
        let daftar = [];

        if (target === 'unpaid' || target === 'overdue') {
            daftar = await query(`
                SELECT p.nama, p.no_hp, p.id,
                    i.no_invoice, i.jumlah, i.tgl_jatuh_tempo, i.payment_url, i.id AS invoice_id
                FROM pelanggan p
                JOIN invoice i ON i.pelanggan_id = p.id
                WHERE i.status = ? AND p.status != 'nonaktif'
            `, [target]);
        } else if (target === 'semua') {
            daftar = await query(
                `SELECT nama, no_hp, id FROM pelanggan WHERE status != 'nonaktif'`
            );
        }

        const hasil = await waService.broadcast(daftar, pesan_template, 'broadcast', delayMs);
        res.json({ total: daftar.length, hasil });
    } catch (e) { next(e); }
});

module.exports = router;
