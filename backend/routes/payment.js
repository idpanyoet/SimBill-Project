// routes/payment.js
const router = require('express').Router();
const { query } = require('../config/db');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// GET /api/payment/transaksi — riwayat pembayaran
router.get('/transaksi', async (req, res, next) => {
    try {
        const { dari, sampai, halaman = 1, limit = 30 } = req.query;
        const per = Math.min(Math.max(parseInt(limit) || 10, 1), 50);
        const hal = Math.max(parseInt(halaman) || 1, 1);
        const offset = (hal - 1) * per;

        let where = ['1=1'], params = [];
        if (dari)   { where.push('pl.created_at >= ?'); params.push(dari); }
        if (sampai) { where.push('pl.created_at <= ?'); params.push(sampai + ' 23:59:59'); }

        const totalRows = await query(`
            SELECT COUNT(*) AS total
            FROM payment_log pl
            JOIN invoice i ON pl.invoice_id = i.id
            WHERE ${where.join(' AND ')}
        `, params);
        const total = (totalRows[0] && totalRows[0].total) || 0;

        const rows = await query(`
            SELECT pl.*, i.no_invoice, p.nama AS nama_pelanggan
            FROM payment_log pl
            JOIN invoice i ON pl.invoice_id = i.id
            LEFT JOIN pelanggan p ON i.pelanggan_id = p.id
            WHERE ${where.join(' AND ')}
            ORDER BY pl.created_at DESC LIMIT ? OFFSET ?
        `, [...params, per, offset]);

        res.json({ data: rows, total, halaman: hal, limit: per });
    } catch (e) { next(e); }
});

// GET /api/payment/ringkasan
router.get('/ringkasan', async (req, res, next) => {
    try {
        const rows = await query(`
            SELECT
                metode_bayar,
                COUNT(*) AS jumlah,
                SUM(jumlah) AS total
            FROM invoice
            WHERE status='paid'
            AND MONTH(tgl_bayar)=MONTH(NOW())
            AND YEAR(tgl_bayar)=YEAR(NOW())
            GROUP BY metode_bayar
        `);
        res.json(rows);
    } catch (e) { next(e); }
});

module.exports = router;
