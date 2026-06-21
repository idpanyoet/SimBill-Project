// routes/auth.js — Login admin
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { queryOne } = require('../config/db');

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
    try {
        const { query } = require('../config/db');
        const ident    = (req.body.email || req.body.username || '').trim();
        const password = req.body.password;
        if (!ident || !password)
            return res.status(400).json({ error: 'Email/username dan password wajib diisi' });

        // 1) Coba sebagai ADMIN (identitas = username ATAU email)
        const admin = await queryOne('SELECT * FROM admin WHERE (username = ? OR email = ?) AND aktif = 1', [ident, ident]);
        if (admin && await bcrypt.compare(password, admin.password)) {
            await query('UPDATE admin SET last_login = NOW() WHERE id = ?', [admin.id]);
            const token = jwt.sign(
                { id: admin.id, nama: admin.nama, username: admin.username, email: admin.email, role: admin.role },
                process.env.JWT_SECRET,
                { expiresIn: process.env.JWT_EXPIRES || '8h' }
            );
            const { tulisLog } = require('./log');
            const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || req.ip;
            tulisLog({ kategori:'Auth', pelaku: admin.nama || admin.email, aksi:'LOGIN',
                target: admin.nama, detail:'User logged in via Web UI', ip });
            return res.json({
                token, role: admin.role,
                admin: { id: admin.id, nama: admin.nama, username: admin.username, email: admin.email, role: admin.role }
            });
        }

        // 2) Coba sebagai RESELLER (identitas = username / no_hp / email)
        const r = await queryOne(
            "SELECT * FROM reseller WHERE (username=? OR no_hp=? OR email=?) AND status='aktif'",
            [ident, ident, ident]
        );
        if (r && await bcrypt.compare(password, r.password)) {
            await query('UPDATE reseller SET last_login = NOW() WHERE id = ?', [r.id]);
            const token = jwt.sign(
                { id: r.id, nama: r.nama, username: r.username, role: 'reseller', level: r.level },
                process.env.JWT_SECRET + '_reseller',
                { expiresIn: '12h' }
            );
            return res.json({
                token, role: 'reseller',
                reseller: { id: r.id, nama: r.nama, username: r.username, level: r.level, saldo: r.saldo, no_hp: r.no_hp }
            });
        }

        return res.status(401).json({ error: 'Email/username atau password salah' });
    } catch (e) { next(e); }
});

// POST /api/auth/ganti-password
const { authMiddleware } = require('../middleware/auth');
router.post('/ganti-password', authMiddleware, async (req, res, next) => {
    try {
        const { password_lama, password_baru } = req.body;
        const { query } = require('../config/db');

        const admin = await queryOne('SELECT * FROM admin WHERE id = ?', [req.admin.id]);
        const valid = await bcrypt.compare(password_lama, admin.password);
        if (!valid) return res.status(400).json({ error: 'Password lama salah' });

        const hash = await bcrypt.hash(password_baru, 12);
        await query('UPDATE admin SET password = ? WHERE id = ?', [hash, req.admin.id]);
        res.json({ pesan: 'Password berhasil diubah' });
    } catch (e) { next(e); }
});

module.exports = router;
