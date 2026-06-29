// routes/pengguna.js — Manajemen Pengguna Admin
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const { query, queryOne } = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
const { tulisLog } = require('./log');

router.use(authMiddleware);

// Teknisi tidak boleh mengelola akun admin (cegah privilege escalation)
router.use((req, res, next) => {
    if (req.admin && req.admin.role === 'teknisi')
        return res.status(403).json({ error: 'Akses ditolak untuk peran teknisi' });
    next();
});

// Auto-migrate kolom username & no_hp jika belum ada
async function migrateAdminTable() {
    await query(`ALTER TABLE admin ADD COLUMN IF NOT EXISTS username VARCHAR(64) NULL UNIQUE`).catch(()=>{});
    await query(`ALTER TABLE admin ADD COLUMN IF NOT EXISTS no_hp VARCHAR(20) NULL`).catch(()=>{});
    await query(`ALTER TABLE admin ADD COLUMN IF NOT EXISTS updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP`).catch(()=>{});
    // Tambah peran 'teknisi' ke ENUM role (idempotent)
    await query(`ALTER TABLE admin MODIFY COLUMN role ENUM('superadmin','admin','operator','teknisi') NOT NULL DEFAULT 'operator'`).catch(()=>{});
    // Email jadi opsional (login utama pakai username)
    await query(`ALTER TABLE admin MODIFY COLUMN email VARCHAR(150) NULL`).catch(()=>{});
    // Set username default = email prefix untuk yang belum punya
    await query(`UPDATE admin SET username = SUBSTRING_INDEX(email,'@',1) WHERE username IS NULL`).catch(()=>{});
}
migrateAdminTable().catch(e => console.warn('[pengguna] migrate:', e.message));

// GET /api/pengguna — daftar pengguna admin
router.get('/', async (req, res, next) => {
    try {
        const { q, role, limit = 50, offset = 0 } = req.query;
        const where = [];
        const params = [];
        if (q) {
            where.push('(username LIKE ? OR nama LIKE ? OR email LIKE ?)');
            params.push(`%${q}%`, `%${q}%`, `%${q}%`);
        }
        if (role && role !== 'semua') {
            where.push('role = ?');
            params.push(role);
        }
        const rows = await query(`
            SELECT id, username, nama, email, no_hp, role, aktif, last_login,
                   created_at, updated_at
            FROM admin
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `, [...params, parseInt(limit), parseInt(offset)]);
        const [countRow] = await query(
            `SELECT COUNT(*) AS n FROM admin ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
            params
        );
        res.json({ rows, total: countRow.n });
    } catch(e) { next(e); }
});

// POST /api/pengguna — tambah pengguna
router.post('/', async (req, res, next) => {
    try {
        const { username, nama, email, password, no_hp, role = 'operator' } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username & password wajib diisi' });
        const dupU = await queryOne('SELECT id FROM admin WHERE username=?', [username]);
        if (dupU) return res.status(400).json({ error: 'Username sudah digunakan' });
        if (email) {
            const dupE = await queryOne('SELECT id FROM admin WHERE email=?', [email]);
            if (dupE) return res.status(400).json({ error: 'Email sudah digunakan' });
        }
        const hash = await bcrypt.hash(password, 12);
        const result = await query(
            `INSERT INTO admin (username, nama, email, password, no_hp, role) VALUES (?,?,?,?,?,?)`,
            [username, nama || username, email || null, hash, no_hp || null, role]
        );
        tulisLog({ kategori:'System', pelaku: req.admin?.nama||'Admin',
            aksi:'PENGGUNA_TAMBAH', target: username||email,
            detail:`Nama: ${nama}, Role: ${role}`,
            ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip });
        res.status(201).json({ pesan: 'Pengguna ditambahkan', id: result.insertId });
    } catch(e) { next(e); }
});

// PUT /api/pengguna/:id — update pengguna
router.put('/:id', async (req, res, next) => {
    try {
        const { username, nama, email, no_hp, role, aktif, password } = req.body;
        const p = await queryOne('SELECT * FROM admin WHERE id=?', [req.params.id]);
        if (!p) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
        let hash = p.password;
        if (password) hash = await bcrypt.hash(password, 12);
        await query(`
            UPDATE admin SET username=?, nama=?, email=?, no_hp=?, role=?, aktif=?, password=?, updated_at=NOW()
            WHERE id=?
        `, [username||p.username, nama||p.nama, email||p.email, no_hp||null, role||p.role, aktif!==undefined?aktif:p.aktif, hash, req.params.id]);
        tulisLog({ kategori:'System', pelaku: req.admin?.nama||'Admin',
            aksi:'PENGGUNA_UPDATE', target: p.username||p.email,
            detail:`Role: ${role||p.role}, Aktif: ${aktif!==undefined?aktif:p.aktif}`,
            ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip });
        res.json({ pesan: 'Pengguna diperbarui' });
    } catch(e) { next(e); }
});

// DELETE /api/pengguna/:id
router.delete('/:id', async (req, res, next) => {
    try {
        if (req.admin?.id == req.params.id) return res.status(400).json({ error: 'Tidak bisa hapus akun sendiri' });
        const p = await queryOne('SELECT * FROM admin WHERE id=?', [req.params.id]);
        if (!p) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
        await query('DELETE FROM admin WHERE id=?', [req.params.id]);
        tulisLog({ kategori:'System', pelaku: req.admin?.nama||'Admin',
            aksi:'PENGGUNA_HAPUS', target: p.username||p.email,
            detail:`Nama: ${p.nama}, Role: ${p.role}`,
            ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip });
        res.json({ pesan: 'Pengguna dihapus' });
    } catch(e) { next(e); }
});

// POST /api/pengguna/:id/toggle-aktif
router.post('/:id/toggle-aktif', async (req, res, next) => {
    try {
        const p = await queryOne('SELECT * FROM admin WHERE id=?', [req.params.id]);
        if (!p) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
        const newAktif = p.aktif ? 0 : 1;
        await query('UPDATE admin SET aktif=?, updated_at=NOW() WHERE id=?', [newAktif, req.params.id]);
        tulisLog({ kategori:'System', pelaku: req.admin?.nama||'Admin',
            aksi: newAktif ? 'PENGGUNA_AKTIF' : 'PENGGUNA_NONAKTIF',
            target: p.username||p.email, detail:`Nama: ${p.nama}`,
            ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip });
        res.json({ pesan: `Pengguna ${newAktif ? 'diaktifkan' : 'dinonaktifkan'}`, aktif: newAktif });
    } catch(e) { next(e); }
});

module.exports = router;
