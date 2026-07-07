// routes/license.js — Manajemen Lisensi (sisi billing/client)
const router = require('express').Router();
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { query } = require('../config/db');
const lic = require('../services/license');

router.use(authMiddleware);

// POST /api/license/activate { license_key, license_server_url? }
// Simpan konfigurasi lisensi lalu validasi (untuk gerbang "Aktifkan Lisensi").
router.post('/activate', requireAdmin, async (req, res) => {
    let { license_key, license_server_url } = req.body || {};
    license_key = String(license_key || '').trim();
    license_server_url = String(license_server_url || '').trim().replace(/\/+$/, '');
    if (!license_key) return res.status(400).json({ error: 'Kunci lisensi wajib diisi.' });
    const ups = 'INSERT INTO setting (kunci,nilai) VALUES (?,?) ON DUPLICATE KEY UPDATE nilai=VALUES(nilai)';
    try {
        await query(ups, ['license_key', license_key]);
        if (license_server_url) await query(ups, ['license_server_url', license_server_url]);
    } catch (e) {
        return res.status(500).json({ error: 'Gagal simpan konfigurasi: ' + e.message });
    }
    const s = await lic.status(true); // validasi paksa
    if (!s.valid) return res.status(400).json({ error: s.pesan || ('Lisensi tidak valid (' + (s.status || 'gagal') + ').'), status: s.status });
    res.json({ sukses: true, ...s });
});

// GET /api/license/status — ringkasan lisensi untuk halaman admin
router.get('/status', async (req, res) => {
    try {
        const force = req.query.reload === '1';
        const s = await lic.status(force);
        res.json(s);
    } catch (e) {
        res.status(500).json({ error: 'Gagal ambil status lisensi: ' + e.message });
    }
});

// GET /api/license/hwid — Hardware ID mesin ini (untuk registrasi awal)
router.get('/hwid', (req, res) => res.json({ hwid: lic.hwid() }));

// POST /api/license/extend — perpanjang lisensi (diteruskan ke license server)
router.post('/extend', requireAdmin, async (req, res) => {
    try {
        const hasil = await lic.perpanjang();
        res.json({ sukses: true, ...hasil });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;
