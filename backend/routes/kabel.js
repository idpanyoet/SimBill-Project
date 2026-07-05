// routes/kabel.js — Jalur kabel (cable route) untuk Peta Jaringan.
// Setiap kabel = daftar titik (lat,lng) berurutan, sehingga garisnya bisa
// belok-belok mengikuti jalur asli (bukan sekadar garis lurus). Jenis kabel:
// 'backbone' | 'distribusi' | 'drop' (warna dibedakan di frontend).
const router = require('express').Router();
const { query, queryOne } = require('../config/db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

// --- Auto-migrasi tabel kabel (sekali, saat modul dimuat) ---
(async () => {
    try {
        await query(`
            CREATE TABLE IF NOT EXISTS kabel (
                id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                nama        VARCHAR(100) NOT NULL,
                tipe        ENUM('backbone','distribusi','drop') NOT NULL DEFAULT 'distribusi',
                titik       LONGTEXT NOT NULL,
                keterangan  VARCHAR(255) DEFAULT NULL,
                dibuat_oleh VARCHAR(100) DEFAULT NULL,
                created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
    } catch (e) {
        console.warn('[kabel] migrasi tabel gagal:', e.message);
    }
})();

const TIPE_VALID = ['backbone', 'distribusi', 'drop'];

// Validasi & normalisasi array titik: [[lat,lng], ...] minimal 2 titik.
function parseTitik(input) {
    let arr = input;
    if (typeof arr === 'string') {
        try { arr = JSON.parse(arr); } catch { return null; }
    }
    if (!Array.isArray(arr) || arr.length < 2) return null;
    const out = [];
    for (const p of arr) {
        if (!Array.isArray(p) || p.length < 2) return null;
        const lat = Number(p[0]), lng = Number(p[1]);
        if (!isFinite(lat) || !isFinite(lng)) return null;
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
        out.push([lat, lng]);
    }
    return out;
}

router.use(authMiddleware);

// GET / — daftar semua kabel
router.get('/', async (req, res, next) => {
    try {
        const rows = await query('SELECT id, nama, tipe, titik, keterangan, created_at FROM kabel ORDER BY id');
        // titik dikirim sebagai array (sudah di-parse) agar frontend langsung pakai
        const data = rows.map(r => {
            let titik = [];
            try { titik = JSON.parse(r.titik); } catch { titik = []; }
            return { id: r.id, nama: r.nama, tipe: r.tipe, titik, keterangan: r.keterangan, created_at: r.created_at };
        });
        res.json(data);
    } catch (e) { next(e); }
});

// POST / — buat kabel baru  { nama, tipe, titik:[[lat,lng],...], keterangan? }
router.post('/', requireAdmin, async (req, res, next) => {
    try {
        const { nama, tipe, titik, keterangan } = req.body || {};
        if (!nama || !String(nama).trim()) return res.status(400).json({ error: 'Nama kabel wajib diisi' });
        const t = TIPE_VALID.includes(tipe) ? tipe : 'distribusi';
        const pts = parseTitik(titik);
        if (!pts) return res.status(400).json({ error: 'Titik tidak valid (minimal 2 titik koordinat)' });
        const r = await query(
            'INSERT INTO kabel (nama, tipe, titik, keterangan, dibuat_oleh) VALUES (?,?,?,?,?)',
            [String(nama).trim().slice(0, 100), t, JSON.stringify(pts),
             keterangan ? String(keterangan).slice(0, 255) : null,
             req.admin?.username || null]
        );
        res.json({ ok: true, id: r.insertId });
    } catch (e) { next(e); }
});

// PUT /:id — ubah kabel (nama/tipe/titik/keterangan)
router.put('/:id', requireAdmin, async (req, res, next) => {
    try {
        const row = await queryOne('SELECT id FROM kabel WHERE id = ?', [req.params.id]);
        if (!row) return res.status(404).json({ error: 'Kabel tidak ditemukan' });
        const { nama, tipe, titik, keterangan } = req.body || {};
        const sets = [], params = [];
        if (nama !== undefined)       { sets.push('nama = ?');       params.push(String(nama).trim().slice(0, 100)); }
        if (tipe !== undefined)       { sets.push('tipe = ?');       params.push(TIPE_VALID.includes(tipe) ? tipe : 'distribusi'); }
        if (keterangan !== undefined) { sets.push('keterangan = ?'); params.push(keterangan ? String(keterangan).slice(0, 255) : null); }
        if (titik !== undefined) {
            const pts = parseTitik(titik);
            if (!pts) return res.status(400).json({ error: 'Titik tidak valid (minimal 2 titik)' });
            sets.push('titik = ?'); params.push(JSON.stringify(pts));
        }
        if (!sets.length) return res.json({ ok: true });
        params.push(req.params.id);
        await query(`UPDATE kabel SET ${sets.join(', ')} WHERE id = ?`, params);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

// DELETE /:id — hapus kabel
router.delete('/:id', requireAdmin, async (req, res, next) => {
    try {
        await query('DELETE FROM kabel WHERE id = ?', [req.params.id]);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

module.exports = router;
