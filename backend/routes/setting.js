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
            'pg_secret_key', 'pg_webhook_token', 'pg_api_key', 'pg_private_key',
            'github_token'
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

// POST /api/setting/upload-logo — upload logo via base64
router.post('/upload-logo', requireAdmin, async (req, res, next) => {
    try {
        const { data, ext = 'png' } = req.body;
        if (!data) return res.status(400).json({ error: 'Data gambar tidak boleh kosong' });

        const fs   = require('fs');
        const path = require('path');

        // Hapus logo lama
        const uploadDir = path.join(__dirname, '../../frontend/uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        fs.readdirSync(uploadDir)
            .filter(f => f.startsWith('logo_'))
            .forEach(f => fs.unlinkSync(path.join(uploadDir, f)));

        // Simpan logo baru
        // Whitelist ekstensi — cegah path traversal via ext (mis. "png/../../x")
        const safeExt  = /^(png|jpe?g|webp|svg|gif)$/i.test(ext) ? ext.toLowerCase() : 'png';
        const base64   = data.replace(/^data:image\/\w+;base64,/, '');
        const filename = `logo_${Date.now()}.${safeExt}`;
        fs.writeFileSync(path.join(uploadDir, filename), Buffer.from(base64, 'base64'));

        const url = `/uploads/${filename}`;
        // Simpan URL ke tabel setting
        await query(`INSERT INTO setting (kunci, nilai, deskripsi) VALUES ('app_logo', ?, 'URL logo aplikasi')
            ON DUPLICATE KEY UPDATE nilai = ?`, [url, url]);

        res.json({ url });
    } catch(e) { next(e); }
});

module.exports = router;
