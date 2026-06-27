// routes/log.js — Log Admin & Audit Trail
const router = require('express').Router();
const { query, queryOne } = require('../config/db');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// Auto-create tabel admin_log jika belum ada
async function ensureTable() {
    await query(`
        CREATE TABLE IF NOT EXISTS admin_log (
            id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            waktu       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            kategori    VARCHAR(32) NOT NULL DEFAULT 'System',
            pelaku      VARCHAR(64) NOT NULL DEFAULT 'System',
            aksi        VARCHAR(64) NOT NULL,
            target      VARCHAR(128) NULL,
            detail      TEXT NULL,
            ip          VARCHAR(45) NULL,
            INDEX idx_waktu    (waktu),
            INDEX idx_kategori (kategori),
            INDEX idx_pelaku   (pelaku)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}
ensureTable().catch(e => console.warn('[log] Tabel admin_log:', e.message));

// ── GET /api/log — daftar log dengan filter ──────────────────
router.get('/', async (req, res, next) => {
    try {
        const { kategori, tanggal, q, limit = 200, offset = 0 } = req.query;
        const where = [];
        const params = [];

        if (kategori && kategori !== 'semua') {
            where.push('kategori = ?');
            params.push(kategori);
        }
        if (tanggal) {
            where.push('DATE(waktu) = ?');
            params.push(tanggal);
        }
        if (q) {
            where.push('(pelaku LIKE ? OR aksi LIKE ? OR target LIKE ? OR detail LIKE ?)');
            params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
        }

        const sql = `SELECT * FROM admin_log
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY waktu DESC
            LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), parseInt(offset));

        const [rows, countRow] = await Promise.all([
            query(sql, params),
            query(`SELECT COUNT(*) AS n FROM admin_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
                  params.slice(0, -2))
        ]);

        res.json({ rows, total: countRow[0]?.n || 0 });
    } catch(e) { next(e); }
});

// ── POST /api/log — tulis log (dipanggil dari service lain) ──
router.post('/', async (req, res, next) => {
    try {
        const { kategori='System', pelaku='System', aksi, target, detail, ip } = req.body;
        if (!aksi) return res.status(400).json({ error: 'aksi wajib diisi' });
        await query(
            `INSERT INTO admin_log (kategori, pelaku, aksi, target, detail, ip) VALUES (?,?,?,?,?,?)`,
            [kategori, pelaku, aksi, target || null, detail || null, ip || null]
        );
        res.json({ ok: true });
    } catch(e) { next(e); }
});

// ── DELETE /api/log/bersihkan — hapus log lama ───────────────
router.delete('/bersihkan', async (req, res, next) => {
    try {
        const { hari = 90 } = req.body;
        const result = await query(
            `DELETE FROM admin_log WHERE waktu < DATE_SUB(NOW(), INTERVAL ? DAY)`,
            [parseInt(hari)]
        );
        res.json({ pesan: `${result.affectedRows} log dihapus`, jumlah: result.affectedRows });
    } catch(e) { next(e); }
});

// ── GET /api/log/kategori — daftar kategori unik ─────────────
router.get('/kategori', async (req, res, next) => {
    try {
        const rows = await query(`SELECT DISTINCT kategori FROM admin_log ORDER BY kategori`);
        res.json(rows.map(r => r.kategori));
    } catch(e) { next(e); }
});

module.exports = { router };

// ── Helper: tulis log dari service lain ──────────────────────
async function tulisLog({ kategori='System', pelaku='System', aksi, target, detail, ip } = {}) {
    try {
        await ensureTable();
        await query(
            `INSERT INTO admin_log (kategori, pelaku, aksi, target, detail, ip) VALUES (?,?,?,?,?,?)`,
            [kategori, pelaku, aksi || 'UNKNOWN', target || null, detail || null, ip || null]
        );
    } catch(e) { /* non-blocking */ }
}
module.exports.tulisLog = tulisLog;
