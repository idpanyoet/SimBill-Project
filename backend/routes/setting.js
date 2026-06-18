// routes/setting.js — terpisah agar import mudah
const router = require('express').Router();
const { query, queryOne } = require('../config/db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/', async (req, res, next) => {
    try {
        const rows = await query('SELECT kunci, nilai, deskripsi FROM setting ORDER BY kunci');
        const SENSITIVE = [
            'wa_token', 'pg_server_key', 'pg_client_key',
            'pg_secret_key', 'pg_webhook_token', 'pg_api_key', 'pg_private_key'
        ];
        const safe = rows.map(r => ({
            ...r,
            nilai: SENSITIVE.includes(r.kunci)
                ? (r.nilai ? '••••••' : '') : r.nilai
        }));
        res.json(safe);
    } catch (e) { next(e); }
});

router.put('/', requireAdmin, async (req, res, next) => {
    try {
        const settings = req.body;
        for (const [kunci, nilai] of Object.entries(settings)) {
            // Upsert: kalau key belum ada di tabel (misal setting baru yang
            // ditambahkan lewat update kode), INSERT dulu agar tidak silently
            // gagal seperti UPDATE biasa pada baris yang belum ada.
            await query(`
                INSERT INTO setting (kunci, nilai) VALUES (?, ?)
                ON DUPLICATE KEY UPDATE nilai = ?
            `, [kunci, nilai, nilai]);
        }
        // Beberapa setting (terutama WhatsApp Gateway & Payment Gateway)
        // di-cache di memory service agar tidak query database di setiap
        // pengiriman pesan/transaksi. Invalidasi cache supaya perubahan
        // langsung berlaku tanpa perlu restart server.
        if (Object.keys(settings).some(k => k.startsWith('wa_'))) {
            require('../services/whatsapp').invalidateCache();
        }
        if (Object.keys(settings).some(k => k.startsWith('pg_'))) {
            require('../services/payment').invalidateCache();
        }
        res.json({ pesan: 'Setting disimpan' });
    } catch (e) { next(e); }
});

module.exports = router;
